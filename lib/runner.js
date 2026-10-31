/**
 * Evaluation loop: every (sample × model) pair is one task. Tasks run through
 * a bounded pool, each result is appended to `results/<model>.jsonl` as soon
 * as it is scored, so a cancelled or crashed run can be resumed by skipping
 * pairs already on disk.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildMessages } from './prompt.js'
import { autoScorer, references, answerLetter, scoreOutput } from './scorers.js'

export function resultFileName(modelId) {
  return `${String(modelId).replace(/[^\w.-]+/g, '_')}.jsonl`
}

export function pairKey(modelId, sampleId) {
  return `${modelId}\u0000${sampleId}`
}

/** Load results already written for a run (used by resume and reporting). */
export async function loadResults(runDir, modelIds) {
  const results = []
  for (const modelId of modelIds) {
    let raw = ''
    try { raw = await readFile(join(runDir, 'results', resultFileName(modelId)), 'utf8') } catch { continue }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const item = JSON.parse(line)
        if (item?.model === modelId) results.push(item)
      } catch { /* torn last line after a crash */ }
    }
  }
  // Keep the last record for each pair (a resumed run may retry an errored pair).
  const byPair = new Map()
  for (const item of results) byPair.set(pairKey(item.model, item.sampleId), item)
  return [...byPair.values()]
}

/**
 * @param {object} options
 * @param {string} options.runDir
 * @param {object[]} options.samples
 * @param {{ spec: object, llm: object }[]} options.models
 * @param {string} options.scorer scorer name or 'auto'
 * @param {number} [options.threshold]
 * @param {string} [options.template]
 * @param {string} [options.systemPrompt]
 * @param {number} [options.concurrency]
 * @param {Set<string>} [options.skip] pair keys already done
 * @param {AbortSignal} [options.signal]
 * @param {(result: object) => void} [options.onResult]
 */
export async function runEval(options) {
  const { runDir, samples, models, signal } = options
  const concurrency = Math.max(1, Math.min(64, Number(options.concurrency ?? 4)))
  const skip = options.skip ?? new Set()
  await mkdir(join(runDir, 'results'), { recursive: true })

  const writers = new Map()
  const write = (modelId, record) => {
    const file = join(runDir, 'results', resultFileName(modelId))
    const previous = writers.get(file) ?? Promise.resolve()
    const next = previous.then(() => appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 }))
    writers.set(file, next.catch(() => {}))
    return next
  }

  // Sample-major order keeps models at the same progress if the run stops early.
  const tasks = []
  for (const sample of samples) {
    for (const model of models) {
      if (!skip.has(pairKey(model.spec.id, sample.id))) tasks.push({ sample, model })
    }
  }

  let cursor = 0
  async function worker() {
    while (cursor < tasks.length) {
      if (signal?.aborted) return
      const { sample, model } = tasks[cursor]
      cursor += 1
      const record = await evaluateOne(sample, model, options)
      if (record.error === 'aborted') return
      await write(model.spec.id, record)
      options.onResult?.(record)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length || 1) }, worker))
  await Promise.all(writers.values())
  return { attempted: cursor, planned: tasks.length }
}

async function evaluateOne(sample, model, options) {
  const scorer = options.scorer && options.scorer !== 'auto' ? options.scorer : autoScorer(sample)
  const base = {
    sampleId: sample.id,
    model: model.spec.id,
    ...(sample.category ? { category: sample.category } : {}),
    scorer,
    expected: scorer === 'choice' ? answerLetter(sample) : references(sample).join(' | '),
  }
  const messages = buildMessages(sample, { template: options.template, systemPrompt: options.systemPrompt })
  let reply
  try {
    reply = await model.llm.chat(messages, { signal: options.signal })
  } catch (error) {
    if (error?.code === 'aborted') return { ...base, error: 'aborted' }
    return {
      ...base,
      score: 0,
      pass: false,
      error: error?.code ?? 'error',
      errorMessage: String(error?.message ?? error).slice(0, 300),
      at: new Date().toISOString(),
    }
  }
  let scored
  try {
    scored = scoreOutput(scorer, reply.text, sample, { threshold: options.threshold })
  } catch (error) {
    scored = { score: 0, pass: false, error: 'scorer-error', errorMessage: String(error?.message ?? error) }
  }
  return {
    ...base,
    score: scored.score,
    pass: scored.pass,
    ...(scored.extracted !== undefined ? { extracted: scored.extracted } : {}),
    ...(scored.error ? { scoreError: scored.error } : {}),
    output: reply.text,
    ...(reply.reasoning ? { reasoningChars: reply.reasoning.length } : {}),
    finishReason: reply.finishReason,
    latencyMs: reply.latencyMs,
    attempts: reply.attempts,
    usage: reply.usage ? {
      prompt: reply.usage.prompt_tokens ?? 0,
      completion: reply.usage.completion_tokens ?? 0,
    } : null,
    at: new Date().toISOString(),
  }
}

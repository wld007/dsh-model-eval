/**
 * Run registry shared by the agent tools, the /eval command and (later) the
 * GUI page. One evaluation runs at a time.
 *
 * Layout under the output root (default `<workspace>/.model-eval`):
 *   index.json                    recent runs
 *   runs/<runId>/run.json         run record (config, progress, status)
 *   runs/<runId>/results/*.jsonl  one line per (sample, model), with outputs
 *   runs/<runId>/report.json      run record + summary (no sample text)
 *   runs/<runId>/report.md        human-readable report
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { loadDataset } from './datasets.js'
import { createLlm } from './llm.js'
import { describeModel, normalizeModels } from './models.js'
import { buildMarkdown, summarize } from './report.js'
import { loadResults, pairKey, runEval } from './runner.js'
import { SCORERS } from './scorers.js'

export const SCORER_CHOICES = ['auto', ...SCORERS]

export function createService({ config = {}, defaultDirectory }) {
  const trustedHosts = Array.isArray(config.trustedHosts) ? config.trustedHosts.map(String) : []
  const registry = normalizeModels(config.models, trustedHosts)
  const settings = {
    models: registry.models,
    modelWarnings: registry.warnings,
    defaultModels: Array.isArray(config.defaultModels) ? config.defaultModels.map(String) : [],
    trustedHosts,
    outputRoot: String(config.outputRoot ?? ''),
    concurrency: clampInt(config.concurrency, 1, 64, 4),
    maxSamples: clampInt(config.maxSamples, 1, 1_000_000, 5000),
    timeoutMs: clampInt(config.timeoutMs, 1000, 3_600_000, 120000),
    temperature: Number(config.temperature ?? 0),
    maxTokens: clampInt(config.maxTokens, 1, 1_000_000, 1024),
    retries: clampInt(config.retries, 0, 10, 2),
    disableThinking: config.disableThinking === true,
    threshold: Number(config.threshold ?? 0.5),
    localOnly: config.localOnly === true,
  }

  const runs = new Map()
  let lastRunId = null
  let active = null

  function outputRoot() {
    const value = settings.outputRoot.trim()
    if (!value) return join(defaultDirectory, '.model-eval')
    const expanded = value.startsWith('~/') ? join(process.env.HOME ?? defaultDirectory, value.slice(2)) : value
    return isAbsolute(expanded) ? expanded : resolve(defaultDirectory, expanded)
  }

  function resolvePath(path) {
    const value = String(path ?? '').trim()
    const expanded = value.startsWith('~/') ? join(process.env.HOME ?? defaultDirectory, value.slice(2)) : value
    return isAbsolute(expanded) ? expanded : resolve(defaultDirectory, expanded)
  }

  function selectModels(requested) {
    if (settings.models.length === 0) {
      throw new Error('还没有配置任何模型。请在插件设置（profile 的 cordis.patch.yml 中 model-eval 的 config.models）里添加，例如 { id: local-qwen, baseURL: http://127.0.0.1:11434/v1, model: qwen2.5:7b }')
    }
    let ids = Array.isArray(requested) ? requested : String(requested ?? '').split(/[,，\s]+/)
    ids = ids.map((id) => String(id).trim()).filter(Boolean)
    if (ids.length === 0) ids = settings.defaultModels.length > 0 ? settings.defaultModels : settings.models.map((m) => m.id)
    const unknown = ids.filter((id) => !settings.models.some((m) => m.id === id))
    if (unknown.length > 0) {
      throw new Error(`未配置的模型: ${unknown.join('、')}。可用模型: ${settings.models.map((m) => m.id).join('、')}`)
    }
    return [...new Set(ids)].map((id) => settings.models.find((m) => m.id === id))
  }

  function makeLlm(spec) {
    return createLlm({
      baseURL: spec.baseURL,
      model: spec.model,
      apiKey: spec.apiKey,
      timeoutMs: settings.timeoutMs,
      temperature: spec.temperature ?? settings.temperature,
      maxTokens: spec.maxTokens ?? settings.maxTokens,
      disableThinking: spec.disableThinking ?? settings.disableThinking,
      retries: settings.retries,
    })
  }

  async function start(request = {}) {
    if (active) throw new Error(`评测批次 ${active.runId} 正在运行，请等待完成或先取消`)
    if (request.resumeRunId) return resume(String(request.resumeRunId), request)

    const datasetPath = resolvePath(request.dataset)
    if (!String(request.dataset ?? '').trim()) throw new Error('缺少数据集路径 dataset')
    const scorer = String(request.scorer ?? 'auto')
    if (!SCORER_CHOICES.includes(scorer)) throw new Error(`未知评分器 ${scorer}，可选: ${SCORER_CHOICES.join(' / ')}`)
    const threshold = request.threshold === undefined ? settings.threshold : Number(request.threshold)
    if (!(threshold >= 0 && threshold <= 1)) throw new Error('threshold 必须在 0–1 之间')
    const template = request.template ? String(request.template) : ''
    const systemPrompt = request.systemPrompt ? String(request.systemPrompt) : ''
    if (template.length > 20000 || systemPrompt.length > 20000) throw new Error('模板或系统提示过长（上限 20000 字符）')
    const limit = request.limit === undefined || request.limit === null || request.limit === '' ? undefined : clampInt(request.limit, 1, settings.maxSamples, settings.maxSamples)
    const sensitive = request.sensitive === true || settings.localOnly
    const specs = selectModels(request.models)
    assertLocality(specs, sensitive)

    const dataset = await loadDataset(datasetPath, { limit, maxSamples: settings.maxSamples })
    const runId = newRunId()
    const runDir = join(outputRoot(), 'runs', runId)
    await mkdir(runDir, { recursive: true })
    const run = {
      id: runId,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      runDir,
      dataset: { path: datasetPath, name: dataset.name, format: dataset.format, samples: dataset.samples.length, totalSamples: dataset.totalSamples },
      config: {
        models: specs.map(describeModel),
        scorer,
        threshold,
        template,
        systemPrompt,
        limit: limit ?? null,
        sensitive,
        concurrency: clampInt(request.concurrency, 1, 64, settings.concurrency),
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
      },
      warnings: dataset.warnings.slice(0, 20),
      progress: { planned: dataset.samples.length * specs.length, done: 0, errors: 0 },
    }
    return launch(run, specs, dataset.samples, [])
  }

  async function resume(runId, request) {
    const previous = await readRun(runId)
    if (!previous) throw new Error(`找不到批次 ${runId}（输出根目录 ${outputRoot()}）`)
    if (previous.status === 'running' && runs.get(runId)?.status === 'running') throw new Error(`批次 ${runId} 仍在运行`)
    const specs = selectModels(previous.config.models.map((m) => m.id))
    assertLocality(specs, previous.config.sensitive === true || settings.localOnly)
    const dataset = await loadDataset(previous.dataset.path, { limit: previous.config.limit ?? undefined, maxSamples: settings.maxSamples })
    const existing = (await loadResults(previous.runDir, specs.map((s) => s.id))).filter((r) => !r.error)
    const run = {
      ...previous,
      status: 'running',
      finishedAt: null,
      error: undefined,
      resumedFrom: previous.status,
      resumeCount: (previous.resumeCount ?? 0) + 1,
      config: { ...previous.config, concurrency: clampInt(request.concurrency, 1, 64, previous.config.concurrency ?? settings.concurrency) },
      dataset: { ...previous.dataset, samples: dataset.samples.length, totalSamples: dataset.totalSamples },
      warnings: dataset.warnings.slice(0, 20),
      progress: { planned: dataset.samples.length * specs.length, done: existing.length, errors: 0 },
    }
    delete run.summary
    return launch(run, specs, dataset.samples, existing)
  }

  async function launch(run, specs, samples, existing) {
    const controller = new AbortController()
    active = { runId: run.id, controller }
    lastRunId = run.id
    const state = { run, results: [...existing], samples }
    runs.set(run.id, state)
    await writeJson(join(run.runDir, 'run.json'), run)
    await upsertIndex(run)

    const skip = new Set(existing.map((r) => pairKey(r.model, r.sampleId)))
    const task = runEval({
      runDir: run.runDir,
      samples,
      models: specs.map((spec) => ({ spec, llm: makeLlm(spec) })),
      scorer: run.config.scorer,
      threshold: run.config.threshold,
      template: run.config.template,
      systemPrompt: run.config.systemPrompt,
      concurrency: run.config.concurrency,
      skip,
      signal: controller.signal,
      onResult: (record) => {
        state.results.push(record)
        run.progress.done += 1
        if (record.error) run.progress.errors += 1
      },
    }).then(() => {
      run.status = controller.signal.aborted ? 'cancelled' : 'completed'
    }).catch((error) => {
      run.status = 'failed'
      run.error = String(error?.message ?? error)
    }).then(() => finalize(state, specs)).catch((error) => {
      run.status = 'failed'
      run.error = `生成报告失败: ${String(error?.message ?? error)}`
    }).finally(() => {
      if (active?.runId === run.id) active = null
    })
    task.catch(() => {})
    state.task = task

    return {
      runId: run.id,
      resumed: Boolean(run.resumedFrom),
      dataset: run.dataset.path,
      samples: samples.length,
      models: specs.map((s) => s.id),
      scorer: run.config.scorer,
      sensitive: run.config.sensitive,
      planned: run.progress.planned,
      alreadyDone: existing.length,
      runDir: run.runDir,
      warnings: run.warnings,
    }
  }

  async function finalize(state, specs) {
    const { run } = state
    run.finishedAt = new Date().toISOString()
    // Results on disk are authoritative (they include earlier sessions of a resumed run).
    const results = await loadResults(run.runDir, specs.map((s) => s.id))
    state.results = results
    run.progress.done = results.length
    run.progress.errors = results.filter((r) => r.error).length
    const summary = summarize(results, { modelIds: specs.map((s) => s.id), planned: state.samples.length })
    run.summary = summary
    const samplesById = new Map(state.samples.map((s) => [s.id, s]))
    await writeJson(join(run.runDir, 'run.json'), run)
    await writeJson(join(run.runDir, 'report.json'), run)
    await writeFile(join(run.runDir, 'report.md'), buildMarkdown(run, summary, results, samplesById), { mode: 0o600 })
    await upsertIndex(run)
  }

  function assertLocality(specs, sensitive) {
    if (!sensitive) return
    const remote = specs.filter((s) => !s.local)
    if (remote.length > 0) {
      throw new Error(`敏感数据模式只允许本地/内网端点，以下模型不满足: ${remote.map((s) => `${s.id}（${s.baseURL}）`).join('、')}。如该域名属于内网，请加入设置中的 trustedHosts`)
    }
  }

  async function readRun(runId) {
    if (!/^[\w-]+$/.test(runId)) return null
    for (const name of ['report.json', 'run.json']) {
      try {
        return JSON.parse(await readFile(join(outputRoot(), 'runs', runId, name), 'utf8'))
      } catch { /* next */ }
    }
    return null
  }

  async function status(runId) {
    const id = String(runId ?? '').trim() || lastRunId || (await list()).runs[0]?.id
    if (!id) return { run: null, active: active?.runId ?? null }
    const state = runs.get(id)
    if (state) {
      const { run } = state
      const summary = run.summary ?? summarize(state.results, { modelIds: run.config.models.map((m) => m.id), planned: state.samples.length })
      return { run: { ...run, summary }, active: active?.runId ?? null }
    }
    return { run: await readRun(id), active: active?.runId ?? null }
  }

  async function report(runId) {
    const id = String(runId ?? '').trim() || lastRunId || (await list()).runs[0]?.id
    if (!id) throw new Error('还没有评测批次')
    if (runs.get(id)?.run.status === 'running') throw new Error(`批次 ${id} 仍在运行，完成或取消后才生成报告；可先用 eval_status 查看实时进度`)
    if (!/^[\w-]+$/.test(id)) throw new Error('批次 id 不合法')
    const path = join(outputRoot(), 'runs', id, 'report.md')
    const markdown = await readFile(path, 'utf8').catch(() => null)
    if (markdown === null) throw new Error(`找不到批次 ${id} 的报告: ${path}`)
    return { runId: id, markdown, path }
  }

  async function cancel(runId) {
    if (!active) return { cancelled: false, reason: '当前没有运行中的评测批次' }
    if (runId && active.runId !== runId) return { cancelled: false, reason: `正在运行的是 ${active.runId}，不是 ${runId}` }
    const id = active.runId
    active.controller.abort()
    return { cancelled: true, runId: id }
  }

  async function list() {
    let index = []
    try { index = JSON.parse(await readFile(join(outputRoot(), 'index.json'), 'utf8')) } catch { /* none yet */ }
    const merged = new Map((Array.isArray(index) ? index : []).map((item) => [item.id, item]))
    for (const [id, state] of runs) merged.set(id, indexEntry(state.run))
    return {
      outputRoot: outputRoot(),
      active: active?.runId ?? null,
      runs: [...merged.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, 30),
    }
  }

  async function upsertIndex(run) {
    const path = join(outputRoot(), 'index.json')
    let index = []
    try { index = JSON.parse(await readFile(path, 'utf8')) } catch { /* new */ }
    if (!Array.isArray(index)) index = []
    index = [indexEntry(run), ...index.filter((item) => item?.id !== run.id)].slice(0, 200)
    await writeJson(path, index)
  }

  function indexEntry(run) {
    return {
      id: run.id,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      dataset: run.dataset?.name ?? '',
      samples: run.dataset?.samples ?? 0,
      models: (run.config?.models ?? []).map((m) => m.id),
      scorer: run.config?.scorer ?? 'auto',
      sensitive: run.config?.sensitive === true,
      progress: run.progress,
      leaderboard: run.summary?.leaderboard?.map((row) => ({ id: row.id, meanScore: row.meanScore, accuracy: row.accuracy })) ?? [],
    }
  }

  function modelsInfo() {
    return {
      models: settings.models.map(describeModel),
      defaultModels: settings.defaultModels,
      warnings: settings.modelWarnings,
      localOnly: settings.localOnly,
      trustedHosts: settings.trustedHosts,
      scorers: SCORER_CHOICES,
      outputRoot: outputRoot(),
    }
  }

  async function ping(modelId) {
    const specs = modelId ? selectModels([modelId]) : settings.models
    const results = []
    for (const spec of specs) {
      try {
        const available = await makeLlm(spec).listModels()
        results.push({ id: spec.id, ok: true, served: available.includes(spec.model) || available.length === 0, available: available.slice(0, 50) })
      } catch (error) {
        results.push({ id: spec.id, ok: false, error: String(error?.message ?? error) })
      }
    }
    return { results }
  }

  /** Wait for the active run (tests and graceful shutdown). */
  async function idle() {
    const state = active ? runs.get(active.runId) : null
    await state?.task
  }

  return { start, status, report, cancel, list, modelsInfo, ping, idle, isRunning: () => Boolean(active), settings }
}

export function newRunId() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `eval-${stamp}-${randomBytes(2).toString('hex')}`
}

async function writeJson(path, value) {
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
  await rename(temp, path)
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (value === undefined || value === null || value === '' || !Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

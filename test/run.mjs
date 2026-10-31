/**
 * End-to-end: an in-process OpenAI-compatible mock serves several "models".
 *   good   answers every fixture correctly (from the record's _good field)
 *   bad    answers every fixture wrongly (_bad)
 *   flaky  returns HTTP 500 on the first call per question, then the good answer
 *   slow   good answers after 150 ms (used for cancel / resume)
 * A model pointed at a closed port covers network errors.
 */
import assert from 'node:assert/strict'
import { readFile, readdir, rm } from 'node:fs/promises'
import http from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'
import { isLocalEndpoint } from '../lib/models.js'
import { createService } from '../lib/service.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const tmp = join(here, '.tmp')
await rm(tmp, { recursive: true, force: true })
const fixture = (name) => join(here, 'fixtures', name)

const records = (await readFile(fixture('mixed.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
const flakySeen = new Set()
let calls = 0

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: ['good', 'bad', 'flaky', 'slow'].map((id) => ({ id })) }))
    return
  }
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', async () => {
    calls += 1
    const payload = JSON.parse(body)
    const user = payload.messages.filter((m) => m.role === 'user').at(-1).content
    const record = records.find((r) => user.includes(r.question))
    const reply = (text) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        model: payload.model,
        choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 5 },
      }))
    }
    if (!record) { res.writeHead(400).end('{"error":{"message":"unknown question"}}'); return }
    if (payload.model === 'bad') return reply(record._bad)
    if (payload.model === 'flaky' && !flakySeen.has(record.id)) {
      flakySeen.add(record.id)
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"overloaded"}}')
      return
    }
    if (payload.model === 'slow') await new Promise((r) => setTimeout(r, 150))
    reply(record._good)
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/v1`

const models = [
  { id: 'good', baseURL: base, model: 'good' },
  { id: 'bad', baseURL: base, model: 'bad' },
  { id: 'flaky', baseURL: base, model: 'flaky' },
  { id: 'slow', baseURL: base, model: 'slow' },
  { id: 'down', baseURL: 'http://127.0.0.1:1/v1', model: 'x' },
  { id: 'cloud', baseURL: 'https://api.example.com/v1', model: 'x', apiKey: 'sk-secret' },
]
const service = createService({ config: { models, outputRoot: join(tmp, 'out'), retries: 1, timeoutMs: 5000 }, defaultDirectory: here })

let passed = 0
async function test(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    console.error(`✗ ${name}`)
    throw error
  }
}

try {
  await test('locality check', () => {
    assert.equal(isLocalEndpoint('http://127.0.0.1:11434/v1'), true)
    assert.equal(isLocalEndpoint('http://localhost:8000'), true)
    assert.equal(isLocalEndpoint('http://192.168.1.20/v1'), true)
    assert.equal(isLocalEndpoint('http://172.20.0.1/v1'), true)
    assert.equal(isLocalEndpoint('http://172.40.0.1/v1'), false)
    assert.equal(isLocalEndpoint('http://[::1]:8000'), true)
    assert.equal(isLocalEndpoint('https://api.deepseek.com/v1'), false)
    assert.equal(isLocalEndpoint('https://llm.hospital.lan/v1', ['*.hospital.lan']), true)
  })

  await test('models info never leaks keys', () => {
    const info = service.modelsInfo()
    assert.equal(info.models.length, 6)
    assert.ok(!JSON.stringify(info).includes('sk-secret'))
    assert.equal(info.models.find((m) => m.id === 'cloud').local, false)
  })

  let mainRun
  await test('good vs bad: scores, leaderboard, report', async () => {
    const started = await service.start({ dataset: fixture('mixed.jsonl'), models: ['good', 'bad'] })
    assert.equal(started.planned, 12)
    await assert.rejects(service.start({ dataset: fixture('mixed.jsonl'), models: ['good'] }), /正在运行/)
    await service.idle()
    const { run } = await service.status(started.runId)
    mainRun = run
    assert.equal(run.status, 'completed')
    const good = run.summary.models.find((m) => m.id === 'good')
    const bad = run.summary.models.find((m) => m.id === 'bad')
    assert.equal(good.accuracy, 1, JSON.stringify(good))
    assert.equal(bad.accuracy, 0, JSON.stringify(bad))
    assert.deepEqual(good.scorers, { choice: 2, number: 2, exact: 2 })
    assert.equal(good.categories['数学'].n, 3)
    assert.equal(run.summary.leaderboard[0].id, 'good')
    assert.deepEqual(
      (({ shared, both, onlyA, onlyB, neither }) => ({ shared, both, onlyA, onlyB, neither }))(run.summary.pairwise[0]),
      { shared: 6, both: 0, onlyA: 6, onlyB: 0, neither: 0 },
    )
    const { markdown } = await service.report(started.runId)
    assert.match(markdown, /## 排行榜/)
    assert.match(markdown, /\| 1 \| good \| 100\.0%/)
    assert.match(markdown, /## 分类准确率/)
    assert.match(markdown, /## 两两对比/)
    assert.match(markdown, /中国的首都是哪里/) // failure examples include inputs when not sensitive
    const lines = (await readFile(join(run.runDir, 'results', 'good.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(lines.length, 6)
  })

  await test('auto-picked scorer can be forced', async () => {
    const started = await service.start({ dataset: fixture('mixed.jsonl'), models: ['good'], scorer: 'f1', limit: 3 })
    await service.idle()
    const { run } = await service.status(started.runId)
    assert.equal(run.summary.models[0].completed, 3)
    assert.deepEqual(run.summary.models[0].scorers, { f1: 3 })
  })

  await test('retries recover from 5xx', async () => {
    const started = await service.start({ dataset: fixture('mixed.jsonl'), models: ['flaky'] })
    await service.idle()
    const { run } = await service.status(started.runId)
    assert.equal(run.summary.models[0].accuracy, 1)
    const rows = (await readFile(join(run.runDir, 'results', 'flaky.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    assert.ok(rows.every((r) => r.attempts === 2))
  })

  await test('network errors are recorded, not fatal', async () => {
    const started = await service.start({ dataset: fixture('mixed.jsonl'), models: ['good', 'down'], limit: 2 })
    await service.idle()
    const { run } = await service.status(started.runId)
    assert.equal(run.status, 'completed')
    const down = run.summary.models.find((m) => m.id === 'down')
    assert.equal(down.errors, 2)
    assert.equal(down.errorCodes.network, 2)
    assert.equal(run.summary.pairwise[0].shared, 0)
    const { markdown } = await service.report(started.runId)
    assert.match(markdown, /## 调用错误/)
  })

  await test('sensitive mode: blocks remote endpoints, hides sample text', async () => {
    await assert.rejects(service.start({ dataset: fixture('mixed.jsonl'), models: ['good', 'cloud'], sensitive: true }), /敏感数据模式.*cloud/)
    const started = await service.start({ dataset: fixture('mixed.jsonl'), models: ['bad'], sensitive: true })
    await service.idle()
    const { markdown } = await service.report(started.runId)
    assert.ok(!markdown.includes('中国的首都'), 'report must not contain inputs')
    assert.ok(!markdown.includes('再见'), 'report must not contain outputs')
    assert.match(markdown, /`q1`/)
    const reportJson = await readFile(join(service.settings.outputRoot, 'runs', started.runId, 'report.json'), 'utf8')
    assert.ok(!reportJson.includes('中国的首都') && !reportJson.includes('再见'))

    const strict = createService({ config: { models, localOnly: true, outputRoot: join(tmp, 'strict') }, defaultDirectory: here })
    await assert.rejects(strict.start({ dataset: fixture('mixed.jsonl'), models: ['cloud'] }), /敏感数据模式/)
  })

  await test('validation errors', async () => {
    await assert.rejects(service.start({ dataset: fixture('mixed.jsonl'), models: ['nope'] }), /未配置的模型: nope/)
    await assert.rejects(service.start({ dataset: fixture('mixed.jsonl'), scorer: 'magic' }), /未知评分器/)
    await assert.rejects(service.start({ models: ['good'] }), /缺少数据集/)
    const empty = createService({ config: {}, defaultDirectory: here })
    await assert.rejects(empty.start({ dataset: fixture('mixed.jsonl') }), /还没有配置任何模型/)
    assert.equal(service.isRunning(), false)
  })

  await test('cancel then resume completes the run', async () => {
    const started = await service.start({ dataset: fixture('mixed.jsonl'), models: ['slow'], concurrency: 1 })
    await new Promise((r) => setTimeout(r, 380))
    const cancelled = await service.cancel()
    assert.equal(cancelled.cancelled, true)
    await service.idle()
    let { run } = await service.status(started.runId)
    assert.equal(run.status, 'cancelled')
    assert.ok(run.progress.done > 0 && run.progress.done < 6, `done=${run.progress.done}`)
    const { markdown } = await service.report(started.runId)
    assert.match(markdown, /已取消/)

    const before = calls
    const resumed = await service.start({ resumeRunId: started.runId })
    assert.equal(resumed.resumed, true)
    assert.equal(resumed.alreadyDone, run.progress.done)
    await service.idle()
    ;({ run } = await service.status(started.runId))
    assert.equal(run.status, 'completed')
    assert.equal(run.summary.models[0].completed, 6)
    assert.equal(run.summary.models[0].accuracy, 1)
    assert.equal(calls - before, 6 - resumed.alreadyDone, 'resume must only call missing pairs')
  })

  await test('list and reload from disk in a fresh service', async () => {
    const fresh = createService({ config: { models, outputRoot: join(tmp, 'out') }, defaultDirectory: here })
    const { runs } = await fresh.list()
    assert.equal(runs.length, 6)
    assert.ok(runs.some((r) => r.id === mainRun.id && r.leaderboard[0].id === 'good'))
    const { run } = await fresh.status(mainRun.id)
    assert.equal(run.summary.models.length, 2)
    const { markdown } = await fresh.report(mainRun.id)
    assert.match(markdown, /模型评测报告/)
    await assert.rejects(fresh.report('../../etc'), /不合法/)
  })

  await test('plugin registers tools and /eval command', async () => {
    const tools = new Map()
    let command
    const ctx = {
      get: (key) => (key === 'workingDirectory' ? { defaultDirectory: here } : undefined),
      tools: { register: (def) => tools.set(def.name, def) },
      inject: (deps, fn) => {
        if (deps.includes('commands')) fn({ commands: { register: (def) => { command = def; return () => {} } }, effect: () => {} })
      },
    }
    apply(ctx, { models: [{ id: 'good', baseURL: base, model: 'good' }], outputRoot: join(tmp, 'plugin') })
    assert.deepEqual([...tools.keys()].sort(), ['eval_cancel', 'eval_models', 'eval_report', 'eval_runs', 'eval_start', 'eval_status'])
    assert.deepEqual(tools.get('eval_start').parameters.properties.models, { type: 'array', description: tools.get('eval_start').parameters.properties.models.description, items: { type: 'string' } })

    const start = tools.get('eval_start')
    const value = await start.execute({ dataset: fixture('mixed.jsonl'), limit: 2 })
    assert.match(start.output.render({}, value)[0].text, /已启动评测批次/)
    // Wait for completion through the status tool.
    for (let i = 0; i < 50; i += 1) {
      const status = await tools.get('eval_status').execute({})
      if (status.run.status !== 'running') break
      await new Promise((r) => setTimeout(r, 50))
    }
    const status = await tools.get('eval_status').execute({})
    assert.equal(status.run.status, 'completed')
    assert.match(tools.get('eval_status').output.render({}, status)[0].text, /good: 平均分 100\.0%/)
    const report = await tools.get('eval_report').execute({})
    assert.match(tools.get('eval_report').output.render({}, report)[0].text, /排行榜/)
    assert.match(tools.get('eval_runs').output.render({}, await tools.get('eval_runs').execute({}))[0].text, /good 100\.0%/)
    const models = await tools.get('eval_models').execute({ check: true })
    assert.match(tools.get('eval_models').output.render({}, models)[0].text, /good: good .*连通/)

    assert.equal((await command.handler({ rawInput: '' })).kind, 'error')
    assert.match((await command.handler({ rawInput: `${fixture('mixed.jsonl')} --bogus` })).text, /未知参数/)
    const ok = await command.handler({ rawInput: `${fixture('mixed.jsonl')} --models good --scorer auto --limit 1` })
    assert.equal(ok.kind, 'success', ok.text)
    for (let i = 0; i < 50; i += 1) {
      const s = await tools.get('eval_status').execute({})
      if (s.run.status !== 'running') break
      await new Promise((r) => setTimeout(r, 50))
    }
  })

  const files = await readdir(join(tmp, 'out', 'runs'))
  assert.equal(files.length, 6)
  console.log(`run: ${passed} passed`)
} finally {
  server.close()
}

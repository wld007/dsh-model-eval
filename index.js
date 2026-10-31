/**
 * Host half of the model evaluation bundle.
 *
 * Registers six agent tools and one /eval command; both share the service.
 * Model endpoints and keys come only from the user's plugin settings: tools
 * select models by id and cannot point evaluation data anywhere new.
 */
import { createService, SCORER_CHOICES } from './lib/service.js'

export const name = 'model-eval'
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const workingDirectory = ctx.get('workingDirectory')
  const defaultDirectory = workingDirectory?.defaultDirectory ?? process.cwd()
  const service = createService({ config, defaultDirectory })

  ctx.tools.register(tool({
    name: 'eval_models',
    description: 'dsh-model-eval 插件：列出插件设置中已配置的待评测模型（id、端点、是否本地/内网），可选检测端点连通性。',
    parameters: {
      check: { type: 'boolean', description: '为 true 时请求各端点的 /models 检测连通性。' },
    },
    execute: async (args) => ({ ...service.modelsInfo(), ...(args.check ? { ping: (await service.ping()).results } : {}) }),
    render: (args, value) => {
      if (value.models.length === 0) return [{ type: 'text', text: '还没有配置模型。请在插件设置的 models 中添加（id / baseURL / model / apiKey 或 apiKeyEnv）。' }]
      const ping = new Map((value.ping ?? []).map((p) => [p.id, p]))
      const lines = value.models.map((m) => {
        const p = ping.get(m.id)
        const health = p ? (p.ok ? (p.served ? '，连通' : '，连通但端点未列出该模型') : `，不可用：${p.error}`) : ''
        return `- ${m.id}: ${m.model} @ ${m.baseURL}（${m.local ? '本地/内网' : '外部'}${m.hasApiKey ? '，有密钥' : ''}${health}）`
      })
      if (value.defaultModels.length) lines.push(`默认模型：${value.defaultModels.join('、')}`)
      if (value.localOnly) lines.push('已开启 localOnly：所有评测只允许本地/内网端点。')
      for (const warning of value.warnings) lines.push(`⚠️ ${warning}`)
      return [{ type: 'text', text: lines.join('\n') }]
    },
  }))

  ctx.tools.register(tool({
    name: 'eval_start',
    description: 'dsh-model-eval 插件：在数据集上评测一个或多个已配置模型并自动打分，立即返回批次 id。数据集支持 jsonl/json/csv/tsv，字段自动识别（question/input/prompt/messages、answer/reference/label、choices 或 A/B/C/D 列、category/subject）。评分器：auto（按样本自动选）、exact、includes、regex、choice（选择题）、number（数值题，支持 GSM8K 的 ####）、f1、rouge_l、bleu。sensitive=true 时只允许本地/内网端点，且报告与工具返回不含样本原文。',
    parameters: {
      dataset: { type: 'string', description: '数据集文件路径（绝对路径或相对当前工作区）。续跑时可省略。' },
      models: { type: 'array', items: { type: 'string' }, description: '要评测的模型 id（见 eval_models）；省略则用设置中的默认模型或全部模型。' },
      scorer: { type: 'string', enum: SCORER_CHOICES, description: '评分器，默认 auto。' },
      threshold: { type: 'number', description: 'f1 / rouge_l / bleu 判定为通过的分数阈值（0–1），默认取设置值 0.5。' },
      limit: { type: 'number', description: '只评测前 N 条样本（适合先小规模试跑）。' },
      template: { type: 'string', description: '用户消息模板，可用 {{input}}、{{choices}} 及原始记录中的任意字段，如 {{context}}。省略时用默认格式。' },
      systemPrompt: { type: 'string', description: '系统提示（覆盖样本自带的 system 字段）。' },
      sensitive: { type: 'boolean', description: '数据含病历等敏感信息时设为 true：只允许本地/内网模型，报告不含原文。' },
      concurrency: { type: 'number', description: '并发请求数，默认取设置值。' },
      resumeRunId: { type: 'string', description: '断点续跑：传入已取消/失败的批次 id，沿用其配置，只补跑未完成或出错的样本。' },
    },
    execute: async (args) => service.start(args),
    render: (args, value) => [{
      type: 'text',
      text: [
        `${value.resumed ? '已续跑' : '已启动'}评测批次 ${value.runId}：${value.samples} 条样本 × ${value.models.length} 个模型（${value.models.join('、')}），评分器 ${value.scorer}${value.sensitive ? '，敏感数据模式' : ''}。`,
        value.alreadyDone ? `已有 ${value.alreadyDone} 条结果，跳过。` : '',
        ...value.warnings.map((w) => `⚠️ ${w}`),
        '用 eval_status 查看进度，完成后用 eval_report 读取报告。',
      ].filter(Boolean).join('\n'),
    }],
  }))

  ctx.tools.register(tool({
    name: 'eval_status',
    description: '查看评测批次的状态、进度、排行榜与各模型指标（准确率、平均分、错误数、延迟、token）。省略 runId 时查看最近一批。',
    parameters: {
      runId: { type: 'string', description: '批次 id；省略则取最近一批。' },
    },
    execute: async (args) => {
      const { run, active } = await service.status(args.runId)
      if (!run) return { found: false, active }
      return {
        found: true,
        active,
        run: {
          id: run.id,
          status: run.status,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          dataset: run.dataset,
          config: { ...run.config, template: run.config?.template ? '(custom)' : '', systemPrompt: run.config?.systemPrompt ? '(custom)' : '' },
          progress: run.progress,
          runDir: run.runDir,
          warnings: run.warnings,
          ...(run.error ? { error: run.error } : {}),
          leaderboard: run.summary?.leaderboard ?? [],
          models: (run.summary?.models ?? []).map((m) => ({
            id: m.id, completed: m.completed, planned: m.planned, accuracy: m.accuracy, validAccuracy: m.validAccuracy,
            meanScore: m.meanScore, errors: m.errors, errorCodes: m.errorCodes, unparsed: m.unparsed, truncated: m.truncated,
            latency: m.latency, tokens: m.tokens,
          })),
        },
      }
    },
    render: (args, value) => {
      if (!value.found) return [{ type: 'text', text: '还没有评测批次。' }]
      const run = value.run
      const lines = [
        `批次 ${run.id}: ${run.status}，进度 ${run.progress?.done ?? 0}/${run.progress?.planned ?? 0}${run.progress?.errors ? `（错误 ${run.progress.errors}）` : ''}`,
        `数据集 ${run.dataset?.name}（${run.dataset?.samples} 条），评分器 ${run.config?.scorer}${run.config?.sensitive ? '，敏感数据模式' : ''}`,
      ]
      for (const m of run.models) {
        lines.push(`- ${m.id}: 平均分 ${pct(m.meanScore)}，准确率 ${pct(m.accuracy)}，完成 ${m.completed}/${m.planned}，错误 ${m.errors}，p50 ${m.latency.p50}ms`)
      }
      if (run.error) lines.push(`错误：${run.error}`)
      return [{ type: 'text', text: lines.join('\n') }]
    },
  }))

  ctx.tools.register(tool({
    name: 'eval_report',
    description: '读取评测批次的 Markdown 报告（排行榜、分类准确率、两两对比、调用错误、答错样本）。省略 runId 时取最近一批。',
    parameters: {
      runId: { type: 'string', description: '批次 id；省略则取最近一批。' },
    },
    execute: async (args) => service.report(args.runId),
    render: (args, value) => {
      const text = String(value.markdown ?? '')
      return [{ type: 'text', text: text.length > 8000 ? `${text.slice(0, 8000)}\n\n…（报告较长，完整内容见 ${value.path}）` : text }]
    },
  }))

  ctx.tools.register(tool({
    name: 'eval_runs',
    description: '列出最近的评测批次（时间、状态、数据集、模型、排行榜摘要）。',
    parameters: {},
    execute: async () => service.list(),
    render: (args, value) => {
      if (!value.runs.length) return [{ type: 'text', text: `还没有评测批次（输出目录 ${value.outputRoot}）。` }]
      return [{
        type: 'text',
        text: value.runs.map((run) => {
          const board = (run.leaderboard ?? []).map((row) => `${row.id} ${pct(row.meanScore)}`).join('，')
          return `${run.id}  ${run.status}  ${run.dataset}（${run.samples} 条）  ${board || run.models.join('、')}`
        }).join('\n'),
      }]
    },
  }))

  ctx.tools.register(tool({
    name: 'eval_cancel',
    description: '取消正在运行的评测批次。已完成的结果保留并生成报告，之后可用 eval_start 的 resumeRunId 续跑。',
    parameters: {
      runId: { type: 'string', description: '批次 id；省略则取消当前批次。' },
    },
    execute: async (args) => service.cancel(args.runId),
    render: (args, value) => [{
      type: 'text',
      text: value.cancelled ? `已请求取消批次 ${value.runId}，已完成的结果会保留并生成报告。` : `没有取消：${value.reason}`,
    }],
  }))

  ctx.inject(['commands'], (cmdCtx) => {
    const usage = '用法：/eval <数据集路径> [--models a,b] [--scorer auto|exact|includes|regex|choice|number|f1|rouge_l|bleu] [--limit N] [--sensitive]；续跑：/eval --resume <批次id>'
    const dispose = cmdCtx.commands.register({
      name: 'eval',
      description: '评测模型：/eval <数据集> [--models a,b] [--scorer 名称] [--limit N] [--sensitive] [--resume 批次id]',
      input: { hint: '数据集 [--models a,b] [--scorer 名称] [--limit N] [--sensitive] [--resume 批次id]' },
      handler: async (invocation) => {
        const tokens = String(invocation.rawInput ?? '').trim().split(/\s+/).filter(Boolean)
        const request = {}
        while (tokens.length > 0) {
          const token = tokens.shift()
          if (token === '--sensitive') { request.sensitive = true; continue }
          if (['--models', '--scorer', '--limit', '--resume', '--concurrency', '--threshold'].includes(token)) {
            const value = tokens.shift()
            if (!value) return { kind: 'error', text: `缺少 ${token} 的值。${usage}` }
            if (token === '--models') request.models = value.split(',')
            else if (token === '--scorer') request.scorer = value
            else if (token === '--resume') request.resumeRunId = value
            else if (token === '--limit') request.limit = Number(value)
            else if (token === '--concurrency') request.concurrency = Number(value)
            else request.threshold = Number(value)
            continue
          }
          if (token.startsWith('--')) return { kind: 'error', text: `未知参数 ${token}。${usage}` }
          if (request.dataset) return { kind: 'error', text: `只能指定一个数据集。${usage}` }
          request.dataset = token
        }
        if (!request.dataset && !request.resumeRunId) return { kind: 'error', text: usage }
        try {
          const info = await service.start(request)
          return {
            kind: 'success',
            text: `${info.resumed ? '已续跑' : '已启动'}评测批次 ${info.runId}：${info.samples} 条 × ${info.models.join('、')}，评分器 ${info.scorer}${info.sensitive ? '（敏感数据模式）' : ''}。用 eval_status 查看进度。`,
          }
        } catch (error) {
          return { kind: 'error', text: String(error?.message ?? error) }
        }
      },
    })
    cmdCtx.effect(() => dispose, 'model-eval: /eval command')
  })
}

function pct(value) {
  return `${((value ?? 0) * 100).toFixed(1)}%`
}

function tool(def) {
  return {
    name: def.name,
    description: def.description,
    parameters: toJsonSchema(def.parameters ?? {}),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: def.render ?? ((args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]),
    },
    execute: def.execute,
  }
}

function toJsonSchema(parameters) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(parameters)) {
    const property = { type: spec.type }
    if (spec.description) property.description = spec.description
    if (spec.enum) property.enum = spec.enum
    if (spec.items) property.items = spec.items
    properties[key] = property
    if (spec.required) required.push(key)
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}

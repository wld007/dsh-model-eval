/**
 * Aggregation and the Markdown report.
 *
 * Sensitive runs never put sample text (inputs, references, outputs) into
 * the summary or the report: those are what agent tools return, and the
 * agent's own model may be a cloud service. Full texts stay in the local
 * results/*.jsonl files.
 */
import { truncate } from './text.js'

/**
 * @param {object[]} results per-pair records
 * @param {{ modelIds: string[], planned: number }} scope
 */
export function summarize(results, { modelIds, planned }) {
  const models = modelIds.map((id) => {
    const rows = results.filter((r) => r.model === id)
    const errors = rows.filter((r) => r.error)
    const valid = rows.filter((r) => !r.error)
    const correct = rows.filter((r) => r.pass).length
    const latencies = valid.map((r) => r.latencyMs).filter(Number.isFinite).sort((a, b) => a - b)
    const tokens = valid.reduce((acc, r) => ({
      prompt: acc.prompt + (r.usage?.prompt ?? 0),
      completion: acc.completion + (r.usage?.completion ?? 0),
    }), { prompt: 0, completion: 0 })
    const errorCodes = {}
    for (const r of errors) errorCodes[r.error] = (errorCodes[r.error] ?? 0) + 1
    const categories = {}
    for (const r of rows) {
      if (!r.category) continue
      const bucket = (categories[r.category] ??= { n: 0, correct: 0, scoreSum: 0 })
      bucket.n += 1
      bucket.correct += r.pass ? 1 : 0
      bucket.scoreSum += r.score ?? 0
    }
    for (const bucket of Object.values(categories)) {
      bucket.accuracy = ratio(bucket.correct, bucket.n)
      bucket.meanScore = ratio(bucket.scoreSum, bucket.n)
      delete bucket.scoreSum
    }
    const scorers = {}
    for (const r of rows) scorers[r.scorer] = (scorers[r.scorer] ?? 0) + 1
    return {
      id,
      planned,
      completed: rows.length,
      errors: errors.length,
      errorCodes,
      correct,
      // Errors count as wrong; validAccuracy excludes them.
      accuracy: ratio(correct, rows.length),
      validAccuracy: ratio(valid.filter((r) => r.pass).length, valid.length),
      meanScore: ratio(rows.reduce((sum, r) => sum + (r.score ?? 0), 0), rows.length),
      unparsed: valid.filter((r) => r.extracted === null).length,
      truncated: valid.filter((r) => r.finishReason === 'length').length,
      latency: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), mean: ratio(latencies.reduce((a, b) => a + b, 0), latencies.length) },
      tokens,
      scorers,
      categories,
    }
  })
  const leaderboard = [...models]
    .sort((a, b) => b.meanScore - a.meanScore || b.accuracy - a.accuracy)
    .map((m, index) => ({ rank: index + 1, id: m.id, meanScore: m.meanScore, accuracy: m.accuracy, completed: m.completed, errors: m.errors }))
  return { models, leaderboard, pairwise: pairwise(results, modelIds) }
}

/** Head-to-head on samples both models answered without error. */
function pairwise(results, modelIds) {
  if (modelIds.length < 2) return []
  const byModel = new Map(modelIds.map((id) => [id, new Map()]))
  for (const r of results) if (!r.error) byModel.get(r.model)?.set(r.sampleId, r)
  const pairs = []
  for (let i = 0; i < modelIds.length; i += 1) {
    for (let j = i + 1; j < modelIds.length; j += 1) {
      const a = byModel.get(modelIds[i])
      const b = byModel.get(modelIds[j])
      const stats = { a: modelIds[i], b: modelIds[j], shared: 0, both: 0, onlyA: 0, onlyB: 0, neither: 0, aHigher: 0, bHigher: 0, tie: 0 }
      for (const [sampleId, ra] of a) {
        const rb = b.get(sampleId)
        if (!rb) continue
        stats.shared += 1
        if (ra.pass && rb.pass) stats.both += 1
        else if (ra.pass) stats.onlyA += 1
        else if (rb.pass) stats.onlyB += 1
        else stats.neither += 1
        if (ra.score > rb.score) stats.aHigher += 1
        else if (rb.score > ra.score) stats.bHigher += 1
        else stats.tie += 1
      }
      pairs.push(stats)
    }
  }
  return pairs
}

/**
 * @param {object} run run record (status, dataset, config …)
 * @param {object} summary output of summarize()
 * @param {object[]} results per-pair records
 * @param {Map<string, object>} samplesById for failure examples (ignored when sensitive)
 */
export function buildMarkdown(run, summary, results, samplesById = new Map()) {
  const sensitive = run.config?.sensitive === true
  const lines = []
  lines.push(`# 模型评测报告 ${run.id}`, '')
  lines.push('| 项目 | 值 |', '| --- | --- |')
  lines.push(`| 状态 | ${statusText(run.status)} |`)
  lines.push(`| 数据集 | ${cell(run.dataset?.path ?? '')}（${run.dataset?.samples ?? 0} 条${run.dataset?.totalSamples > run.dataset?.samples ? `，共 ${run.dataset.totalSamples} 条` : ''}） |`)
  lines.push(`| 模型 | ${(run.config?.models ?? []).map((m) => `${m.id}${m.local ? '（本地/内网）' : ''}`).join('、')} |`)
  lines.push(`| 评分器 | ${run.config?.scorer ?? 'auto'}${run.config?.threshold !== undefined ? `（连续分阈值 ${run.config.threshold}）` : ''} |`)
  lines.push(`| 敏感数据模式 | ${sensitive ? '是（仅本地/内网端点；报告不含样本原文）' : '否'} |`)
  lines.push(`| 开始 / 结束 | ${localTime(run.startedAt)} / ${localTime(run.finishedAt)} |`)
  if (run.resumedFrom) lines.push(`| 断点续跑 | 第 ${run.resumeCount ?? 1} 次续跑 |`)
  lines.push('')
  if (run.error) lines.push(`> 错误：${run.error}`, '')
  for (const warning of run.warnings ?? []) lines.push(`> ⚠️ ${warning}`)
  if ((run.warnings ?? []).length > 0) lines.push('')

  lines.push('## 排行榜', '')
  lines.push('| 排名 | 模型 | 平均分 | 准确率 | 有效准确率 | 完成 | 错误 | 未解析 | 截断 | 延迟 p50 / p95 | Token 入 / 出 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  const byId = new Map(summary.models.map((m) => [m.id, m]))
  for (const row of summary.leaderboard) {
    const m = byId.get(row.id)
    lines.push(`| ${row.rank} | ${cell(m.id)} | ${pct(m.meanScore)} | ${pct(m.accuracy)} | ${pct(m.validAccuracy)} | ${m.completed}/${m.planned} | ${m.errors} | ${m.unparsed} | ${m.truncated} | ${ms(m.latency.p50)} / ${ms(m.latency.p95)} | ${m.tokens.prompt} / ${m.tokens.completion} |`)
  }
  lines.push('', '说明：准确率把调用错误计为答错；有效准确率不计调用错误；「未解析」指选择题/数值题没能从输出中提取答案；「截断」指因 max_tokens 截断。', '')

  const categories = [...new Set(summary.models.flatMap((m) => Object.keys(m.categories)))].sort()
  if (categories.length > 1) {
    lines.push('## 分类准确率', '')
    lines.push(`| 分类 | 样本 | ${summary.models.map((m) => cell(m.id)).join(' | ')} |`)
    lines.push(`| --- | --- | ${summary.models.map(() => '---').join(' | ')} |`)
    for (const category of categories.slice(0, 80)) {
      const n = Math.max(...summary.models.map((m) => m.categories[category]?.n ?? 0))
      lines.push(`| ${cell(category)} | ${n} | ${summary.models.map((m) => (m.categories[category] ? pct(m.categories[category].accuracy) : '—')).join(' | ')} |`)
    }
    if (categories.length > 80) lines.push('', `…另有 ${categories.length - 80} 个分类，见 report.json`)
    lines.push('')
  }

  if (summary.pairwise.length > 0) {
    lines.push('## 两两对比', '', '只统计两个模型都成功返回的样本。', '')
    lines.push('| A | B | 共同样本 | 都对 | 仅 A 对 | 仅 B 对 | 都错 | A 分高 / B 分高 / 平 |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const p of summary.pairwise) {
      lines.push(`| ${cell(p.a)} | ${cell(p.b)} | ${p.shared} | ${p.both} | ${p.onlyA} | ${p.onlyB} | ${p.neither} | ${p.aHigher} / ${p.bHigher} / ${p.tie} |`)
    }
    lines.push('')
  }

  const erroring = summary.models.filter((m) => m.errors > 0)
  if (erroring.length > 0) {
    lines.push('## 调用错误', '')
    for (const m of erroring) {
      lines.push(`- ${m.id}：${Object.entries(m.errorCodes).map(([code, n]) => `${code} × ${n}`).join('，')}`)
      const sample = results.find((r) => r.model === m.id && r.error)
      // Endpoint error bodies can echo the prompt, so sensitive runs omit them.
      if (sample?.errorMessage && !sensitive) lines.push(`  - 例：${truncate(sample.errorMessage, 200)}`)
    }
    lines.push('')
  }

  lines.push('## 答错样本（每个模型最多 10 条）', '')
  if (sensitive) lines.push('敏感数据模式：只列样本 id，原文见本机 results/*.jsonl。', '')
  let any = false
  for (const m of summary.models) {
    const wrong = results.filter((r) => r.model === m.id && !r.pass && !r.error).slice(0, 10)
    if (wrong.length === 0) continue
    any = true
    lines.push(`### ${m.id}`, '')
    if (sensitive) {
      lines.push(wrong.map((r) => `\`${r.sampleId}\``).join('、'), '')
      continue
    }
    for (const r of wrong) {
      const sample = samplesById.get(r.sampleId)
      lines.push(`- **${cell(r.sampleId)}**（${r.scorer}，得分 ${r.score}）`)
      if (sample) lines.push(`  - 输入：${truncate(sample.input, 160)}`)
      lines.push(`  - 参考：${truncate(r.expected, 120)}${r.extracted !== undefined ? `；提取：${r.extracted ?? '（未解析）'}` : ''}`)
      lines.push(`  - 输出：${truncate(r.output, 200)}`)
    }
    lines.push('')
  }
  if (!any) lines.push('没有答错的样本。', '')
  lines.push('---', `完整逐条结果：${run.runDir}/results/`)
  return lines.join('\n')
}

function statusText(status) {
  return { running: '运行中', completed: '已完成', cancelled: '已取消', failed: '失败' }[status] ?? status
}

function localTime(iso) {
  if (!iso) return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleString('zh-CN', { hour12: false })
}

function ratio(a, b) {
  return b > 0 ? Math.round((a / b) * 10000) / 10000 : 0
}

function percentile(sorted, q) {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`
}

function ms(value) {
  if (!value) return '—'
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`
}

function cell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

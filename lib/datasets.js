/**
 * Dataset loading: .jsonl / .json / .csv / .tsv into normalized samples.
 *
 * Recognized fields (first match wins):
 *   id        id | qid | _id | uid                     (else row number)
 *   input     input | question | prompt | query | problem | text
 *             instruction (+ input as context, Alpaca style; answer from output)
 *   messages  messages: OpenAI chat array; a trailing assistant turn becomes the answer
 *   answer    answer | reference | references | target | expected | label | solution | output | gold
 *   choices   choices | options, or columns A, B, C, D … (MMLU / C-Eval style)
 *   category  category | subject | type | task | domain
 *   system    system | system_prompt
 *   scorer    per-sample scorer override
 */
import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { LETTERS } from './scorers.js'

const ID_KEYS = ['id', 'qid', '_id', 'uid']
const INPUT_KEYS = ['input', 'question', 'prompt', 'query', 'problem', 'text']
const ANSWER_KEYS = ['answer', 'reference', 'references', 'target', 'expected', 'label', 'solution', 'output', 'gold']
const CHOICE_KEYS = ['choices', 'options']
const CATEGORY_KEYS = ['category', 'subject', 'type', 'task', 'domain']
const SYSTEM_KEYS = ['system', 'system_prompt']

export const DATASET_EXTENSIONS = ['.jsonl', '.json', '.csv', '.tsv']
const MAX_BYTES = 200 * 1024 * 1024

/**
 * @param {string} path absolute dataset path
 * @param {{ limit?: number, maxSamples?: number }} [options]
 */
export async function loadDataset(path, options = {}) {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) throw new Error(`数据集文件不存在: ${path}`)
  if (info.size > MAX_BYTES) throw new Error(`数据集超过 ${MAX_BYTES / 1024 / 1024} MB，请拆分后再评测`)
  const ext = extname(path).toLowerCase()
  if (!DATASET_EXTENSIONS.includes(ext)) throw new Error(`不支持的数据集格式 ${ext}，支持 ${DATASET_EXTENSIONS.join(' / ')}`)
  const raw = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '')
  const warnings = []
  let records
  if (ext === '.jsonl') records = parseJsonl(raw, warnings)
  else if (ext === '.json') records = parseJson(raw)
  else records = parseDelimited(raw, ext === '.tsv' ? '\t' : ',')

  const samples = []
  const seen = new Set()
  for (let index = 0; index < records.length; index += 1) {
    const sample = normalizeRecord(records[index], index, warnings)
    if (!sample) continue
    if (seen.has(sample.id)) {
      const original = sample.id
      let n = 2
      while (seen.has(`${original}#${n}`)) n += 1
      sample.id = `${original}#${n}`
      if (warnings.length < 50) warnings.push(`样本 id 重复: ${original}，已改为 ${sample.id}`)
    }
    seen.add(sample.id)
    samples.push(sample)
  }
  const total = samples.length
  const cap = Math.min(...[options.limit, options.maxSamples].map(Number).filter((n) => Number.isInteger(n) && n > 0), Infinity)
  const selected = Number.isFinite(cap) ? samples.slice(0, cap) : samples
  if (selected.length < total) warnings.push(`数据集共 ${total} 条，本次只评测前 ${selected.length} 条`)
  if (selected.length === 0) throw new Error('数据集中没有可用样本（需要 input/question/prompt/messages 等字段）')
  return {
    path,
    name: basename(path),
    format: ext.slice(1),
    totalSamples: total,
    samples: selected,
    warnings,
  }
}

function parseJsonl(raw, warnings) {
  const records = []
  const lines = raw.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      if (warnings.length < 50) warnings.push(`第 ${i + 1} 行不是有效 JSON，已跳过`)
    }
  }
  return records
}

function parseJson(raw) {
  const parsed = JSON.parse(raw)
  if (Array.isArray(parsed)) return parsed
  for (const key of ['data', 'samples', 'items', 'examples', 'test', 'rows']) {
    if (Array.isArray(parsed?.[key])) return parsed[key]
  }
  throw new Error('JSON 数据集应为数组，或包含 data / samples / items / examples 数组')
}

/** RFC 4180 CSV (quoted fields, embedded newlines, doubled quotes). */
export function parseDelimited(raw, delimiter = ',') {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    if (quoted) {
      if (ch === '"') {
        if (raw[i + 1] === '"') { field += '"'; i += 1 } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"' && field === '') quoted = true
    else if (ch === delimiter) { row.push(field); field = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && raw[i + 1] === '\n') i += 1
      row.push(field)
      field = ''
      if (row.some((cell) => cell !== '')) rows.push(row)
      row = []
    } else field += ch
  }
  row.push(field)
  if (row.some((cell) => cell !== '')) rows.push(row)
  if (rows.length < 2) return []
  const header = rows[0].map((cell) => cell.trim())
  return rows.slice(1).map((cells) => {
    const record = {}
    header.forEach((key, index) => {
      if (key) record[key] = coerceCell(cells[index] ?? '')
    })
    return record
  })
}

function coerceCell(value) {
  const trimmed = value.trim()
  if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
    try { return JSON.parse(trimmed) } catch { /* plain text */ }
  }
  return value
}

function pick(record, keys) {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== '') return { key, value: record[key] }
    const upper = Object.keys(record).find((k) => k.toLowerCase() === key)
    if (upper && record[upper] !== undefined && record[upper] !== null && record[upper] !== '') return { key: upper, value: record[upper] }
  }
  return null
}

export function normalizeRecord(record, index, warnings = []) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    if (warnings.length < 50) warnings.push(`第 ${index + 1} 条不是对象，已跳过`)
    return null
  }
  const sample = { id: '', input: '', answer: undefined, raw: record }
  const id = pick(record, ID_KEYS)
  sample.id = id ? String(id.value) : String(index + 1)

  let usedAnswerKey = null
  if (Array.isArray(record.messages) && record.messages.length > 0) {
    const messages = record.messages
      .filter((m) => m && typeof m === 'object' && typeof m.role === 'string')
      .map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }))
    if (messages.at(-1)?.role === 'assistant') {
      const last = messages.pop()
      if (!pick(record, ANSWER_KEYS)) sample.answer = last.content
    }
    sample.messages = messages
    sample.input = messages.filter((m) => m.role === 'user').at(-1)?.content ?? ''
  } else if (record.instruction !== undefined && record.instruction !== '') {
    const context = record.input !== undefined && record.input !== '' ? `\n\n${record.input}` : ''
    sample.input = `${record.instruction}${context}`
    if (record.output !== undefined) {
      sample.answer = record.output
      usedAnswerKey = 'output'
    }
  } else {
    const input = pick(record, INPUT_KEYS)
    if (input) sample.input = typeof input.value === 'string' ? input.value : JSON.stringify(input.value)
  }
  if (!sample.input && !sample.messages) {
    if (warnings.length < 50) warnings.push(`第 ${index + 1} 条缺少输入字段，已跳过`)
    return null
  }

  if (sample.answer === undefined && !usedAnswerKey) {
    const answer = pick(record, ANSWER_KEYS)
    if (answer) sample.answer = answer.value
  }

  const choices = pick(record, CHOICE_KEYS)
  if (choices && Array.isArray(choices.value)) {
    sample.choices = choices.value.map((item) => (typeof item === 'string' ? item : item?.text ?? JSON.stringify(item)))
  } else if (choices && choices.value && typeof choices.value === 'object') {
    // {"A": "...", "B": "..."}
    const keys = Object.keys(choices.value).filter((k) => /^[A-Za-z]$/.test(k)).sort()
    if (keys.length >= 2) sample.choices = keys.map((k) => String(choices.value[k]))
  } else {
    const letterColumns = []
    for (const letter of LETTERS) {
      if (record[letter] === undefined || record[letter] === '') break
      letterColumns.push(String(record[letter]))
    }
    if (letterColumns.length >= 2) sample.choices = letterColumns
  }

  const category = pick(record, CATEGORY_KEYS)
  if (category && typeof category.value !== 'object') sample.category = String(category.value)
  const system = pick(record, SYSTEM_KEYS)
  if (system && typeof system.value === 'string') sample.system = system.value
  if (typeof record.scorer === 'string') sample.scorer = record.scorer
  return sample
}

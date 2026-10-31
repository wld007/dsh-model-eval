/**
 * Rule-based scorers. Each returns `{ score, pass, extracted? }` where score
 * is in [0, 1]. Samples may carry several references; the best match counts.
 *
 *   exact    normalized string equality
 *   includes reference appears inside the output
 *   regex    reference is a pattern ("/pat/flags" or bare pattern, case-insensitive)
 *   choice   multiple choice: option letter extracted from the output
 *   number   numeric answer (GSM8K "#### 42" references supported)
 *   f1       token-level F1 (CJK by character, others by word)
 *   rouge_l  ROUGE-L F-measure on the same tokens
 *   bleu     sentence BLEU-4 with add-one smoothing for n > 1
 */
import { normalize, stripReasoning, tokenize } from './text.js'

export const SCORERS = ['exact', 'includes', 'regex', 'choice', 'number', 'f1', 'rouge_l', 'bleu']
/** Scorers whose score is continuous; pass means score >= threshold. */
export const GRADED = new Set(['f1', 'rouge_l', 'bleu'])

export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** Choose a scorer for a sample when the run asks for `auto`. */
export function autoScorer(sample) {
  if (sample.scorer && SCORERS.includes(sample.scorer)) return sample.scorer
  if (Array.isArray(sample.choices) && sample.choices.length >= 2) return 'choice'
  const refs = references(sample)
  if (refs.length > 0 && refs.every((ref) => parseNumber(referenceNumberText(ref)) !== null)) return 'number'
  return 'exact'
}

export function references(sample) {
  const answer = sample.answer
  if (answer === undefined || answer === null || answer === '') return []
  return (Array.isArray(answer) ? answer : [answer]).map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
}

/**
 * @param {string} name scorer name
 * @param {string} output raw model output
 * @param {object} sample normalized sample
 * @param {{ threshold?: number }} [options]
 */
export function scoreOutput(name, output, sample, options = {}) {
  const threshold = Number(options.threshold ?? 0.5)
  const text = stripReasoning(output)
  if (name === 'choice') return scoreChoice(text, sample)
  const refs = references(sample)
  if (refs.length === 0) return { score: 0, pass: false, error: 'missing-reference' }

  if (name === 'number') {
    const predicted = extractPredictedNumber(text)
    let best = 0
    for (const ref of refs) {
      const expected = parseNumber(referenceNumberText(ref))
      if (expected !== null && predicted !== null && numbersEqual(predicted, expected)) best = 1
    }
    return { score: best, pass: best === 1, extracted: predicted === null ? null : String(predicted) }
  }

  let best = 0
  for (const ref of refs) {
    let value = 0
    switch (name) {
      case 'exact': value = normalize(text) === normalize(ref) ? 1 : 0; break
      case 'includes': value = normalize(ref) && normalize(text).includes(normalize(ref)) ? 1 : 0; break
      case 'regex': value = regexMatch(ref, text) ? 1 : 0; break
      case 'f1': value = tokenF1(text, ref); break
      case 'rouge_l': value = rougeL(text, ref); break
      case 'bleu': value = bleu(text, ref); break
      default: throw new Error(`未知评分器: ${name}`)
    }
    if (value > best) best = value
  }
  const pass = GRADED.has(name) ? best >= threshold : best === 1
  return { score: round(best), pass }
}

// ---------------------------------------------------------------- choice

/** Resolve a sample's correct option to a letter (letter, 0-based index, or option text). */
export function answerLetter(sample) {
  const choices = Array.isArray(sample.choices) ? sample.choices : []
  const raw = Array.isArray(sample.answer) ? sample.answer[0] : sample.answer
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw < Math.max(choices.length, 26)) return LETTERS[raw]
  const value = String(raw ?? '').normalize('NFKC').trim()
  const inRange = (letter) => choices.length === 0 || LETTERS.indexOf(letter) < choices.length
  if (/^[A-Za-z]$/.test(value) && inRange(value.toUpperCase())) return value.toUpperCase()
  const bracketed = value.match(/^[\(（\[]?([A-Za-z])[\)）\]]?[.、:：\s]/)
  if (bracketed) return bracketed[1].toUpperCase()
  if (/^\d+$/.test(value) && choices.length > 0 && Number(value) < choices.length) return LETTERS[Number(value)]
  const index = choices.findIndex((choice) => normalize(choice) === normalize(value))
  return index === -1 ? null : LETTERS[index]
}

export function extractChoice(text, choices = []) {
  const count = Math.min(Math.max(choices.length || 4, 2), 26)
  const allowed = LETTERS.slice(0, count)
  const value = String(text ?? '').normalize('NFKC')
  const letter = `([${allowed}${allowed.toLowerCase()}])`
  const notLetter = '(?![A-Za-z])'
  const patterns = [
    new RegExp(`(?:答案|正确答案|正确选项|最终答案|answer|correct answer|correct option|final answer)\\s*(?:应该|应|是|为|选|is|:|：|=)?\\s*(?:选项)?\\s*[\\(（\\[【]?\\s*${letter}${notLetter}`, 'i'),
    new RegExp(`(?:选择?|选项|option|choose)\\s*[\\(（\\[【]?\\s*${letter}${notLetter}`, 'i'),
    new RegExp(`^\\s*[\\(（\\[【]?${letter}[\\)）\\]】]?(?:[.。:：、,，\\s]|$)`),
    new RegExp(`[\\(（\\[【]${letter}[\\)）\\]】]`),
  ]
  for (const pattern of patterns) {
    const match = value.match(pattern)
    if (match) return match[1].toUpperCase()
  }
  // Exactly one option text quoted in the output.
  const hits = choices
    .map((choice, index) => ({ index, text: normalize(choice) }))
    .filter((item) => item.text.length >= 2 && normalize(value).includes(item.text))
  if (hits.length === 1) return LETTERS[hits[0].index]
  // Last resort: the only standalone allowed capital letter in a short reply.
  if (value.length <= 40) {
    const standalone = [...value.matchAll(new RegExp(`(?<![A-Za-z])([${allowed}])(?![A-Za-z])`, 'g'))].map((m) => m[1])
    const unique = [...new Set(standalone)]
    if (unique.length === 1) return unique[0]
  }
  return null
}

function scoreChoice(text, sample) {
  const expected = answerLetter(sample)
  if (!expected) return { score: 0, pass: false, error: 'missing-reference' }
  const extracted = extractChoice(text, sample.choices ?? [])
  const pass = extracted === expected
  return { score: pass ? 1 : 0, pass, extracted }
}

// ---------------------------------------------------------------- number

function referenceNumberText(ref) {
  const value = String(ref)
  const marker = value.lastIndexOf('####')
  return marker === -1 ? value : value.slice(marker + 4)
}

const NUMBER = /-?\d[\d,]*(?:\.\d+)?(?:\s*\/\s*\d+)?%?|-?\.\d+%?/g

export function parseNumber(text) {
  // Only a bare number counts ("42", "-3.5", "1,200", "3/4", "15%", "$18");
  // "2型糖尿病" or "42 apples" are text answers.
  const value = String(text ?? '').normalize('NFKC').trim().replace(/[$￥¥€£\s]/g, '').replace(/[.。]$/, '')
  if (!/^(?:-?\d[\d,]*(?:\.\d+)?(?:\/\d+)?|-?\.\d+)%?$/.test(value)) return null
  return toNumber(value)
}

function toNumber(raw) {
  let token = raw.replace(/,/g, '').replace(/\s/g, '')
  const percent = token.endsWith('%')
  if (percent) token = token.slice(0, -1)
  let number
  if (token.includes('/')) {
    const [a, b] = token.split('/').map(Number)
    number = b ? a / b : NaN
  } else {
    number = Number(token)
  }
  if (!Number.isFinite(number)) return null
  return percent ? number / 100 : number
}

export function extractPredictedNumber(text) {
  const value = String(text ?? '').normalize('NFKC')
  const marker = value.lastIndexOf('####')
  if (marker !== -1) {
    const first = value.slice(marker + 4).match(NUMBER)
    if (first) return toNumber(first[0])
  }
  const boxed = [...value.matchAll(/\\boxed\{([^{}]*)\}/g)]
  if (boxed.length > 0) {
    const inner = boxed.at(-1)[1].match(NUMBER)
    if (inner) return toNumber(inner[0])
  }
  const cue = [...value.matchAll(/(?:答案|最终答案|结果|answer|final answer|result)\s*(?:是|为|应为|is|:|：|=)?\s*[$￥¥]?\s*(-?\d[\d,]*(?:\.\d+)?(?:\s*\/\s*\d+)?%?)/gi)]
  if (cue.length > 0) return toNumber(cue.at(-1)[1])
  const all = value.match(NUMBER)
  return all ? toNumber(all.at(-1)) : null
}

function numbersEqual(a, b) {
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b))
}

// ---------------------------------------------------------------- regex

function regexMatch(ref, text) {
  const literal = String(ref).match(/^\/([\s\S]+)\/([a-z]*)$/)
  try {
    const pattern = literal ? new RegExp(literal[1], literal[2]) : new RegExp(String(ref), 'i')
    return pattern.test(text)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- overlap

export function tokenF1(prediction, reference) {
  const pred = tokenize(prediction)
  const ref = tokenize(reference)
  if (pred.length === 0 || ref.length === 0) return pred.length === ref.length ? 1 : 0
  const counts = new Map()
  for (const token of ref) counts.set(token, (counts.get(token) ?? 0) + 1)
  let common = 0
  for (const token of pred) {
    const left = counts.get(token) ?? 0
    if (left > 0) {
      common += 1
      counts.set(token, left - 1)
    }
  }
  if (common === 0) return 0
  const precision = common / pred.length
  const recall = common / ref.length
  return (2 * precision * recall) / (precision + recall)
}

export function rougeL(prediction, reference) {
  const pred = tokenize(prediction)
  const ref = tokenize(reference)
  if (pred.length === 0 || ref.length === 0) return pred.length === ref.length ? 1 : 0
  const lcs = lcsLength(pred, ref)
  if (lcs === 0) return 0
  const precision = lcs / pred.length
  const recall = lcs / ref.length
  return (2 * precision * recall) / (precision + recall)
}

function lcsLength(a, b) {
  let previous = new Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array(b.length + 1).fill(0)
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1])
    }
    previous = current
  }
  return previous[b.length]
}

export function bleu(prediction, reference, maxN = 4) {
  const pred = tokenize(prediction)
  const ref = tokenize(reference)
  if (pred.length === 0 || ref.length === 0) return 0
  let logSum = 0
  for (let n = 1; n <= maxN; n += 1) {
    const predGrams = ngrams(pred, n)
    const refGrams = ngrams(ref, n)
    let overlap = 0
    let total = 0
    for (const [gram, count] of predGrams) {
      total += count
      overlap += Math.min(count, refGrams.get(gram) ?? 0)
    }
    // Add-one smoothing for n > 1 keeps short sentences from collapsing to 0.
    const precision = n === 1 ? (total ? overlap / total : 0) : (overlap + 1) / (total + 1)
    if (precision === 0) return 0
    logSum += Math.log(precision) / maxN
  }
  const brevity = pred.length >= ref.length ? 1 : Math.exp(1 - ref.length / pred.length)
  return brevity * Math.exp(logSum)
}

function ngrams(tokens, n) {
  const map = new Map()
  for (let i = 0; i + n <= tokens.length; i += 1) {
    const gram = tokens.slice(i, i + n).join('\u0001')
    map.set(gram, (map.get(gram) ?? 0) + 1)
  }
  return map
}

function round(value) {
  return Math.round(value * 10000) / 10000
}

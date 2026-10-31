/**
 * Text helpers shared by the scorers: normalization, tokenization that works
 * for both Chinese (character tokens) and Latin scripts (word tokens), and
 * removal of hidden reasoning blocks emitted by thinking models.
 */

const EDGE_PUNCT = /^[\s"'`“”‘’「」『』《》〈〉()（）\[\]【】{}.,;:!?。，、；：！？…·\-—_*#]+|[\s"'`“”‘’「」『』《》〈〉()（）\[\]【】{}.,;:!?。，、；：！？…·\-—_*#]+$/g

/** Drop `<think>…</think>` style reasoning so it is never scored. */
export function stripReasoning(text) {
  let value = String(text ?? '')
  value = value.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '')
  // An unterminated block at the start means the model ran out of tokens
  // while thinking; whatever follows the last closing tag is the answer.
  const close = value.search(/<\/(?:think|thinking|reasoning)>/i)
  if (close !== -1) value = value.slice(value.indexOf('>', close) + 1)
  return value.trim()
}

/** Full-width → half-width, lowercase, collapse whitespace, trim edge punctuation. */
export function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(EDGE_PUNCT, '')
    .trim()
}

const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}'
const WORD_CHAR = `(?:(?![${CJK}])[\\p{L}\\p{N}])`
const TOKEN = new RegExp(`[${CJK}]|${WORD_CHAR}+(?:['.\\-]${WORD_CHAR}+)*`, 'gu')

/** CJK characters become single tokens; other scripts split into words. */
export function tokenize(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().match(TOKEN) ?? []
}

export function truncate(text, max = 200) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

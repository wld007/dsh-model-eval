/**
 * Turn a sample into chat messages.
 *
 * Template placeholders: {{input}}, {{choices}} (lettered option lines), and
 * any top-level field of the original record, e.g. {{context}}.
 */
import { LETTERS } from './scorers.js'

export const DEFAULT_CHOICE_SUFFIX = '请直接给出正确选项的字母。'

export function formatChoices(choices = []) {
  return choices.map((choice, index) => `${LETTERS[index]}. ${choice}`).join('\n')
}

export function renderTemplate(template, sample) {
  return String(template).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (whole, key) => {
    if (key === 'input') return sample.input ?? ''
    if (key === 'choices') return formatChoices(sample.choices ?? [])
    const value = sample.raw?.[key]
    if (value === undefined || value === null) return ''
    return typeof value === 'string' ? value : JSON.stringify(value)
  })
}

/**
 * @param {object} sample normalized sample
 * @param {{ template?: string, systemPrompt?: string }} [options]
 * @returns {{ role: string, content: string }[]}
 */
export function buildMessages(sample, options = {}) {
  const system = options.systemPrompt || sample.system || ''
  if (Array.isArray(sample.messages) && sample.messages.length > 0 && !options.template) {
    const hasSystem = sample.messages[0]?.role === 'system'
    return system && !hasSystem ? [{ role: 'system', content: system }, ...sample.messages] : [...sample.messages]
  }
  let user
  if (options.template) user = renderTemplate(options.template, sample)
  else if (Array.isArray(sample.choices) && sample.choices.length >= 2) {
    user = `${sample.input}\n\n${formatChoices(sample.choices)}\n\n${DEFAULT_CHOICE_SUFFIX}`
  } else user = sample.input
  return system ? [{ role: 'system', content: system }, { role: 'user', content: user }] : [{ role: 'user', content: user }]
}

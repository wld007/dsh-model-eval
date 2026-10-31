/**
 * Model registry from the plugin settings, plus the endpoint-locality check
 * used for sensitive datasets.
 *
 * Models are only ever taken from the user's settings: the agent picks them
 * by id and cannot introduce a new endpoint, so evaluation data goes only
 * where the user has explicitly configured.
 */
import { isIP } from 'node:net'

/**
 * @typedef {{ id: string, baseURL: string, model: string, apiKey: string,
 *   temperature?: number, maxTokens?: number, disableThinking?: boolean, local: boolean }} ModelSpec
 */

/** @returns {{ models: ModelSpec[], warnings: string[] }} */
export function normalizeModels(list, trustedHosts = []) {
  const models = []
  const warnings = []
  const seen = new Set()
  for (const [index, item] of (Array.isArray(list) ? list : []).entries()) {
    if (!item || typeof item !== 'object') continue
    const model = String(item.model ?? '').trim()
    const baseURL = String(item.baseURL ?? '').trim().replace(/\/+$/, '')
    const id = String(item.id ?? model).trim()
    if (!id || !model || !baseURL) {
      warnings.push(`models[${index}] 缺少 id / model / baseURL，已忽略`)
      continue
    }
    if (!/^https?:\/\/\S+$/i.test(baseURL)) {
      warnings.push(`模型 ${id} 的 baseURL 必须以 http:// 或 https:// 开头，已忽略`)
      continue
    }
    if (seen.has(id)) {
      warnings.push(`模型 id 重复: ${id}，只保留第一个`)
      continue
    }
    seen.add(id)
    let apiKey = String(item.apiKey ?? '')
    if (!apiKey && item.apiKeyEnv) apiKey = String(process.env[String(item.apiKeyEnv)] ?? '')
    const spec = { id, baseURL, model, apiKey, local: isLocalEndpoint(baseURL, trustedHosts) }
    if (item.temperature !== undefined) spec.temperature = Number(item.temperature)
    if (item.maxTokens !== undefined) spec.maxTokens = Number(item.maxTokens)
    if (item.disableThinking !== undefined) spec.disableThinking = item.disableThinking === true
    models.push(spec)
  }
  return { models, warnings }
}

/**
 * Loopback, RFC 1918 / link-local / ULA addresses, `localhost`, mDNS
 * `.local` names, and hosts the user lists in `trustedHosts` (internal
 * domains such as `llm.hospital.lan`; `*.example.org` matches subdomains).
 */
export function isLocalEndpoint(url, trustedHosts = []) {
  let host
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return false
  }
  for (const pattern of trustedHosts ?? []) {
    const value = String(pattern).trim().toLowerCase()
    if (!value) continue
    if (value.startsWith('*.') ? host.endsWith(value.slice(1)) : host === value) return true
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  const family = isIP(host)
  if (family === 4) {
    const [a, b] = host.split('.').map(Number)
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  if (family === 6) {
    if (host === '::1') return true
    if (host.startsWith('::ffff:')) return isLocalEndpoint(`http://${host.slice(7)}`)
    return /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)
  }
  return false
}

/** Public view: never includes the API key. */
export function describeModel(spec) {
  return { id: spec.id, model: spec.model, baseURL: spec.baseURL, local: spec.local, hasApiKey: Boolean(spec.apiKey) }
}

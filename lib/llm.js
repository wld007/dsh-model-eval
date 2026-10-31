/**
 * Minimal OpenAI-compatible chat client (DeepSeek, OpenAI, vLLM, Ollama,
 * LM Studio, SGLang …). Retries 408/429/5xx and network errors with backoff.
 */

export class LlmError extends Error {
  constructor(message, code = 'llm-error', status) {
    super(message)
    this.name = 'LlmError'
    this.code = code
    this.status = status
  }
}

/**
 * @param {{ baseURL: string, model: string, apiKey?: string, timeoutMs?: number,
 *   temperature?: number, maxTokens?: number, disableThinking?: boolean, retries?: number }} options
 */
export function createLlm(options) {
  const baseURL = String(options.baseURL ?? '').replace(/\/+$/, '')
  const model = String(options.model ?? '')
  const apiKey = String(options.apiKey ?? '')
  const timeoutMs = Number(options.timeoutMs ?? 120000)
  const temperature = Number(options.temperature ?? 0)
  const maxTokens = Number(options.maxTokens ?? 1024)
  const retries = Math.max(0, Number(options.retries ?? 2))
  const disableThinking = options.disableThinking === true

  async function post(path, body, signal) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${baseURL}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]),
      })
      const text = await response.text()
      let parsed = null
      try { parsed = text ? JSON.parse(text) : null } catch { /* keep raw */ }
      if (!response.ok) {
        const detail = parsed?.error?.message ?? parsed?.message ?? text.slice(0, 300)
        throw new LlmError(`模型端点返回 ${response.status}: ${detail}`, 'http-error', response.status)
      }
      return parsed
    } catch (error) {
      if (error instanceof LlmError) throw error
      if (signal?.aborted) throw new LlmError('已取消', 'aborted')
      if (error?.name === 'AbortError' || controller.signal.aborted) throw new LlmError(`模型请求超时（${timeoutMs} ms）`, 'timeout')
      throw new LlmError(`无法连接模型端点: ${error?.cause?.message ?? error?.message ?? String(error)}`, 'network')
    } finally {
      clearTimeout(timer)
    }
  }

  async function once(messages, signal) {
    const body = { model, messages, temperature, max_tokens: maxTokens, stream: false }
    if (disableThinking) body.chat_template_kwargs = { enable_thinking: false }
    const started = Date.now()
    let data
    try {
      data = await post('/chat/completions', body, signal)
    } catch (error) {
      if (error?.status === 400 && body.chat_template_kwargs) {
        delete body.chat_template_kwargs
        data = await post('/chat/completions', body, signal)
      } else throw error
    }
    const message = data?.choices?.[0]?.message ?? {}
    let text = message.content
    if (Array.isArray(text)) text = text.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('')
    text = typeof text === 'string' ? text : ''
    const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : ''
    if (!text.trim() && !reasoning) throw new LlmError('模型返回了空内容', 'empty-response')
    return {
      text,
      reasoning,
      finishReason: data?.choices?.[0]?.finish_reason ?? null,
      usage: data?.usage ?? null,
      latencyMs: Date.now() - started,
    }
  }

  /** Chat with retries; the returned attempts count includes the successful call. */
  async function chat(messages, { signal } = {}) {
    let lastError
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (signal?.aborted) throw new LlmError('已取消', 'aborted')
      try {
        const reply = await once(messages, signal)
        return { ...reply, attempts: attempt + 1 }
      } catch (error) {
        lastError = error
        if (error?.code === 'aborted') throw error
        const retriable = error?.code === 'network' || error?.code === 'timeout' || error?.code === 'empty-response'
          || error?.status === 408 || error?.status === 429 || (error?.status >= 500)
        if (!retriable || attempt === retries) break
        await sleep(Math.min(8000, 500 * 2 ** attempt), signal)
      }
    }
    throw lastError
  }

  async function listModels() {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 10000))
    try {
      const response = await fetch(`${baseURL}/models`, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
        signal: controller.signal,
      })
      if (!response.ok) throw new LlmError(`模型端点返回 ${response.status}`, 'http-error', response.status)
      const data = await response.json()
      return (data?.data ?? []).map((item) => item.id).filter(Boolean)
    } catch (error) {
      if (error instanceof LlmError) throw error
      throw new LlmError(`无法连接模型端点: ${error?.cause?.message ?? error?.message ?? String(error)}`, 'network')
    } finally {
      clearTimeout(timer)
    }
  }

  return { chat, listModels, baseURL, model }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

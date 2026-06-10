const OPENCODE_DEFAULT_CHAT_URL = 'https://opencode.ai/zen/v1/chat/completions'

export const MODEL_SOURCE_OPENCODE = 'opencode'
export const MODEL_SOURCE_CUSTOM = 'custom'

function trimTrailingSlashes(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

function stripKnownOpenAIEndpointSuffix(value) {
  return trimTrailingSlashes(value)
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/models$/i, '')
}

function stripKnownAnthropicEndpointSuffix(value) {
  return trimTrailingSlashes(value)
    .replace(/\/v1\/messages$/i, '')
    .replace(/\/messages$/i, '')
    .replace(/\/v1$/i, '')
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

export function prefixedModelId(source, upstreamId) {
  const cleanSource = String(source || '').trim().toLowerCase()
  const cleanId = String(upstreamId || '').trim().replace(/^\/+/, '')
  return cleanSource && cleanId ? `${cleanSource}/${cleanId}` : cleanId
}

export function parseGatewayModelId(modelId) {
  const value = String(modelId || '').trim()
  const separator = value.indexOf('/')
  const source = separator > 0 ? value.slice(0, separator).toLowerCase() : ''
  const upstreamId = separator > 0 ? value.slice(separator + 1).trim() : ''

  if ((source === MODEL_SOURCE_OPENCODE || source === MODEL_SOURCE_CUSTOM) && upstreamId) {
    return {
      id: value,
      source,
      upstreamId,
    }
  }

  const error = new Error(`Model "${value || 'unknown'}" is missing source prefix. Use "opencode/<model>" or "custom/<model>".`)
  error.code = 'MODEL_SOURCE_PREFIX_REQUIRED'
  error.model = value
  throw error
}

export function withUpstreamModel(body, parsedModel = parseGatewayModelId(body?.model)) {
  return {
    ...body,
    model: parsedModel.upstreamId,
  }
}

export function getOpencodeRequestConfig(config) {
  const opencode = config?.backend?.opencode || {}

  return {
    url: trimTrailingSlashes(opencode.baseUrl) || OPENCODE_DEFAULT_CHAT_URL,
    apiKey: String(opencode.upstreamApiKey || 'public').trim() || 'public',
  }
}

export function getCustomBackendConfig(config) {
  return config?.backend?.custom || {}
}

export function hasCustomServiceConfig(config) {
  const custom = getCustomBackendConfig(config)
  return Boolean(String(custom.baseUrl || '').trim() && String(custom.apiKey || '').trim())
}

export function listOpenAIRootCandidates(baseUrl) {
  const normalized = stripKnownOpenAIEndpointSuffix(baseUrl)
  if (!normalized) {
    return []
  }

  if (/\/v1$/i.test(normalized)) {
    const withoutV1 = normalized.replace(/\/v1$/i, '')
    return unique([normalized, withoutV1])
  }

  return unique([`${normalized}/v1`, normalized])
}

export function getCustomModelUrlCandidates(config) {
  const custom = getCustomBackendConfig(config)
  const roots = unique([
    ...listOpenAIRootCandidates(custom.resolvedBaseUrl),
    ...listOpenAIRootCandidates(custom.baseUrl),
  ])

  return roots.map(root => `${root}/models`)
}

export function getCustomChatUrlCandidates(config) {
  const custom = getCustomBackendConfig(config)
  const roots = unique([
    ...listOpenAIRootCandidates(custom.resolvedBaseUrl),
    ...listOpenAIRootCandidates(custom.baseUrl),
  ])

  return roots.map(root => `${root}/chat/completions`)
}

export function getCustomAnthropicMessageUrlCandidates(config) {
  const custom = getCustomBackendConfig(config)
  const roots = unique([
    ...listOpenAIRootCandidates(custom.resolvedBaseUrl),
    ...listOpenAIRootCandidates(custom.baseUrl),
  ])

  return roots.map(root => `${stripKnownAnthropicEndpointSuffix(root)}/v1/messages`).filter(Boolean)
}

export function getOpencodeAnthropicMessageUrlCandidates(config) {
  const opencode = getOpencodeRequestConfig(config)
  const openaiBase = stripKnownOpenAIEndpointSuffix(opencode.url)
  if (!openaiBase) return []

  const base = stripKnownAnthropicEndpointSuffix(openaiBase)
  return [`${base}/v1/messages`]
}

export function getActiveAnthropicMessageUrlCandidates(config, source = MODEL_SOURCE_OPENCODE) {
  return source === MODEL_SOURCE_CUSTOM
    ? getCustomAnthropicMessageUrlCandidates(config)
    : getOpencodeAnthropicMessageUrlCandidates(config)
}

export function rememberResolvedCustomRoot(config, root) {
  const normalized = stripKnownOpenAIEndpointSuffix(root)
  if (!normalized) {
    return
  }

  if (!config.backend) {
    config.backend = {}
  }

  if (!config.backend.custom || typeof config.backend.custom !== 'object') {
    config.backend.custom = {}
  }

  config.backend.custom.resolvedBaseUrl = normalized
}

export function extractRootFromUrl(url) {
  return stripKnownOpenAIEndpointSuffix(url)
}

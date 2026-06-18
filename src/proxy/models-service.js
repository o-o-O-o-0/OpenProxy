import { fetchFreeModels } from '../models.js'
import {
  MODEL_SOURCE_CUSTOM,
  MODEL_SOURCE_OPENCODE,
  extractRootFromUrl,
  getCustomBackendConfig,
  getCustomModelUrlCandidates,
  hasCustomServiceConfig,
  prefixedModelId,
  rememberResolvedCustomRoot,
} from './backend.js'

const CUSTOM_OPENAI_MODEL_FETCH_TIMEOUT_MS = 5000

function createModelFetchError(message, code, extra = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, extra)
  return error
}

function isTimeoutError(error) {
  if (!error) {
    return false
  }

  if (error.name === 'AbortError' || error.name === 'TimeoutError') {
    return true
  }

  return /timed out|timeout|aborted/i.test(String(error.message || ''))
}

function isNetworkError(error) {
  const message = `${error?.message || ''} ${error?.cause?.message || ''} ${error?.cause?.code || ''}`
  return /fetch failed|network|enotfound|econnrefused|econnreset|eai_again|certificate/i.test(message)
}

function normalizeModelEntry(model = {}, fallbackOwner = 'opencode', source = MODEL_SOURCE_OPENCODE) {
  const upstreamId = String(model.upstream_id || model.upstreamId || model.id || model.name || '').trim()
  const id = prefixedModelId(source, upstreamId)

  return {
    id,
    name: String(model.name || upstreamId).trim(),
    object: 'model',
    created: Number.isFinite(model.created) ? model.created : Math.floor(Date.now() / 1000),
    owned_by: String(model.owned_by || fallbackOwner),
    source,
    upstream_id: upstreamId,
    input_modalities: Array.isArray(model.input_modalities)
      ? model.input_modalities
      : Array.isArray(model.input)
        ? model.input
        : ['text'],
    reasoning: Boolean(model.reasoning),
    context_window: Number.isFinite(model.context_window)
      ? model.context_window
      : Number.isFinite(model.contextWindow)
        ? model.contextWindow
        : 128000,
    max_output_tokens: Number.isFinite(model.max_output_tokens)
      ? model.max_output_tokens
      : Number.isFinite(model.maxTokens)
        ? model.maxTokens
        : Number.isFinite(model.max_tokens)
          ? model.max_tokens
          : 32000,
    permissions: Array.isArray(model.permissions) ? model.permissions : [],
  }
}

function setModelCache(config, models) {
  if (!config.model || typeof config.model !== 'object') {
    config.model = {}
  }

  config.model.available = models.map(model => ({
    id: model.id,
    name: model.name,
    source: model.source,
    upstream_id: model.upstream_id,
    max_output_tokens: model.max_output_tokens,
    context_window: model.context_window,
  }))
}

async function fetchCustomServiceModels(config) {
  if (!hasCustomServiceConfig(config)) {
    return []
  }

  const apiKey = String(getCustomBackendConfig(config).apiKey || '').trim()
  const timeout = CUSTOM_OPENAI_MODEL_FETCH_TIMEOUT_MS
  let lastError = null

  for (const url of getCustomModelUrlCandidates(config)) {
    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(timeout),
      })

      if (!response.ok) {
        const errorText = String(await response.text()).trim()
        const message = errorText || response.statusText || `HTTP ${response.status}`
        const code = response.status === 401 || response.status === 403
          ? 'MODEL_FETCH_AUTH_ERROR'
          : response.status === 404
            ? 'MODEL_FETCH_NOT_FOUND'
            : 'MODEL_FETCH_HTTP_ERROR'
        throw createModelFetchError(`HTTP ${response.status}: ${message}`, code, {
          upstreamStatus: response.status,
        })
      }

      const payload = await response.json()
      const models = Array.isArray(payload?.data) ? payload.data : []
      const normalized = models
        .map(model => normalizeModelEntry(model, 'custom', MODEL_SOURCE_CUSTOM))
        .filter(model => model.upstream_id)

      rememberResolvedCustomRoot(config, extractRootFromUrl(url))
      return normalized
    } catch (error) {
      if (isTimeoutError(error)) {
        lastError = createModelFetchError('Custom service model fetch timed out', 'MODEL_FETCH_TIMEOUT')
        continue
      }

      if (isNetworkError(error) && !error?.code) {
        lastError = createModelFetchError('Custom service model fetch failed to reach upstream', 'MODEL_FETCH_NETWORK_ERROR')
        continue
      }

      lastError = error
    }
  }

  throw lastError || new Error('Failed to fetch models from custom service upstream')
}

function mergeModels(models) {
  const byId = new Map()
  for (const model of models) {
    if (model?.id && !byId.has(model.id)) {
      byId.set(model.id, model)
    }
  }
  return [...byId.values()]
}

function messageForModelFetchCode(code) {
  switch (code) {
    case 'MODEL_FETCH_TIMEOUT':
      return 'Model fetch timed out'
    case 'MODEL_FETCH_AUTH_ERROR':
      return 'Model fetch authentication failed'
    case 'MODEL_FETCH_NOT_FOUND':
      return 'Model list endpoint was not found'
    case 'MODEL_FETCH_NETWORK_ERROR':
      return 'Model fetch network error'
    case 'MODEL_FETCH_EMPTY':
      return 'Model list is empty'
    case 'MODEL_FETCH_ALL_FAILED':
      return 'All model sources failed'
    default:
      return 'Model fetch failed'
  }
}

function warningFromError(source, error) {
  const code = error?.code || 'MODEL_FETCH_ERROR'
  return {
    source,
    code,
    message: messageForModelFetchCode(code),
  }
}

function logModelFetchWarning(source, error) {
  const warning = warningFromError(source, error)
  console.warn(`[Models] ${source} model fetch failed code=${warning.code} message=${warning.message}`)
}

async function fetchOpencodeModels() {
  const freeModels = await fetchFreeModels()
  if (!Array.isArray(freeModels) || freeModels.length === 0) {
    throw createModelFetchError('OpenCode free model list is empty', 'MODEL_FETCH_EMPTY')
  }
  return freeModels.map(model => normalizeModelEntry({
    ...model,
    owned_by: 'opencode',
    input_modalities: model.input || ['text'],
    context_window: model.contextWindow,
    max_output_tokens: model.maxTokens,
  }, 'opencode', MODEL_SOURCE_OPENCODE))
}

export async function fetchModelsResponse(config) {
  const warnings = []
  let opencodeModels = []
  let customModels = []

  try {
    opencodeModels = await fetchOpencodeModels()
  } catch (error) {
    warnings.push(warningFromError(MODEL_SOURCE_OPENCODE, error))
    logModelFetchWarning(MODEL_SOURCE_OPENCODE, error)
  }

  try {
    customModels = await fetchCustomServiceModels(config)
  } catch (error) {
    warnings.push(warningFromError(MODEL_SOURCE_CUSTOM, error))
    logModelFetchWarning(MODEL_SOURCE_CUSTOM, error)
  }

  const models = mergeModels([...opencodeModels, ...customModels])

  if (models.length === 0 && warnings.length > 0) {
    const error = new Error('Failed to fetch models from all sources')
    error.code = 'MODEL_FETCH_ALL_FAILED'
    error.warnings = warnings
    throw error
  }

  setModelCache(config, models)

  return {
    object: 'list',
    source: opencodeModels.length > 0 && customModels.length > 0
      ? 'combined'
      : customModels.length > 0
        ? MODEL_SOURCE_CUSTOM
        : MODEL_SOURCE_OPENCODE,
    data: models,
    warnings,
  }
}

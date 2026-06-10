import {
  convertAnthropicToOpenAI,
  convertOpenAIResponse,
  convertOpenAISSEToAnthropicSSE,
} from '../convert.js';
import {
  logModelRouting,
  logStreamChunk,
  logStreamCompleted,
  logUpstreamRequestShape,
  logUpstreamStreamingResponse,
} from './logging.js';
import { writeProxyError } from './errors.js';
import {
  redactAnthropicMessagesRequest,
  redactOpenAIChatRequest,
} from './privacy-filter.js';
import {
  MODEL_SOURCE_CUSTOM,
  MODEL_SOURCE_OPENCODE,
  extractRootFromUrl,
  getActiveAnthropicMessageUrlCandidates,
  getCustomBackendConfig,
  getCustomChatUrlCandidates,
  getOpencodeRequestConfig,
  parseGatewayModelId,
  rememberResolvedCustomRoot,
  withUpstreamModel,
} from './backend.js';

async function getUpstreamRequestOptions(body, config, options = {}) {
  const parsedModel = options.parsedModel || parseGatewayModelId(body?.model)
  const upstreamBody = withUpstreamModel(body, parsedModel)

  if (parsedModel.source === MODEL_SOURCE_CUSTOM) {
    return {
      source: MODEL_SOURCE_CUSTOM,
      urlCandidates: getCustomChatUrlCandidates(config),
      apiKey: String(getCustomBackendConfig(config).apiKey || '').trim(),
      body: JSON.stringify(normalizeOpenAIRequest(upstreamBody, { backendType: 'custom' })),
      timeout: config.proxy.timeout,
      upstreamBody,
    }
  }

  const opencode = getOpencodeRequestConfig(config)
  return {
    source: MODEL_SOURCE_OPENCODE,
    urlCandidates: [opencode.url],
    apiKey: opencode.apiKey,
    body: JSON.stringify(normalizeOpenAIRequest(upstreamBody, { backendType: 'opencode' })),
    timeout: config.proxy.timeout,
    upstreamBody,
  }
}

async function sendUpstreamRequest(body, config, options = {}) {
  const request = await getUpstreamRequestOptions(body, config, options);
  logUpstreamRequestShape('Upstream', request.upstreamBody || body, options.forceDiagnostics);

  let lastError = null

  for (const url of request.urlCandidates || []) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${request.apiKey}`
      },
      body: request.body,
      signal: AbortSignal.timeout(request.timeout)
    });

    if (response.ok) {
      if (request.source === MODEL_SOURCE_CUSTOM) {
        rememberResolvedCustomRoot(config, extractRootFromUrl(url))
      }
      return response;
    }

    const errorText = await response.text();
    lastError = new Error(`Upstream error ${response.status} at ${url} for model ${body?.model || 'unknown'}: ${errorText}`)

    // A 404 can mean the sibling endpoint candidate is the real custom-service root.
    if (!(request.source === MODEL_SOURCE_CUSTOM && response.status === 404)) {
      throw lastError
    }
  }

  throw lastError || new Error('Failed to reach upstream endpoint')
}

function applyStreamingHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }
}

async function pipeStreamToResponse(stream, res, label) {
  if (!stream || typeof stream.getReader !== 'function') {
    throw new Error(`${label} upstream response body is not a readable stream`)
  }

  const reader = stream.getReader();
  let chunkCount = 0;
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunkCount += 1;
    totalBytes += value?.byteLength || 0;
    logStreamChunk(label, chunkCount, value?.byteLength || 0);
    res.write(value);
  }

  logStreamCompleted(label, chunkCount, totalBytes);
  res.end();
}

async function getAnthropicRequestOptions(body, config, options = {}) {
  const parsedModel = options.parsedModel || parseGatewayModelId(body?.model)
  const upstreamBody = withUpstreamModel(body, parsedModel)
  const apiKey = parsedModel.source === MODEL_SOURCE_CUSTOM
    ? String(getCustomBackendConfig(config).apiKey || '').trim()
    : String(config.backend.opencode?.upstreamApiKey || 'public').trim() || 'public'

  return {
    source: parsedModel.source,
    urlCandidates: getActiveAnthropicMessageUrlCandidates(config, parsedModel.source),
    apiKey,
    body: JSON.stringify(upstreamBody),
    timeout: config.proxy.timeout,
    upstreamBody,
  }
}

async function sendAnthropicUpstreamRequest(body, config, options = {}) {
  const request = await getAnthropicRequestOptions(body, config, options)
  logUpstreamRequestShape('Anthropic Upstream', request.upstreamBody || body, options.forceDiagnostics)

  let lastError = null

  for (const url of request.urlCandidates || []) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${request.apiKey}`,
        'x-api-key': request.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: request.body,
      signal: AbortSignal.timeout(request.timeout),
    })

    if (response.ok) {
      if (request.source === MODEL_SOURCE_CUSTOM) {
        rememberResolvedCustomRoot(config, extractRootFromUrl(url))
      }
      return response
    }

    const errorText = await response.text()
    lastError = new Error(`Anthropic upstream error ${response.status} at ${url} for model ${body?.model || 'unknown'}: ${errorText}`)

    // A 404 can mean the sibling endpoint candidate is the real custom-service root.
    if (!(request.source === MODEL_SOURCE_CUSTOM && response.status === 404)) {
      throw lastError
    }
  }

  throw lastError || new Error('Failed to reach Anthropic upstream endpoint')
}

function normalizeToolChoice(toolChoice, tools) {
  if (!toolChoice || toolChoice === 'none' || toolChoice === 'auto' || toolChoice === 'required') {
    return toolChoice;
  }

  if (typeof toolChoice !== 'object') {
    return undefined;
  }

  const name = toolChoice.function?.name;
  if (!name) {
    return undefined;
  }

  const toolExists = tools.some(tool => tool?.function?.name === name);
  return toolExists ? toolChoice : undefined;
}

export function normalizeOpenAIRequest(body, options = {}) {
  if (!body || typeof body !== 'object') {
    return body;
  }

  const normalized = { ...body };

  delete normalized.stream_options;
  delete normalized.parallel_tool_calls;
  delete normalized.store;
  delete normalized.metadata;
  delete normalized.user;

  if (Array.isArray(normalized.messages)) {
    normalized.messages = normalized.messages.map((message) => {
      if (!message || typeof message !== 'object') {
        return message;
      }

      if (message.role === 'developer') {
        return {
          ...message,
          role: 'system'
        };
      }

      return message;
    });
  }

  if (Array.isArray(normalized.tools)) {
    normalized.tools = normalized.tools.filter(tool => tool && typeof tool === 'object');
    if (normalized.tools.length === 0) {
      delete normalized.tools;
    }
  }

  if (normalized.tool_choice !== undefined) {
    if (Array.isArray(normalized.tools) && normalized.tools.length > 0) {
      const toolChoice = normalizeToolChoice(normalized.tool_choice, normalized.tools);
      if (toolChoice === undefined) {
        delete normalized.tool_choice;
      } else {
        normalized.tool_choice = toolChoice;
      }
    } else {
      delete normalized.tool_choice;
    }
  }

  if (normalized.max_completion_tokens !== undefined && normalized.max_tokens === undefined) {
    normalized.max_tokens = normalized.max_completion_tokens;
  }
  delete normalized.max_completion_tokens;

  if (Number.isFinite(normalized.max_tokens)) {
    normalized.max_tokens = Math.max(16, Math.floor(normalized.max_tokens));
  } else if (options.backendType === 'opencode') {
    normalized.max_tokens = 1024;
  }

  return normalized;
}

export async function forwardToUpstream(body, config, options = {}) {
  logModelRouting(body, config);
  const response = await sendUpstreamRequest(body, config, options);
  return await response.json();
}

export async function forwardAnthropicNative(body, config, options = {}) {
  const nextBody = withUpstreamModel(body, options.parsedModel || parseGatewayModelId(body?.model))
  redactAnthropicMessagesRequest(nextBody, config)
  const response = await sendAnthropicUpstreamRequest(nextBody, config, {
    ...options,
    parsedModel: { source: MODEL_SOURCE_CUSTOM, upstreamId: nextBody.model },
  })
  return await response.json()
}

export async function forwardAnthropicViaOpenAI(body, config, options = {}) {
  const nextBody = withUpstreamModel(body, options.parsedModel || parseGatewayModelId(body?.model))
  const openaiBody = convertAnthropicToOpenAI({ ...nextBody, stream: false })
  redactOpenAIChatRequest(openaiBody, config)
  const response = await forwardToUpstream(openaiBody, config, {
    ...options,
    parsedModel: { source: MODEL_SOURCE_OPENCODE, upstreamId: nextBody.model },
    routeType: 'anthropic-bridge',
  })
  return convertOpenAIResponse(response, false)
}

export async function forwardAnthropicNativeStream(body, config, res, options = {}) {
  logModelRouting(body, config)

  try {
    const nextBody = withUpstreamModel(body, options.parsedModel || parseGatewayModelId(body?.model))
    redactAnthropicMessagesRequest(nextBody, config)
    const response = await sendAnthropicUpstreamRequest(nextBody, config, {
      ...options,
      parsedModel: { source: MODEL_SOURCE_CUSTOM, upstreamId: nextBody.model },
    })
    logUpstreamStreamingResponse('Anthropic Native SSE', response, options.forceDiagnostics)
    applyStreamingHeaders(res)
    await pipeStreamToResponse(response.body, res, 'Anthropic Native SSE')
  } catch (error) {
    console.error('[Anthropic Native SSE] stream forwarding failed:', error)
    if (!res.headersSent) {
      writeProxyError(res, error)
    }
  }
}

export async function forwardAnthropicViaOpenAIStream(body, config, res, options = {}) {
  logModelRouting(body, config)

  try {
    const nextBody = withUpstreamModel(body, options.parsedModel || parseGatewayModelId(body?.model))
    const openaiBody = convertAnthropicToOpenAI({ ...nextBody, stream: true })
    redactOpenAIChatRequest(openaiBody, config)
    const response = await sendUpstreamRequest(openaiBody, config, {
      ...options,
      parsedModel: { source: MODEL_SOURCE_OPENCODE, upstreamId: nextBody.model },
      routeType: 'anthropic-bridge',
    })
    logUpstreamStreamingResponse('Anthropic Bridge SSE', response, options.forceDiagnostics)
    applyStreamingHeaders(res)
    const anthropicStream = convertOpenAISSEToAnthropicSSE(response.body)
    await pipeStreamToResponse(anthropicStream, res, 'Anthropic Bridge SSE')
  } catch (error) {
    console.error('[Anthropic Bridge SSE] stream forwarding failed:', error)
    if (!res.headersSent) {
      writeProxyError(res, error)
    }
  }
}

export async function forwardOpenAIStreamToUpstream(body, config, res, options = {}) {
  logModelRouting(body, config);

  try {
    const response = await sendUpstreamRequest(body, config, options);
    logUpstreamStreamingResponse('OpenAI SSE', response);
    applyStreamingHeaders(res);
    await pipeStreamToResponse(response.body, res, 'OpenAI SSE');
  } catch (error) {
    console.error('[OpenAI SSE] stream forwarding failed:', error)
    if (!res.headersSent) {
      writeProxyError(res, error);
    }
  }
}

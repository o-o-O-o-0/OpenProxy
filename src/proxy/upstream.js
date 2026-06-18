import {
  convertAnthropicToOpenAI,
  convertOpenAIResponse,
  convertOpenAISSEToAnthropicSSE,
} from '../convert.js';
import {
  logModelRouting,
  logStreamAborted,
  logStreamChunk,
  logStreamCompleted,
  logStreamFirstByte,
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

// Connect/headers timeout: how long we'll wait for the upstream to start
// returning bytes. Once the response object is in hand we stop the timer
// because streaming completion can take much longer than this and must NOT
// be aborted by the same signal.
let CONNECT_TIMEOUT_MS = 60_000;

// Test-only hook so e2e tests can shrink the timeout without sleeping for 60s.
// Not exported as a public API.
export function __setConnectTimeoutForTest(ms) {
  CONNECT_TIMEOUT_MS = ms;
}

function createConnectAbortController(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`upstream connect timeout after ${timeoutMs}ms`));
  }, timeoutMs);
  // Allow Node to exit if this is the only thing keeping the loop alive.
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}

function getModelMaxOutputTokens(config, parsedModelId) {
  const available = Array.isArray(config?.model?.available) ? config.model.available : []
  const entry = available.find((m) => m && m.id === parsedModelId)
  const value = entry?.max_output_tokens
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null
}

async function getUpstreamRequestOptions(body, config, options = {}) {
  const parsedModel = options.parsedModel || parseGatewayModelId(body?.model)
  const upstreamBody = withUpstreamModel(body, parsedModel)
  const modelMaxOutput = getModelMaxOutputTokens(config, body?.model)

  if (parsedModel.source === MODEL_SOURCE_CUSTOM) {
    const normalizedBody = normalizeOpenAIRequest(upstreamBody, { backendType: 'custom', modelMaxOutput })
    return {
      source: MODEL_SOURCE_CUSTOM,
      urlCandidates: getCustomChatUrlCandidates(config),
      apiKey: String(getCustomBackendConfig(config).apiKey || '').trim(),
      body: JSON.stringify(normalizedBody),
      timeout: config.proxy.timeout,
      upstreamBody: normalizedBody,
    }
  }

  const opencode = getOpencodeRequestConfig(config)
  const normalizedBody = normalizeOpenAIRequest(upstreamBody, { backendType: 'opencode', modelMaxOutput })
  return {
    source: MODEL_SOURCE_OPENCODE,
    urlCandidates: [opencode.url],
    apiKey: opencode.apiKey,
    body: JSON.stringify(normalizedBody),
    timeout: config.proxy.timeout,
    upstreamBody: normalizedBody,
  }
}

async function sendUpstreamRequest(body, config, options = {}) {
  const request = await getUpstreamRequestOptions(body, config, options);
  logUpstreamRequestShape('Upstream', request.upstreamBody || body, options.forceDiagnostics);

  let lastError = null
  const candidates = request.urlCandidates || []

  if (candidates.length === 0) {
    throw new Error(`No upstream URL candidates resolved for source=${request.source}. Check backend configuration.`)
  }

  for (const url of candidates) {
    const { signal, cancel } = createConnectAbortController(CONNECT_TIMEOUT_MS)
    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${request.apiKey}`
        },
        body: request.body,
        signal,
      });
    } catch (fetchErr) {
      cancel()
      lastError = new Error(`Upstream fetch failed at ${url} for model ${body?.model || 'unknown'}: ${fetchErr?.message || fetchErr}`)
      lastError.cause = fetchErr
      // Don't try sibling endpoints on connect/network errors when there's a single candidate.
      if (request.source !== MODEL_SOURCE_CUSTOM) {
        throw lastError
      }
      continue
    }
    // Stop the connect timer immediately — streaming reads must not be aborted by it.
    cancel()

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

  throw lastError || new Error(`Failed to reach upstream endpoint after trying ${candidates.length} candidate(s)`)
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

async function pipeStreamToResponse(stream, res, label, ctx = {}) {
  if (!stream || typeof stream.getReader !== 'function') {
    throw new Error(`${label} upstream response body is not a readable stream`)
  }

  const reader = stream.getReader();
  const startedAt = Date.now();
  let firstByteAt = null;
  let chunkCount = 0;
  let totalBytes = 0;
  let clientClosed = false;
  let writeError = null;

  // Propagate client disconnect to the upstream reader so we don't keep burning
  // tokens after the user navigated away / aborted the request.
  const onClose = () => {
    if (clientClosed) return;
    clientClosed = true;
    reader.cancel(new Error('client disconnected')).catch(() => {});
  };
  const onError = (err) => {
    writeError = writeError || err;
    onClose();
  };
  res.on('close', onClose);
  res.on('error', onError);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      chunkCount += 1;
      const len = value?.byteLength || 0;
      totalBytes += len;

      if (chunkCount === 1) {
        firstByteAt = Date.now();
        logStreamFirstByte(label, len, firstByteAt - startedAt, ctx);
      } else {
        logStreamChunk(label, chunkCount, len, ctx);
      }

      if (res.destroyed || clientClosed) {
        // Client gone — stop reading the upstream and bail out.
        await reader.cancel(new Error('client disconnected')).catch(() => {});
        break;
      }

      const ok = res.write(value);
      if (!ok) {
        // Backpressure — wait until the socket drains or the client goes away.
        await new Promise((resolve) => {
          const onDrain = () => {
            res.off('close', onCloseDuringDrain);
            resolve();
          };
          const onCloseDuringDrain = () => {
            res.off('drain', onDrain);
            resolve();
          };
          res.once('drain', onDrain);
          res.once('close', onCloseDuringDrain);
        });
      }
    }

    if (clientClosed) {
      logStreamAborted(label, 'client-disconnect', { chunks: chunkCount, bytes: totalBytes, duration_ms: Date.now() - startedAt }, ctx);
      // Don't try to res.end() — socket is already gone.
      return;
    }

    res.end();
    logStreamCompleted(label, chunkCount, totalBytes, Date.now() - startedAt, ctx);
  } catch (err) {
    // Upstream read failed (timeout / network reset / parse error).
    const reason = err?.name === 'AbortError' ? 'upstream-aborted' : 'upstream-error';
    logStreamAborted(label, reason, {
      chunks: chunkCount,
      bytes: totalBytes,
      duration_ms: Date.now() - startedAt,
      message: err?.message || String(err),
    }, ctx);
    // If we already streamed any bytes to the client, close the socket
    // gracefully here — we cannot send a JSON error mid-stream.
    // If the failure happened BEFORE any bytes left the proxy, let the
    // error bubble up so the outer handler can produce a proper proxy error.
    if (chunkCount > 0 && !res.writableEnded && !res.destroyed) {
      try { res.end(); } catch { /* ignore */ }
    }
    throw err;
  } finally {
    res.off('close', onClose);
    res.off('error', onError);
  }
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
  const candidates = request.urlCandidates || []

  if (candidates.length === 0) {
    throw new Error(`No Anthropic upstream URL candidates resolved for source=${request.source}. Check backend configuration.`)
  }

  for (const url of candidates) {
    const { signal, cancel } = createConnectAbortController(CONNECT_TIMEOUT_MS)
    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${request.apiKey}`,
          'x-api-key': request.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: request.body,
        signal,
      })
    } catch (fetchErr) {
      cancel()
      lastError = new Error(`Anthropic upstream fetch failed at ${url} for model ${body?.model || 'unknown'}: ${fetchErr?.message || fetchErr}`)
      lastError.cause = fetchErr
      if (request.source !== MODEL_SOURCE_CUSTOM) {
        throw lastError
      }
      continue
    }
    cancel()

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

  throw lastError || new Error(`Failed to reach Anthropic upstream endpoint after trying ${candidates.length} candidate(s)`)
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

  // Resolution order for max_tokens, in priority:
  //   1. Client provided a finite value -> sanitize and use it.
  //   2. Upstream model metadata reports its own max_output_tokens -> use that.
  //   3. Otherwise leave it unset and let the upstream pick its own default.
  //
  // The legacy behavior of unconditionally injecting max_tokens=1024 on the
  // OpenCode path silently truncated long Agent outputs (see logs around
  // 2026-06-18 "流式截断"). We only fall back to a hard-coded value as a
  // last resort — and only one large enough to not surprise the caller.
  if (Number.isFinite(normalized.max_tokens)) {
    normalized.max_tokens = Math.max(16, Math.floor(normalized.max_tokens));
  } else if (Number.isFinite(options.modelMaxOutput) && options.modelMaxOutput > 0) {
    normalized.max_tokens = Math.floor(options.modelMaxOutput);
  } else {
    delete normalized.max_tokens;
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
  const ctx = { requestId: options.requestId, sessionId: options.sessionId }

  try {
    const nextBody = withUpstreamModel(body, options.parsedModel || parseGatewayModelId(body?.model))
    redactAnthropicMessagesRequest(nextBody, config)
    const response = await sendAnthropicUpstreamRequest(nextBody, config, {
      ...options,
      parsedModel: { source: MODEL_SOURCE_CUSTOM, upstreamId: nextBody.model },
    })
    logUpstreamStreamingResponse('Anthropic Native SSE', response, options.forceDiagnostics, ctx)
    applyStreamingHeaders(res)
    await pipeStreamToResponse(response.body, res, 'Anthropic Native SSE', ctx)
  } catch (error) {
    console.error(`[Anthropic Native SSE] rid=${options.requestId || ''} stream forwarding failed:`, error)
    if (!res.headersSent) {
      writeProxyError(res, error)
    }
  }
}

export async function forwardAnthropicViaOpenAIStream(body, config, res, options = {}) {
  logModelRouting(body, config)
  const ctx = { requestId: options.requestId, sessionId: options.sessionId }

  try {
    const nextBody = withUpstreamModel(body, options.parsedModel || parseGatewayModelId(body?.model))
    const openaiBody = convertAnthropicToOpenAI({ ...nextBody, stream: true })
    redactOpenAIChatRequest(openaiBody, config)
    const response = await sendUpstreamRequest(openaiBody, config, {
      ...options,
      parsedModel: { source: MODEL_SOURCE_OPENCODE, upstreamId: nextBody.model },
      routeType: 'anthropic-bridge',
    })
    logUpstreamStreamingResponse('Anthropic Bridge SSE', response, options.forceDiagnostics, ctx)
    applyStreamingHeaders(res)
    const anthropicStream = convertOpenAISSEToAnthropicSSE(response.body)
    await pipeStreamToResponse(anthropicStream, res, 'Anthropic Bridge SSE', ctx)
  } catch (error) {
    console.error(`[Anthropic Bridge SSE] rid=${options.requestId || ''} stream forwarding failed:`, error)
    if (!res.headersSent) {
      writeProxyError(res, error)
    }
  }
}

export async function forwardOpenAIStreamToUpstream(body, config, res, options = {}) {
  logModelRouting(body, config);
  const ctx = { requestId: options.requestId, sessionId: options.sessionId }

  try {
    const response = await sendUpstreamRequest(body, config, options);
    logUpstreamStreamingResponse('OpenAI SSE', response, options.forceDiagnostics, ctx);
    applyStreamingHeaders(res);
    await pipeStreamToResponse(response.body, res, 'OpenAI SSE', ctx);
  } catch (error) {
    console.error(`[OpenAI SSE] rid=${options.requestId || ''} stream forwarding failed:`, error)
    if (!res.headersSent) {
      writeProxyError(res, error);
    }
  }
}

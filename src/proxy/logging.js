function redactHeaders(headers = {}) {
  const nextHeaders = { ...headers };

  for (const key of Object.keys(nextHeaders)) {
    if (['authorization', 'x-api-key', 'x-claude-code-session-id'].includes(key.toLowerCase())) {
      nextHeaders[key] = '[REDACTED]';
    }
  }

  return nextHeaders;
}

function isStreamDebugEnabled() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.DEBUG_STREAM || '').toLowerCase());
}

function shouldLogDiagnostics(force = false) {
  return force || isStreamDebugEnabled();
}

function tagPrefix(label, ctx = {}) {
  const requestId = ctx.requestId ? ` rid=${ctx.requestId}` : '';
  const sessionId = ctx.sessionId ? ` sid=${ctx.sessionId}` : '';
  return `[${label}]${requestId}${sessionId}`;
}

function truncate(value, max = 160) {
  if (typeof value !== 'string') {
    return value;
  }

  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function summarizeAnthropicContent(content) {
  if (!Array.isArray(content)) {
    return {
      kind: typeof content,
      textPreview: typeof content === 'string' ? truncate(content) : undefined,
    };
  }

  const blockTypes = content.map((block) => block?.type || 'unknown');
  const textParts = content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text);
  const toolUses = content
    .filter((block) => block?.type === 'tool_use')
    .map((block) => ({
      id: block.id || '',
      name: block.name || '',
      inputPreview: truncate(JSON.stringify(block.input || {})),
    }));
  const toolResults = content
    .filter((block) => block?.type === 'tool_result')
    .map((block) => ({
      tool_use_id: block.tool_use_id || '',
      is_error: Boolean(block.is_error),
      contentPreview: truncate(
        typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? {})
      ),
    }));

  return {
    kind: 'blocks',
    blockTypes,
    textChars: textParts.join('\n').length,
    textPreview: textParts.length > 0 ? truncate(textParts.join('\n')) : undefined,
    toolUses,
    toolResults,
  };
}

function summarizeOpenAIMessage(message) {
  if (!message || typeof message !== 'object') {
    return { kind: typeof message };
  }

  return {
    role: message.role,
    contentKind: Array.isArray(message.content) ? 'array' : typeof message.content,
    contentPreview: typeof message.content === 'string' ? truncate(message.content) : undefined,
    toolCallCount: Array.isArray(message.tool_calls) ? message.tool_calls.length : 0,
    toolCallNames: Array.isArray(message.tool_calls)
      ? message.tool_calls.map((toolCall) => toolCall?.function?.name || '')
      : [],
    toolCallArguments: Array.isArray(message.tool_calls)
      ? message.tool_calls.map((toolCall) => truncate(toolCall?.function?.arguments || ''))
      : [],
    toolCallId: message.tool_call_id || undefined,
  };
}

export function logRequestSummary(label, req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  console.log(`[${label}] ${req.method} ${req.originalUrl} model=${body.model || 'unknown'} stream=${Boolean(body.stream)}`);
  console.log(`[${label}] headers=${JSON.stringify(redactHeaders(req.headers))}`);
}

export function logModelRouting(body, config) {
  const availableIds = (config.model.available || []).map(m => m.id);
  console.log(`[Model] Request model: ${body.model}, Available: [${availableIds.join(', ')}]`);

  if (body.model && availableIds.includes(body.model)) {
    console.log(`[Model] Using client model: ${body.model}`);
  } else if (body.model) {
    console.log(`[Model] Passing through requested model: ${body.model}`);
  }
}

export function logStreamingDecision(label, { bodyStream, acceptHeader, shouldStream }) {
  if (!isStreamDebugEnabled()) {
    return;
  }

  console.log(
    `[${label}] streaming decision body.stream=${String(bodyStream)} accept=${acceptHeader || '[none]'} => shouldStream=${shouldStream}`
  );
}

// Always logged: upstream response landed. Tells us whether body actually started streaming.
export function logUpstreamStreamingResponse(label, response, _force = false, ctx = {}) {
  const contentType = typeof response?.headers?.get === 'function'
    ? (response.headers.get('content-type') || '[none]')
    : '[unknown]';
  const transferEncoding = typeof response?.headers?.get === 'function'
    ? (response.headers.get('transfer-encoding') || '[none]')
    : '[unknown]';
  const status = response?.status ?? '[unknown]';
  console.log(
    `${tagPrefix(label, ctx)} upstream response status=${status} content-type=${contentType} transfer-encoding=${transferEncoding}`
  );
}

export function logAnthropicRequestDiagnostics(body, force = false) {
  if (!shouldLogDiagnostics(force)) {
    return;
  }

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const summary = messages.map((message, index) => ({
    index,
    role: message?.role || 'unknown',
    ...summarizeAnthropicContent(message?.content),
  }));

  console.log(`[Anthropic] request summary=${JSON.stringify({
    systemType: Array.isArray(body?.system) ? 'array' : typeof body?.system,
    systemPreview: typeof body?.system === 'string' ? truncate(body.system) : undefined,
    messageCount: messages.length,
    toolsCount: Array.isArray(body?.tools) ? body.tools.length : 0,
    toolNames: Array.isArray(body?.tools) ? body.tools.map((tool) => tool?.name || '') : [],
    toolChoice: body?.tool_choice || null,
    maxTokens: body?.max_tokens,
  })}`);
  console.log(`[Anthropic] message blocks=${JSON.stringify(summary)}`);
}

export function logUpstreamRequestShape(label, body, force = false) {
  if (!shouldLogDiagnostics(force)) {
    return;
  }

  console.log(`[${label}] upstream payload=${JSON.stringify({
    keys: body && typeof body === 'object' ? Object.keys(body) : [],
    model: body?.model,
    stream: body?.stream,
    max_tokens: body?.max_tokens,
    toolChoice: body?.tool_choice || null,
    toolsCount: Array.isArray(body?.tools) ? body.tools.length : 0,
    toolNames: Array.isArray(body?.tools) ? body.tools.map((tool) => tool?.function?.name || tool?.name || '') : [],
    messageCount: Array.isArray(body?.messages) ? body.messages.length : 0,
    messages: Array.isArray(body?.messages) ? body.messages.map(summarizeOpenAIMessage) : [],
  })}`);
}

// Always logged: first chunk = TTFB (time-to-first-byte) for the stream.
export function logStreamFirstByte(label, byteLength, elapsedMs, ctx = {}) {
  console.log(
    `${tagPrefix(label, ctx)} first stream chunk bytes=${byteLength} ttfb_ms=${elapsedMs}`
  );
}

// Per-chunk byte logging — kept gated to avoid log spam.
export function logStreamChunk(label, chunkIndex, byteLength, ctx = {}) {
  if (!isStreamDebugEnabled()) {
    return;
  }

  console.log(
    `${tagPrefix(label, ctx)} stream chunk #${chunkIndex} bytes=${byteLength}`
  );
}

// Always logged: clean stream completion.
export function logStreamCompleted(label, chunkCount, totalBytes, durationMs, ctx = {}) {
  console.log(
    `${tagPrefix(label, ctx)} stream completed chunks=${chunkCount} bytes=${totalBytes} duration_ms=${durationMs}`
  );
}

// Always logged: stream ended abnormally — shows reason so we can tell apart
// client disconnect / upstream error / timeout / parse failure.
export function logStreamAborted(label, reason, detail = {}, ctx = {}) {
  const extra = Object.entries(detail)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  console.log(
    `${tagPrefix(label, ctx)} stream aborted reason=${reason}${extra ? ` ${extra}` : ''}`
  );
}

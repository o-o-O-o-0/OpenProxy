function formatErrorForLog(error) {
  if (!error) {
    return 'Unknown error'
  }

  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`
  }

  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function createProxyErrorResponse(error) {
  return {
    error: {
      message: error.message,
      code: error.code || null,
      type: 'proxy_error'
    }
  };
}

function statusForError(error) {
  if (error?.code === 'MODEL_SOURCE_PREFIX_REQUIRED') {
    return 400
  }
  return 500
}

export function writeProxyError(res, error) {
  console.error('[ProxyError]', formatErrorForLog(error))
  res.status(statusForError(error)).json(createProxyErrorResponse(error));
}

export function createInvalidApiKeyResponse() {
  return {
    error: {
      message: 'Invalid API key',
      type: 'invalid_api_key'
    }
  };
}

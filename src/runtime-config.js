const FIXED_PROXY_PORT = 3210

function ensureBackendConfig(config) {
  if (!config.backend || typeof config.backend !== 'object') {
    config.backend = {}
  }

  if (!config.backend.opencode || typeof config.backend.opencode !== 'object') {
    config.backend.opencode = {}
  }

  if (!config.backend.custom || typeof config.backend.custom !== 'object') {
    config.backend.custom = {}
  }

  if (!config.ui || typeof config.ui !== 'object') {
    config.ui = {}
  }

  if (!config.privacy || typeof config.privacy !== 'object') {
    config.privacy = {}
  }
}

function parseBoolean(value) {
  if (value === true || value === 'true' || value === '1') return true
  if (value === false || value === 'false' || value === '0') return false
  return null
}

export function parseArgs(args = process.argv.slice(2)) {
  const parsed = {
    port: null,
    host: null,
    lanAccess: false,
    apiKey: null,
    customBaseUrl: null,
    customApiKey: null,
    opencodeBaseUrl: null,
    opencodeUpstreamApiKey: null,
    privacyEnabled: null,
    privacyRedactAssistantMessages: null,
    privacyRedactToolResults: null,
    privacyLogHits: null,
  }

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) {
      parsed.port = parseInt(args[i + 1], 10)
      i++
    } else if (args[i] === '--host' && i + 1 < args.length) {
      parsed.host = args[i + 1]
      i++
    } else if (args[i] === '--api-key' && i + 1 < args.length) {
      parsed.apiKey = args[i + 1]
      i++
    } else if (args[i] === '--custom-base-url' && i + 1 < args.length) {
      parsed.customBaseUrl = args[i + 1]
      i++
    } else if (args[i] === '--custom-api-key' && i + 1 < args.length) {
      parsed.customApiKey = args[i + 1]
      i++
    } else if (args[i] === '--opencode-base-url' && i + 1 < args.length) {
      parsed.opencodeBaseUrl = args[i + 1]
      i++
    } else if (args[i] === '--opencode-upstream-api-key' && i + 1 < args.length) {
      parsed.opencodeUpstreamApiKey = args[i + 1]
      i++
    } else if (args[i] === '--lan-access') {
      parsed.lanAccess = true
    } else if (args[i] === '--privacy-enabled' && i + 1 < args.length) {
      parsed.privacyEnabled = parseBoolean(args[i + 1])
      i++
    } else if (args[i] === '--privacy-redact-assistant-messages' && i + 1 < args.length) {
      parsed.privacyRedactAssistantMessages = parseBoolean(args[i + 1])
      i++
    } else if (args[i] === '--privacy-redact-tool-results' && i + 1 < args.length) {
      parsed.privacyRedactToolResults = parseBoolean(args[i + 1])
      i++
    } else if (args[i] === '--privacy-log-hits' && i + 1 < args.length) {
      parsed.privacyLogHits = parseBoolean(args[i + 1])
      i++
    }
  }

  return parsed
}

export function applyCliOverrides(config, cliArgs) {
  ensureBackendConfig(config)

  config.proxy.port = FIXED_PROXY_PORT
  if (cliArgs.host) {
    config.proxy.host = cliArgs.host
  }
  if (cliArgs.apiKey) {
    config.proxy.apiKey = cliArgs.apiKey
  }
  if (cliArgs.lanAccess) {
    config.proxy.lanAccess = true
    config.proxy.host = '0.0.0.0'
  }

  if (cliArgs.customBaseUrl !== null) {
    config.backend.custom.baseUrl = cliArgs.customBaseUrl
  }
  if (cliArgs.customApiKey !== null) {
    config.backend.custom.apiKey = cliArgs.customApiKey
  }
  if (cliArgs.opencodeBaseUrl !== null) {
    config.backend.opencode.baseUrl = cliArgs.opencodeBaseUrl
  }
  if (cliArgs.opencodeUpstreamApiKey !== null) {
    config.backend.opencode.upstreamApiKey = cliArgs.opencodeUpstreamApiKey
  }

  if (cliArgs.privacyEnabled !== null) {
    config.privacy.enabled = cliArgs.privacyEnabled
  }
  if (cliArgs.privacyRedactAssistantMessages !== null) {
    config.privacy.redactAssistantMessages = cliArgs.privacyRedactAssistantMessages
  }
  if (cliArgs.privacyRedactToolResults !== null) {
    config.privacy.redactToolResults = cliArgs.privacyRedactToolResults
  }
  if (cliArgs.privacyLogHits !== null) {
    config.privacy.logHits = cliArgs.privacyLogHits
  }

  return config
}

function hasOwn(env, name) {
  return Object.prototype.hasOwnProperty.call(env, name)
}

export function applyEnvOverrides(config, env = process.env) {
  ensureBackendConfig(config)

  if (hasOwn(env, 'OPENPROXY_API_KEY') && String(env.OPENPROXY_API_KEY).trim()) {
    config.proxy.apiKey = String(env.OPENPROXY_API_KEY)
  }
  if (hasOwn(env, 'OPENPROXY_CUSTOM_API_KEY')) {
    config.backend.custom.apiKey = String(env.OPENPROXY_CUSTOM_API_KEY)
  }
  if (hasOwn(env, 'OPENPROXY_OPENCODE_UPSTREAM_API_KEY')) {
    config.backend.opencode.upstreamApiKey = String(env.OPENPROXY_OPENCODE_UPSTREAM_API_KEY)
  }

  return config
}

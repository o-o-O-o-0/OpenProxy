/**
 * Privacy Filter — 隐私过滤（不可逆替换）
 *
 * 在文本进入 LLM 之前，过滤掉用户的敏感信息（PII / 密钥）。
 * 纯正则、无模型、O(n)。不可逆替换，不保存原始映射。
 *
 * 两层检测：
 *   1. 结构化 PII：邮箱、手机号、身份证、银行卡（Luhn）、IP
 *   2. 密钥/凭证：已知格式 + 上下文口令 + 高熵兜底
 *
 * 移植自 privacy-filter-main Go 版本，保留全部后校验逻辑。
 */

// 结构化 PII 正则
const RE_EMAIL = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g
const RE_PHONE_CN = /(?:\+?86[-\s]?)?1[3-9][0-9]{9}/g
const RE_ID_CARD = /[1-9][0-9]{16}[0-9Xx]/g
const RE_BANK_CARD = /[0-9]{13,19}/g
const RE_IPV4 = /(?:(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])/g
const SSH_COMMANDS = ['ssh ', 'scp ', 'rsync ', 'sftp ', 'ssh-copy-id ', 'ssh-keygen ']

// 密钥 / 凭证正则与配置
const ENTROPY_MIN = 4.0
const ENTROPY_MIN_STRICT = 4.8
const CONTEXT_LOOKBACK = 30
const RE_CONTEXT_SECRET = /(密码|口令|密钥|password|passwd|pwd|secret|token|api[_\s-]?key)\s*(?:是|为|:|：|=)\s*['\"]?([^\s'\"，。；;]{4,})/gi
const RE_ENTROPY_TOKEN = /[A-Za-z0-9+/=_\-]{20,}/g
const RE_SECRET_CONTEXT = /(?:password|passwd|pwd|secret|token|api[_\s-]?key|access[_\s-]?key|bearer|authorization|credential|jwt|密码|口令|密钥|凭证|令牌|鉴权)/i
const RE_TEMPLATE_VAR = /^(?:\{\{[^{}]+\}\}|\$\{[^{}]+\}|%\{[^{}]+\}|<[^<>]+>)$/
const RE_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const RE_HEX_ONLY = /^[0-9a-fA-F]+$/
const RE_AUTH_HEADER_PREFIX = /\bauthorization\s*:\s*(?:basic|bearer|digest|ntlm|hmac|token)\s+$/i
const RE_HOST_PORT_PREFIX = /^[A-Za-z0-9][A-Za-z0-9.\-]*\.[A-Za-z0-9\-]+:/
const PATH_BOUNDARY_CHARS = '/\\:.@?='
const PATH_INTERNAL_CHARS = '/\\:'
const URL_PREFIXES = ['http://', 'https://', 'ftp://', 'ssh://', 's3://', 'gs://', 'oss://', 'git@', 'sha256:', 'sha1:', 'md5:']
const ASSIGNMENT_CHARS = ` \t\r\n=:'"`
const BENIGN_ID_SUFFIXES = ['_id', '_uuid', '_uid', '_oid', '_no', '_seq']
const COMMON_PLACEHOLDERS = ['REPLACE_ME', 'REPLACE_THIS', 'REPLACE_WITH', 'YOUR_KEY', 'YOUR_TOKEN', 'YOUR_SECRET', 'YOUR_API_KEY', 'YOUR_PASSWORD', 'INSERT_HERE', 'INSERT_KEY', 'INSERT_TOKEN', 'PLACEHOLDER', 'EXAMPLE_KEY', 'EXAMPLE_TOKEN', 'TODO', 'FIXME', 'XXXX']
const KNOWN_SECRET_RULES = [
  { re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, keywords: ['sk-'] },
  { re: /sk-ant-[A-Za-z0-9_-]{20,}/g, keywords: ['sk-ant-'] },
  { re: /AKIA[0-9A-Z]{16}/g, keywords: ['akia'] },
  { re: /gh[pousr]_[A-Za-z0-9]{36,}/g, keywords: ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_'] },
  { re: /AIza[0-9A-Za-z_-]{35}/g, keywords: ['aiza'] },
  { re: /xox[baprs]-[0-9A-Za-z\-]{10,}/g, keywords: ['xox'] },
  { re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, keywords: ['eyj'] },
  { re: /-----BEGIN[A-Z ]*PRIVATE KEY-----/g, keywords: ['private key'] },
]

function isDigitCode(code) {
  return code >= 48 && code <= 57
}

function digitBounded(text, start, end) {
  if (start > 0 && isDigitCode(text.charCodeAt(start - 1))) return false
  if (end < text.length && isDigitCode(text.charCodeAt(end))) return false
  return true
}

function isVersionBoundaryChar(char) {
  return /[A-Za-z0-9_.-]/.test(char)
}

function ipBounded(text, start, end) {
  if (start > 0 && isVersionBoundaryChar(text[start - 1])) return false
  if (end < text.length && isVersionBoundaryChar(text[end])) return false
  return true
}

function luhnValid(num) {
  let sum = 0
  let double = false
  for (let i = num.length - 1; i >= 0; i--) {
    let d = num.charCodeAt(i) - 48
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

function isInSSHCommandContext(text, emailStart) {
  const lineStart = text.lastIndexOf('\n', emailStart - 1) + 1
  const line = text.slice(lineStart, emailStart)
  return SSH_COMMANDS.some(cmd => line.includes(cmd))
}

function shannonEntropy(s) {
  if (!s) return 0
  const freq = new Map()
  for (let i = 0; i < s.length; i++) freq.set(s[i], (freq.get(s[i]) || 0) + 1)
  let ent = 0
  for (const count of freq.values()) {
    const p = count / s.length
    ent -= p * Math.log2(p)
  }
  return ent
}

function looksLikeURLMatch(s) {
  return s.includes('://') || RE_HOST_PORT_PREFIX.test(s)
}

function isLikelyPlaceholder(s) {
  const upper = s.toUpperCase()
  return COMMON_PLACEHOLDERS.some(value => upper.includes(value))
}

function isTemplateVar(s) {
  return RE_TEMPLATE_VAR.test(s)
}

function isHexHash(s) {
  return (s.length === 32 || s.length === 40 || s.length === 64) && RE_HEX_ONLY.test(s)
}

function isUUID(s) {
  return RE_UUID.test(s)
}

function isBusinessIDAssignment(s) {
  const eq = s.indexOf('=')
  if (eq <= 0) return false
  const name = s.slice(0, eq).toLowerCase()
  if (['key', 'secret', 'token', 'auth', 'password', 'credential'].some(k => name.includes(k))) return false
  return BENIGN_ID_SUFFIXES.some(suffix => name.endsWith(suffix))
}

function isOnPathOrURLBoundary(text, start, end) {
  for (let i = start; i < end; i++) {
    if (PATH_INTERNAL_CHARS.includes(text[i])) return true
  }
  if (start > 0 && PATH_BOUNDARY_CHARS.includes(text[start - 1])) return true
  if (end < text.length && PATH_BOUNDARY_CHARS.includes(text[end])) return true
  const look = text.slice(Math.max(0, start - 8), start)
  return URL_PREFIXES.some(prefix => look.includes(prefix))
}

function hasSecretContext(text, start, end) {
  return RE_SECRET_CONTEXT.test(text.slice(Math.max(0, start - CONTEXT_LOOKBACK), end))
}

function hasStrongSecretContext(text, start, end) {
  const lo = Math.max(0, start - CONTEXT_LOOKBACK)
  if (RE_AUTH_HEADER_PREFIX.test(text.slice(lo, start))) return true
  const region = text.slice(lo, end)
  const matches = [...region.matchAll(new RegExp(RE_SECRET_CONTEXT.source, 'gi'))]
  if (matches.length === 0) return false
  const last = matches[matches.length - 1]
  const keywordStart = last.index
  const keywordEnd = keywordStart + last[0].length
  const candStart = start - lo
  if (keywordStart >= candStart) return true
  const between = region.slice(keywordEnd, candStart)
  for (let i = 0; i < between.length; i++) {
    if (!ASSIGNMENT_CHARS.includes(between[i])) return false
  }
  return true
}

function ruleApplies(rule, lowText) {
  return !rule.keywords?.length || rule.keywords.some(keyword => lowText.includes(keyword))
}

function mergeSpans(spans) {
  const valid = spans.filter(s => s.start >= 0 && s.start < s.end)
  valid.sort((a, b) => a.start !== b.start ? a.start - b.start : b.end - a.end)
  const merged = []
  let lastEnd = -1
  for (const span of valid) {
    if (span.start >= lastEnd) {
      merged.push(span)
      lastEnd = span.end
    }
  }
  return merged
}

function rebuildText(text, spans) {
  let out = ''
  let prev = 0
  for (const span of spans) {
    out += text.slice(prev, span.start)
    out += span.label
    prev = span.end
  }
  return out + text.slice(prev)
}

function detectPII(text) {
  const spans = []
  for (const match of text.matchAll(RE_EMAIL)) {
    const start = match.index
    const end = start + match[0].length
    if (end < text.length && text[end] === ':' &&
        end + 1 < text.length && text[end + 1] !== ' ' && text[end + 1] !== '\t') continue
    if (isInSSHCommandContext(text, start)) continue
    spans.push({ start, end, label: '[PRIVATE_EMAIL]' })
  }
  for (const match of text.matchAll(RE_PHONE_CN)) {
    const start = match.index
    const end = start + match[0].length
    if (digitBounded(text, start, end)) spans.push({ start, end, label: '[PRIVATE_PHONE]' })
  }
  for (const match of text.matchAll(RE_ID_CARD)) {
    const start = match.index
    const end = start + match[0].length
    if (digitBounded(text, start, end)) spans.push({ start, end, label: '[PRIVATE_ID_CARD]' })
  }
  for (const match of text.matchAll(RE_IPV4)) {
    const start = match.index
    const end = start + match[0].length
    if (ipBounded(text, start, end)) spans.push({ start, end, label: '[PRIVATE_IP]' })
  }
  for (const match of text.matchAll(RE_BANK_CARD)) {
    const start = match.index
    const end = start + match[0].length
    if (digitBounded(text, start, end) && luhnValid(match[0])) spans.push({ start, end, label: '[PRIVATE_BANK_CARD]' })
  }
  return spans
}

function detectSecrets(text) {
  const spans = []
  const low = text.toLowerCase()
  for (const rule of KNOWN_SECRET_RULES) {
    if (!ruleApplies(rule, low)) continue
    rule.re.lastIndex = 0
    for (const match of text.matchAll(rule.re)) {
      const start = match.index
      const end = start + match[0].length
      const cand = match[0]
      if (looksLikeURLMatch(cand) || isTemplateVar(cand) || isHexHash(cand) ||
          isUUID(cand) || isBusinessIDAssignment(cand) ||
          isLikelyPlaceholder(cand) || cand.includes(',')) continue
      spans.push({ start, end, label: '[PRIVATE_SECRET]' })
    }
  }
  RE_CONTEXT_SECRET.lastIndex = 0
  for (const match of text.matchAll(RE_CONTEXT_SECRET)) {
    const value = match[2]
    if (!value) continue
    const valueStart = match.index + match[0].lastIndexOf(value)
    const valueEnd = valueStart + value.length
    if (isTemplateVar(value) || isLikelyPlaceholder(value)) continue
    if (value.length <= 16 && shannonEntropy(value) < 3.0) continue
    spans.push({ start: valueStart, end: valueEnd, label: '[PRIVATE_SECRET]' })
  }
  RE_ENTROPY_TOKEN.lastIndex = 0
  for (const match of text.matchAll(RE_ENTROPY_TOKEN)) {
    const start = match.index
    const end = start + match[0].length
    const cand = match[0]
    const strong = hasStrongSecretContext(text, start, end)
    if (!strong && isOnPathOrURLBoundary(text, start, end)) continue
    if (isTemplateVar(cand) || isHexHash(cand) || isUUID(cand) ||
        isBusinessIDAssignment(cand) || isLikelyPlaceholder(cand)) continue
    const threshold = hasSecretContext(text, start, end) ? ENTROPY_MIN : ENTROPY_MIN_STRICT
    if (shannonEntropy(cand) >= threshold) spans.push({ start, end, label: '[PRIVATE_SECRET]' })
  }
  return spans
}
export function redactText(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: typeof text === "string" ? text : '', hit: false, count: 0, entities: [], summary: {} }
  }
  const merged = mergeSpans([...detectPII(text), ...detectSecrets(text)])
  const entities = merged.map(span => ({ type: span.label, start: span.start, end: span.end }))
  const summary = {}
  for (const entity of entities) summary[entity.type] = (summary[entity.type] || 0) + 1
  return { text: rebuildText(text, merged), hit: merged.length > 0, count: merged.length, entities, summary }
}

export function isPrivacyEnabled(config) {
  return config?.privacy?.enabled !== false
}

function makeAggregateResult(body) {
  return { body, hit: false, count: 0, summary: {} }
}

function mergeResult(target, result) {
  if (!result?.hit) return
  target.hit = true
  target.count += result.count
  for (const [label, count] of Object.entries(result.summary || {})) {
    target.summary[label] = (target.summary[label] || 0) + count
  }
}

function redactStringValue(value, aggregate) {
  const result = redactText(value)
  mergeResult(aggregate, result)
  return result.text
}

function shouldRedactRole(role, config) {
  if (role === 'assistant') return config?.privacy?.redactAssistantMessages !== false
  return true
}

function redactOpenAIContent(content, aggregate, config) {
  if (typeof content === 'string') return redactStringValue(content, aggregate)
  if (!Array.isArray(content)) return content
  return content.map(block => {
    if (block?.type === 'text' && typeof block.text === 'string') {
      const label = shouldRedactRole(block._role, config) ? redactStringValue(block.text, aggregate) : block.text
      return { ...block, text: label }
    }
    return block
  })
}

function redactOpenAIMessage(msg, aggregate, config) {
  const shouldRedact = shouldRedactRole(msg.role, config)
  if (msg.content && shouldRedact) {
    msg.content = redactOpenAIContent(msg.content, aggregate, config)
  }
}

export function redactOpenAIChatRequest(body, config) {
  if (!body || !isPrivacyEnabled(config)) return makeAggregateResult(body)
  const aggregate = makeAggregateResult(body)
  if (Array.isArray(body.messages)) {
    for (let i = 0; i < body.messages.length; i++) {
      redactOpenAIMessage(body.messages[i], aggregate, config)
    }
  }
  return aggregate
}

function redactAnthropicToolResultContent(content, aggregate) {
  if (typeof content === 'string') return redactStringValue(content, aggregate)
  if (!Array.isArray(content)) return content
  return content.map(block => {
    if (block?.type === 'text' && typeof block.text === 'string') {
      return { ...block, text: redactStringValue(block.text, aggregate) }
    }
    return block
  })
}

function redactAnthropicContent(content, aggregate, config) {
  if (typeof content === 'string') return redactStringValue(content, aggregate)
  if (!Array.isArray(content)) return content
  return content.map(block => {
    if (block?.type === 'text' && typeof block.text === 'string') {
      const label = shouldRedactRole(block._role, config) ? redactStringValue(block.text, aggregate) : block.text
      return { ...block, text: label }
    }
    if (block?.type === 'tool_result' && config?.privacy?.redactToolResults !== false) {
      return { ...block, content: redactAnthropicToolResultContent(block.content, aggregate) }
    }
    return block
  })
}

function redactAnthropicMessage(msg, aggregate, config) {
  const shouldRedact = shouldRedactRole(msg.role, config)
  if (msg.content && shouldRedact) {
    msg.content = redactAnthropicContent(msg.content, aggregate, config)
  }
}

function redactAnthropicSystem(system, aggregate) {
  if (typeof system === 'string') return redactStringValue(system, aggregate)
  if (!Array.isArray(system)) return system
  return system.map(block => {
    if (block?.type === 'text' && typeof block.text === 'string') {
      return { ...block, text: redactStringValue(block.text, aggregate) }
    }
    return block
  })
}

export function redactAnthropicMessagesRequest(body, config) {
  if (!body || !isPrivacyEnabled(config)) return makeAggregateResult(body)
  const aggregate = makeAggregateResult(body)
  if (Array.isArray(body.messages)) {
    for (let i = 0; i < body.messages.length; i++) {
      redactAnthropicMessage(body.messages[i], aggregate, config)
    }
  }
  return aggregate
}

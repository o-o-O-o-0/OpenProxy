import { invoke } from '@tauri-apps/api/core'

export function getConfig() {
  return invoke('get_config')
}

export function getApiKey() {
  return invoke('get_api_key')
}

export function getProxyStatus() {
  return invoke('get_proxy_status')
}

export function startProxy() {
  return invoke('start_proxy')
}

export function stopProxy() {
  return invoke('stop_proxy')
}

export function saveConfigPatch(patch) {
  return invoke('save_config', { patch })
}

export function detectCustomServiceModels(baseUrl, apiKey) {
  return invoke('detect_custom_service_models', { baseUrl, apiKey })
}

export async function fetchProxyModels(port, apiKey) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  })

  if (!response.ok) {
    let detail = ''
    let code = ''
    try {
      const payload = await response.json()
      detail = payload?.error?.message || ''
      code = payload?.error?.code || ''
    } catch {
      detail = ''
      code = ''
    }

    const error = new Error(detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`)
    error.status = response.status
    error.code = code
    throw error
  }

  return response.json()
}

export async function reloadProxyConfig(port, apiKey) {
  const response = await fetch(`http://127.0.0.1:${port}/reload-config`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
  })

  if (!response.ok) {
    throw new Error(`热更新代理配置失败: HTTP ${response.status}`)
  }

  return response
}

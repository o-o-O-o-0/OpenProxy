<template>
  <div class="popover-shell">
    <div class="panel-frame">
      <div class="panel-surface">
        <PanelHeader
          :brand-logo="brandLogo"
          :status="status"
          :status-text="statusText"
          :status-description="statusDescription"
          :port="port"
          :lan-access="lanAccess"
        />

        <div class="panel-body">
          <EndpointBanner
            :openai-url="openaiUrl"
            :api-key="apiKey"
            :is-action-done="isActionDone"
            @copy-openai-url="copyText(openaiUrl, '接口地址已复制', 'copy-openai-url')"
            @copy-api-key="copyText(apiKey, '访问密钥已复制', 'copy-api-key')"
          />

          <section class="info-grid">
            <ModelCard
              :models="visibleModels"
              :refreshing="refreshing"
              :refresh-pulse-visible="refreshPulseVisible"
              :model-summary="modelSummary"
              :model-empty-message="modelEmptyMessage"
              :show-model-loading-state="showModelLoadingState"
              :model-loading-text="modelLoadingText"
              :current-source="modelSource"
              :show-custom-form="showCustomForm"
              :show-custom-edit-button="showCustomEditButton"
              :custom-edit-button-label="customEditButtonLabel"
              :draft-custom-base-url="draftCustomBaseUrl"
              :draft-custom-api-key="draftCustomApiKey"
              :source-saving="modelSourceSaving"
              :source-clearing="modelSourceClearing"
              :can-save-source="canSaveModelSource"
              :can-clear-custom-config="canClearCustomConfig"
              :source-action-label="modelSourceActionLabel"
              :source-status-text="modelSourceStatusText"
              :custom-check-feedback="customCheckFeedback"
              :is-action-done="isActionDone"
              :format-model-capabilities="formatModelCapabilities"
              @refresh-models="refreshModels"
              @copy-model="copyText($event, '模型标识已复制', `copy-model-${$event}`)"
              @update-draft-source="handleModelSourceChange"
              @edit-custom-config="beginCustomConfigEdit"
              @update-draft-custom-base-url="updateDraftCustomBaseUrl"
              @update-draft-custom-api-key="updateDraftCustomApiKey"
              @save-source="saveModelSource"
              @clear-custom-config="clearCustomServiceConfig"
            />

            <NetworkCard
              :loading="loading"
              :service-button-class="serviceButtonClass"
              :service-action-label="serviceActionLabel"
              :network-busy="networkBusy"
              :lan-access="lanAccess"
              :privacy-enabled="privacyEnabled"
              @toggle-service="toggleService"
              @toggle-lan-access="toggleLanAccess"
              @toggle-privacy-mode="togglePrivacyMode"
            />
          </section>

          <ToolSection
            :tool-statuses="visibleToolStatuses"
            :tool-status-loading="toolStatusLoading"
            :tool-action-loading="toolActionLoading"
            :claude-mapping="claudeMapping"
            :is-action-done="isActionDone"
            :format-tool-version="formatToolVersion"
            :format-config-path="formatConfigPath"
            @refresh-tools="refreshToolStatuses"
            @apply-tool-config="applyToolConfig"
            @open-tool-path="openToolPath($event.toolKey, $event.path)"
            @update-claude-mapping="updateClaudeMapping($event.key, $event.value)"
          />
        </div>

        <footer class="panel-footer">
          <p>点击托盘图标可展开/收起面板，右键托盘图标可退出程序。</p>
        </footer>

        <div v-if="showCopyToast" class="toast">{{ toastText }}</div>
      </div>
    </div>
  </div>
</template>

<script>
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  detectCustomServiceModels as detectCustomServiceModelsApi,
  fetchProxyModels,
  getApiKey,
  getConfig,
  getProxyStatus,
  reloadProxyConfig,
  saveConfigPatch,
  startProxy,
  stopProxy,
} from './api/proxy.js'
import brandLogo from './assets/openproxy-logo.png'
import PanelHeader from './components/PanelHeader.vue'
import EndpointBanner from './components/EndpointBanner.vue'
import ModelCard from './components/ModelCard.vue'
import NetworkCard from './components/NetworkCard.vue'
import ToolSection from './components/ToolSection.vue'

export default {
  components: {
    PanelHeader,
    EndpointBanner,
    ModelCard,
    NetworkCard,
    ToolSection,
  },
  data() {
    return {
      brandLogo,
      status: 'checking',
      apiKey: '',
      port: 3210,
      lanAccess: false,
      lanIp: '',
      opencodeModels: [],
      customModels: [],
      modelSource: 'opencode',
      savedModelSource: 'opencode',
      draftCustomBaseUrl: '',
      draftCustomApiKey: '',
      savedCustomBaseUrl: '',
      savedCustomApiKey: '',
      editingCustomConfig: false,
      modelSourceSaving: false,
      modelSourceClearing: false,
      customCheckFeedback: {
        type: '',
        message: '',
        details: '',
      },
      modelViewPhase: 'loading',
      modelsLoading: true,
      modelsLoadingText: '正在加载模型列表...',
      lastModelLoadError: '',
      lastModelLoadDetails: '',
      updateTime: null,
      refreshPulseVisible: false,
      showCopyToast: false,
      toastText: '已复制到剪贴板',
      toastTimer: null,
      refreshPulseTimer: null,
      actionDoneMap: {},
      actionDoneTimers: {},
      unlistenStatusEvent: null,
      toolStatuses: [],
      claudeMapping: {
        opus: '',
        sonnet: '',
        haiku: '',
      },
      toolStatusLoading: false,
      toolActionLoading: null,
      loading: false,
      serviceTransition: null,
      refreshing: false,
      networkBusy: false,
      networkHydrated: false,
      suspendLanPersist: false,
      privacyEnabled: true,
      suppressStatusRefreshUntil: 0,
    }
  },
  computed: {
    openaiUrl() {
      if (!this.lanAccess) return `http://127.0.0.1:${this.port}/v1`
      return `http://${this.lanIp || '0.0.0.0'}:${this.port}/v1`
    },
    statusText() {
      if (this.loading) return '处理中'
      if (this.status === 'running') return '运行中'
      if (this.status === 'stopped') return '已停止'
      return '检查中'
    },
    statusDescription() {
      if (this.serviceTransition === 'starting') return '正在启动本地代理服务'
      if (this.serviceTransition === 'stopping') return '正在停止本地代理服务'
      if (this.serviceTransition === 'restarting') return '正在重启本地代理服务以应用设置'
      if (this.loading) return this.status === 'running' ? '正在停止本地代理服务' : '正在启动本地代理服务'
      if (this.status === 'running') return '本地代理在线，可立即供命令行工具与编辑器调用'
      if (this.status === 'stopped') return '点击启动后即可接入双协议模型服务'
      return '正在检查当前服务与模型信息'
    },
    serviceActionLabel() {
      if (this.serviceTransition === 'starting') return '启动中'
      if (this.serviceTransition === 'stopping') return '停止中'
      if (this.serviceTransition === 'restarting') return '重启中'
      if (this.loading) return this.status === 'running' ? '停止中' : '启动中'
      return this.status === 'running' ? '停止服务' : '启动服务'
    },
    serviceButtonClass() {
      if (this.serviceTransition === 'stopping') return 'action-button-danger'
      if (this.serviceTransition === 'starting' || this.serviceTransition === 'restarting') return 'action-button-primary'
      return this.status === 'running' ? 'action-button-danger' : 'action-button-primary'
    },
    visibleModels() {
      if (this.modelSource === 'custom') {
        return this.hasSavedCustomConfig ? this.customModels : []
      }

      return this.opencodeModels
    },
    allToolModels() {
      const byId = new Map()
      for (const model of [...this.opencodeModels, ...this.customModels]) {
        if (model?.id && !byId.has(model.id)) byId.set(model.id, model)
      }
      return [...byId.values()]
    },
    showCustomForm() {
      if (this.modelSource !== 'custom') {
        return false
      }

      if (!this.hasSavedCustomConfig) {
        return true
      }

      return this.editingCustomConfig
    },
    showCustomEditButton() {
      return this.modelSource === 'custom' && this.hasSavedCustomConfig && !this.editingCustomConfig
    },
    customEditButtonLabel() {
      return this.showCustomReconfigureHint ? '重新配置' : '修改配置'
    },
    hasSavedCustomConfig() {
      return Boolean(String(this.savedCustomBaseUrl || '').trim() && String(this.savedCustomApiKey || '').trim())
    },
    showCustomReconfigureHint() {
      return this.modelSource === 'custom'
        && this.hasSavedCustomConfig
        && !this.editingCustomConfig
        && Boolean(this.lastModelLoadError)
    },
    modelSummary() {
      if (this.modelsLoading) {
        return this.modelLoadingText
      }

      if (this.modelSourceSaving) {
        return this.modelSource === 'custom'
          ? '正在保存并检测自定义服务上游。'
          : '正在切换到 OpenCode 免费模型。'
      }

      const activeLabel = this.modelSourceLabel(this.modelSource)

      if (this.refreshing) return `正在更新 ${activeLabel} 的模型列表。`
      if (this.lastModelLoadError) return this.lastModelLoadError
      if (!this.visibleModels.length && this.status !== 'running') return '启动服务后即可同步当前来源的模型列表。'
      if (this.modelSource === 'custom' && !this.hasSavedCustomConfig) {
        return '填写并保存后，展示自定义接口返回的模型列表。'
      }
      if (!this.visibleModels.length) return '暂未获取到模型'
      return `${activeLabel} · ${this.visibleModels.length} 个模型 · ${this.updateTimeText}`
    },
    modelEmptyMessage() {
      if (this.showModelLoadingState) {
        return ''
      }

      if (this.lastModelLoadDetails) {
        if (this.lastModelLoadError) {
          return `${this.lastModelLoadError}\n\n${this.lastModelLoadDetails}`
        }

        return this.lastModelLoadDetails
      }

      if (this.lastModelLoadError) {
        return this.lastModelLoadError
      }

      if (this.modelSource === 'custom' && !this.hasSavedCustomConfig) {
        return ''
      }

      if (!this.visibleModels.length && this.status !== 'running') {
        return '启动服务后即可同步当前来源的模型列表。'
      }

      return '暂未获取到模型'
    },
    showModelLoadingState() {
      return this.modelViewPhase === 'loading'
    },
    modelLoadingText() {
      return this.modelsLoadingText || `正在加载 ${this.modelSourceLabel(this.modelSource)} 模型列表...`
    },
    updateTimeText() {
      if (!this.updateTime) return '尚未刷新'
      const elapsed = Math.floor((Date.now() - this.updateTime) / 1000)
      if (elapsed < 60) return '刚刚更新'
      if (elapsed < 3600) return `${Math.floor(elapsed / 60)} 分钟前更新`
      return `${Math.floor(elapsed / 3600)} 小时前更新`
    },
    visibleToolStatuses() {
      return this.toolStatuses.filter(tool => tool?.installed)
    },
    canAttemptCustomService() {
      return Boolean(String(this.draftCustomBaseUrl || '').trim() && String(this.draftCustomApiKey || '').trim())
    },
    canSaveModelSource() {
      if (this.modelSource === 'custom') {
        return this.canAttemptCustomService
      }

      return true
    },
    canClearCustomConfig() {
      return Boolean(
        String(this.savedCustomBaseUrl || '').trim()
        || String(this.savedCustomApiKey || '').trim()
        || String(this.draftCustomBaseUrl || '').trim()
        || String(this.draftCustomApiKey || '').trim()
        || this.customModels.length > 0
      )
    },
    modelSourceStatusText() {
      if (this.modelSourceSaving) {
        return this.modelSource === 'custom' ? '检测中...' : '刷新中...'
      }
      if (this.modelSourceClearing) {
        return '清空中...'
      }

      if (this.modelSource === 'custom' && !this.hasSavedCustomConfig) {
        return '本工具不会收集用户任何信息，请确保填写信息有效'
      }

      if (this.lastModelLoadError) {
        return this.lastModelLoadError
      }

      if (this.modelSource === 'custom') {
        return this.savedModelSource === 'custom' ? '当前生效：自定义服务' : '当前仍使用 OpenCode 免费'
      }

      return this.savedModelSource === 'custom' ? '当前仍使用自定义服务' : '当前生效：OpenCode 免费'
    },
    modelSourceActionLabel() {
      if (this.modelSource === 'custom') {
        return this.status === 'running' ? '保存并检测' : '保存配置'
      }

      return '刷新免费模型'
    },
  },
  watch: {
    lanAccess(nextValue, previousValue) {
      if (!this.networkHydrated || this.suspendLanPersist || nextValue === previousValue) {
        return
      }
      this.applyLanAccessChange(nextValue, previousValue)
    },
  },
  async mounted() {
    await this.refreshWindowState({ includeToolStatuses: true })
    this.networkHydrated = true
    this.unlistenStatusEvent = await listen('proxy-status-changed', async (event) => {
      const running = Boolean(event?.payload?.running)
      this.status = running ? 'running' : 'stopped'
      if (Date.now() < this.suppressStatusRefreshUntil) {
        return
      }
      await this.refreshWindowState({ includeModels: false })
    })
    window.addEventListener('focus', this.handleWindowFocus)
    document.addEventListener('visibilitychange', this.handleVisibilityChange)
    this.statusTimer = setInterval(async () => {
      if (!document.hidden) {
        try {
          await this.loadStatus()
        } catch (err) {
          console.error('[UI] Status poll failed:', err)
        }
      }
    }, 30000)
  },
  beforeUnmount() {
    if (this.statusTimer) clearInterval(this.statusTimer)
    if (this.toastTimer) clearTimeout(this.toastTimer)
    if (this.refreshPulseTimer) clearTimeout(this.refreshPulseTimer)
    Object.values(this.actionDoneTimers).forEach(timer => clearTimeout(timer))
    if (this.unlistenStatusEvent) this.unlistenStatusEvent()
    window.removeEventListener('focus', this.handleWindowFocus)
    document.removeEventListener('visibilitychange', this.handleVisibilityChange)
  },
  methods: {
    async refreshWindowState(options = {}) {
      const { includeToolStatuses = false, includeModels = true } = options
      if (includeModels) {
        this.modelViewPhase = 'loading'
        this.modelsLoading = true
        this.modelsLoadingText = `正在加载 ${this.modelSourceLabel(this.modelSource)} 模型列表...`
      }
      await this.loadConfig()
      if (includeModels) {
        this.modelsLoadingText = `正在加载 ${this.modelSourceLabel(this.modelSource)} 模型列表...`
      }
      await this.syncLanIp()
      await this.loadStatus()

      const modelPromise = includeModels ? this.loadModels().catch(err => {
        console.warn('[UI] loadModels failed during refreshWindowState:', err)
      }) : Promise.resolve()

      const toolPromise = includeToolStatuses
        ? this.refreshToolStatuses().catch(err => {
            console.warn('[UI] refreshToolStatuses failed during refreshWindowState:', err)
          })
        : Promise.resolve()

      await Promise.all([modelPromise, toolPromise])
    },
    async handleWindowFocus() {
      await this.loadStatus()
    },
    async handleVisibilityChange() {
      if (!document.hidden) {
        await this.loadStatus()
      }
    },
    async loadConfig() {
      try {
        const config = await getConfig()
        const proxyConfig = config?.proxy || {}
        const backendConfig = config?.backend || {}
        const privacyConfig = config?.privacy || {}
        const uiConfig = config?.ui || {}
        const customBackend = backendConfig.custom || {}
        this.suspendLanPersist = true
        this.port = Number.isFinite(proxyConfig.port) ? proxyConfig.port : 3210
        this.lanAccess = Boolean(proxyConfig.lanAccess)
        this.apiKey = proxyConfig.apiKey || 'op-abc123def456789012345678'
        this.savedModelSource = uiConfig.modelSource === 'custom' ? 'custom' : 'opencode'
        this.privacyEnabled = privacyConfig.enabled !== false
        if (!this.modelSourceSaving) {
          this.modelSource = this.savedModelSource
        }
        this.savedCustomBaseUrl = customBackend.baseUrl || customBackend.resolvedBaseUrl || ''
        this.savedCustomApiKey = customBackend.apiKey || ''
        this.draftCustomBaseUrl = this.savedCustomBaseUrl
        this.draftCustomApiKey = this.savedCustomApiKey
        this.editingCustomConfig = false
        this.suspendLanPersist = false
      } catch (err) {
        console.error('[UI] Failed to load config:', err)
        this.apiKey = await this.resolveApiKeyFallback()
        this.port = 3210
        this.modelSource = 'opencode'
        this.savedModelSource = 'opencode'
        this.privacyEnabled = true
        this.savedCustomBaseUrl = ''
        this.savedCustomApiKey = ''
        this.draftCustomBaseUrl = ''
        this.draftCustomApiKey = ''
        this.editingCustomConfig = false
        this.suspendLanPersist = false
      }
    },
    async resolveApiKeyFallback() {
      try {
        const apiKey = await getApiKey()
        if (apiKey) return String(apiKey)
      } catch (err) {
        console.warn('[UI] Failed to resolve live API key:', err)
      }

      return 'op-abc123def456789012345678'
    },
    async loadStatus() {
      try {
        const status = await getProxyStatus()
        this.status = status.running ? 'running' : 'stopped'
        return this.status
      } catch (err) {
        console.error('[UI] Failed to load status:', err)
        return this.status
      }
    },
    setCustomCheckFeedback(type, message, details = '') {
      this.customCheckFeedback = {
        type,
        message,
        details,
      }
    },
    clearCustomCheckFeedback() {
      this.customCheckFeedback = {
        type: '',
        message: '',
        details: '',
      }
    },
    updateDraftCustomBaseUrl(value) {
      this.draftCustomBaseUrl = value
      this.clearCustomCheckFeedback()
    },
    updateDraftCustomApiKey(value) {
      this.draftCustomApiKey = value
      this.clearCustomCheckFeedback()
    },
    async toggleService() {
      const isStopping = this.status === 'running'
      this.loading = true
      this.serviceTransition = isStopping ? 'stopping' : 'starting'
      try {
        if (isStopping) {
          await stopProxy()
          this.status = 'stopped'
        } else {
          await startProxy()
          await this.loadStatus()
          await this.loadModels()
        }
      } catch (err) {
        console.error('[UI] Failed to toggle service:', err)
        alert(`操作失败: ${err}`)
      } finally {
        this.serviceTransition = null
        this.loading = false
      }
    },
    async refreshModels() {
      if (this.refreshing) return
      this.refreshing = true
      try {
        await this.fetchModels(5, {
          loadingText: `正在刷新 ${this.modelSourceLabel(this.modelSource)} 模型列表...`,
          clearOnError: false,
        })
        this.markActionDone('refresh-models')
      } finally {
        this.refreshing = false
      }
    },
    async loadModels() {
      await this.fetchModels(10, {
        loadingText: `正在加载 ${this.modelSourceLabel(this.modelSource)} 模型列表...`,
        clearOnError: false,
        notifyOnError: false,
      })
    },
    createModelLoadError(message, code = '', details = '') {
      const error = new Error(message)
      error.code = code
      if (details) {
        error.details = details
      }
      return error
    },
    normalizeToolModels(models = [], fallbackSource = '') {
      return (Array.isArray(models) ? models : []).map(model => {
        const rawId = String(model.id || '').trim()
        const hasGatewayPrefix = /^(opencode|custom)\/.+/.test(rawId)
        const source = model.source || fallbackSource || (rawId.startsWith('custom/') ? 'custom' : 'opencode')
        const upstreamId = model.upstream_id || model.upstreamId || rawId.replace(/^(opencode|custom)\//, '')
        const id = hasGatewayPrefix ? rawId : `${source}/${upstreamId}`
        return {
          id,
          name: model.name || upstreamId || id,
          source,
          upstreamId,
          inputModalities: Array.isArray(model.input_modalities) ? model.input_modalities : ['text'],
          reasoning: Boolean(model.reasoning),
          contextWindow: Number.isFinite(model.context_window) ? model.context_window : 128000,
          maxOutputTokens: Number.isFinite(model.max_output_tokens) ? model.max_output_tokens : 32000,
        }
      })
    },
    async detectCustomServiceModels(options = {}) {
      const baseUrl = String(options.baseUrl ?? this.draftCustomBaseUrl ?? this.savedCustomBaseUrl ?? '').trim()
      const apiKey = String(options.apiKey ?? this.draftCustomApiKey ?? this.savedCustomApiKey ?? '').trim()

      if (!baseUrl || !apiKey) {
        throw this.createModelLoadError('请先填写并保存自定义服务配置', 'MODEL_FETCH_CONFIG_MISSING')
      }

      try {
        const models = await detectCustomServiceModelsApi(baseUrl, apiKey)
        const normalized = this.normalizeToolModels(models, 'custom')
        if (normalized.length === 0) {
          throw this.createModelLoadError('自定义服务未返回任何可用模型。', 'MODEL_FETCH_EMPTY')
        }
        return normalized
      } catch (err) {
        if (String(err?.code || '').startsWith('MODEL_FETCH_')) {
          throw err
        }
        throw this.createModelLoadError(err?.message || String(err), 'MODEL_FETCH_DIRECT_ERROR')
      }
    },
    isLocalProxyFetchError(error) {
      return /failed to fetch|networkerror|load failed|fetch/i.test(String(error?.message || ''))
    },
    isRetriableModelLoadError(error) {
      const nonRetriableCodes = new Set([
        'MODEL_FETCH_TIMEOUT',
        'MODEL_FETCH_AUTH_ERROR',
        'MODEL_FETCH_NOT_FOUND',
        'MODEL_FETCH_NETWORK_ERROR',
        'MODEL_FETCH_HTTP_ERROR',
        'MODEL_FETCH_CONFIG_MISSING',
        'MODEL_FETCH_EMPTY',
      ])

      return !nonRetriableCodes.has(String(error?.code || ''))
    },
    describeModelLoadFailure(error, targetSource) {
      const code = String(error?.code || '')

      if (this.isLocalProxyFetchError(error)) {
        return {
          message: '本地代理暂未响应，暂时未获取到模型',
          details: '请确认服务已启动，或等待来源切换完成后再重试',
          toast: '本地代理暂未响应，请稍后重试',
        }
      }

      if (targetSource === 'custom') {
        switch (code) {
          case 'MODEL_FETCH_TIMEOUT':
            return {
              message: '连接自定义服务超时，暂时未获取到模型',
              details: [
                '请检查以下内容：',
                '- 上游模型接口在限定时间内没有返回结果',
                '- 请确认当前配置的地址可访问，且上游服务当前在线',
                '- 如需修改，请点击上方“重新配置”后重新保存检测',
              ].join('\n'),
              toast: '自定义服务检测超时，请检查配置',
            }
          case 'MODEL_FETCH_AUTH_ERROR':
            return {
              message: '自定义服务鉴权失败，暂时未获取到模型',
              details: [
                '请检查以下内容：',
                '- 当前 API Key 可能无效，或没有访问模型列表的权限',
                '- 请点击上方“重新配置”检查 API Key 后重新保存检测',
              ].join('\n'),
              toast: '自定义服务鉴权失败，请检查 API Key',
            }
          case 'MODEL_FETCH_NOT_FOUND':
            return {
              message: '当前配置未获取到可用的模型列表响应',
              details: [
                '请检查以下内容：',
                '- 上游返回了 404，模型列表地址没有返回成功结果',
                '- 可能原因：该服务不提供 OpenAI 兼容的 /models 接口',
                '- 也可能是当前填写的地址不是模型根路径',
                '- 请点击上方“重新配置”后重新保存检测',
              ].join('\n'),
              toast: '未获取到可用模型列表响应，请检查配置',
            }
          case 'MODEL_FETCH_NETWORK_ERROR':
            return {
              message: '无法连接到自定义服务上游',
              details: [
                '请检查以下内容：',
                '- 请确认域名、网络、证书或服务状态正常',
                '- 如需调整地址或密钥，请点击上方“重新配置”后重新保存检测',
              ].join('\n'),
              toast: '无法连接自定义服务，请检查网络或地址',
            }
          case 'MODEL_FETCH_EMPTY':
            return {
              message: '自定义服务未返回任何可用模型',
              details: [
                '请检查以下内容：',
                '- 上游已响应，但模型列表为空',
                '- 请确认该服务开放了模型列表接口，或点击上方“重新配置”后重新检测',
              ].join('\n'),
              toast: '自定义服务未返回模型，请检查配置',
            }
          case 'MODEL_FETCH_SOURCE_MISMATCH':
            return {
              message: error?.message || '当前代理仍未切换到自定义服务',
              details: error?.details || [
                '请检查以下内容：',
                '- 代理仍在返回 OpenCode 免费模型',
                '- 请点击上方“重新配置”后重新保存检测',
              ].join('\n'),
              toast: '自定义服务仍未真正生效',
            }
          case 'MODEL_FETCH_CONFIG_MISSING':
            return {
              message: '请先填写并保存自定义服务配置',
              details: '请补全 Base URL 和 API Key 后重新保存检测',
              toast: '请先填写自定义服务配置',
            }
          default:
            return {
              message: '自定义服务获取模型失败',
              details: [
                '请检查以下内容：',
                '- 请确认上游服务可访问，且模型列表接口返回正常',
                '- 如需调整，请点击上方“重新配置”后重新保存检测',
              ].join('\n'),
              toast: '自定义服务检测失败，请检查配置',
            }
        }
      }

      if (code === 'MODEL_FETCH_TIMEOUT') {
        return {
          message: '获取 OpenCode 免费模型超时',
          details: '请检查本机网络连通性后手动刷新',
          toast: '免费模型获取超时，请检查网络',
        }
      }

      return {
        message: error?.message || '模型列表加载失败，请检查当前上游配置或访问权限',
        details: error?.details || '请检查当前来源配置后重试',
        toast: '获取模型列表失败，请稍后重试',
      }
    },
    async fetchModels(retries = 5, options = {}) {
      this.lastModelLoadError = ''
      this.lastModelLoadDetails = ''
      let lastError = null
      const targetSource = options.source || this.modelSource
      const loadingText = options.loadingText || `正在加载 ${this.modelSourceLabel(targetSource)} 模型列表...`
      const shouldNotifyOnError = options.notifyOnError ?? Boolean(options.throwOnError || this.refreshing || this.modelSourceSaving)
      const clearOnError = options.clearOnError === true
      const existingModels = targetSource === 'custom' ? this.customModels : this.opencodeModels
      const hasExistingModels = existingModels.length > 0

      this.modelViewPhase = 'loading'
      this.modelsLoading = true
      this.modelsLoadingText = loadingText

      try {
        if (targetSource === 'custom' && !this.hasSavedCustomConfig) {
          this.customModels = []
          this.updateTime = null
          this.modelViewPhase = 'idle'
          return
        }

        if (targetSource === 'custom') {
          try {
            const nextModels = await this.detectCustomServiceModels({
              baseUrl: this.savedCustomBaseUrl,
              apiKey: this.savedCustomApiKey,
            })
            this.customModels = nextModels
            this.updateTime = Date.now()
            this.lastModelLoadError = ''
            this.lastModelLoadDetails = ''
            this.modelViewPhase = 'ready'
            this.flashModelRefresh()
          } catch (err) {
            lastError = err
            const failure = this.describeModelLoadFailure(lastError, targetSource)
            if (!clearOnError && hasExistingModels) {
              this.lastModelLoadError = ''
              this.lastModelLoadDetails = ''
              this.modelViewPhase = 'ready'
            } else {
              if (clearOnError) {
                this.customModels = []
                this.updateTime = null
              }
              this.lastModelLoadError = failure.message
              this.lastModelLoadDetails = failure.details
              this.modelViewPhase = this.lastModelLoadError ? 'error' : 'idle'
            }
            if (shouldNotifyOnError) {
              this.flashToast(failure.toast)
            }
            if (options.throwOnError) {
              throw lastError
            }
          }
          return
        }

        for (let i = 0; i < retries; i++) {
          try {
            let data
            try {
              data = await fetchProxyModels(this.port, this.apiKey)
            } catch (err) {
              if (err?.status === 401) {
                const liveApiKey = await this.resolveApiKeyFallback()
                if (liveApiKey && liveApiKey !== this.apiKey) {
                  this.apiKey = liveApiKey
                  continue
                }
              }
              throw err
            }
            const nextModels = this.normalizeToolModels(data.data || [])
            const nextOpencodeModels = nextModels.filter(model => model.source !== 'custom')
            const nextCustomModels = nextModels.filter(model => model.source === 'custom')
            const warningSources = new Set((Array.isArray(data.warnings) ? data.warnings : []).map(warning => warning?.source))
            if (targetSource === 'custom' && nextCustomModels.length === 0) {
              throw this.createModelLoadError('自定义服务未返回任何可用模型。', 'MODEL_FETCH_EMPTY')
            }
            if (!warningSources.has('opencode') || nextOpencodeModels.length > 0) {
              this.opencodeModels = nextOpencodeModels
            }
            if (!warningSources.has('custom') || nextCustomModels.length > 0) {
              this.customModels = nextCustomModels
            }
            this.updateTime = Date.now()
            this.lastModelLoadError = ''
            this.lastModelLoadDetails = ''
            this.modelViewPhase = 'ready'
            this.flashModelRefresh()
            return
          } catch (err) {
            lastError = err
            console.warn(`[fetchModels] Attempt ${i + 1}/${retries} failed:`, err.message)
            if (!this.isRetriableModelLoadError(err)) {
              break
            }
            if (i < retries - 1) await new Promise(r => setTimeout(r, 300 + i * 400))
          }
        }
        console.error('Failed to load models after retries')
        const failure = this.status === 'running'
          ? this.describeModelLoadFailure(lastError, targetSource)
          : { message: '', details: '', toast: '获取模型列表失败，请确认代理已启动' }

        if (!clearOnError && hasExistingModels) {
          this.lastModelLoadError = ''
          this.lastModelLoadDetails = ''
          this.modelViewPhase = 'ready'
        } else {
          if (clearOnError) {
            if (targetSource === 'custom') {
              this.customModels = []
            } else {
              this.opencodeModels = []
            }
            this.updateTime = null
          }
          this.lastModelLoadError = failure.message
          this.lastModelLoadDetails = failure.details
          this.modelViewPhase = this.lastModelLoadError ? 'error' : 'idle'
        }

        if (shouldNotifyOnError) {
          this.flashToast(failure.toast)
        }
        if (options.throwOnError) {
          throw lastError || new Error('获取模型列表失败')
        }
      } finally {
        this.modelsLoading = false
        this.modelsLoadingText = ''
      }
    },
    modelSourceLabel(source) {
      return source === 'custom' ? '自定义服务' : 'OpenCode 免费'
    },
    beginCustomConfigEdit() {
      if (this.modelSource !== 'custom') return
      this.editingCustomConfig = true
      this.clearCustomCheckFeedback()
      this.lastModelLoadError = ''
      this.lastModelLoadDetails = ''
      this.modelViewPhase = 'idle'
      this.modelsLoading = false
      this.modelsLoadingText = ''
    },
    async handleModelSourceChange(source) {
      const nextSource = source === 'custom' ? 'custom' : 'opencode'
      if (this.modelSource === nextSource) return

      const previousSource = this.modelSource
      this.modelSource = nextSource
      this.savedModelSource = nextSource
      this.clearCustomCheckFeedback()
      this.lastModelLoadError = ''
      this.lastModelLoadDetails = ''
      this.modelViewPhase = this.visibleModels.length > 0 ? 'ready' : 'idle'
      this.modelsLoading = false
      this.modelsLoadingText = ''
      this.editingCustomConfig = nextSource === 'custom' && !this.hasSavedCustomConfig

      try {
        await saveConfigPatch({
          ui: {
            modelSource: nextSource,
          },
        })
      } catch (err) {
        console.warn('[UI] Failed to remember model source tab:', err)
        this.savedModelSource = previousSource
      }
    },
    async restartProxyIfRunning() {
      if (this.status !== 'running') {
        return
      }

      this.loading = true
      this.serviceTransition = 'restarting'
      try {
        await stopProxy()
        await new Promise(resolve => setTimeout(resolve, 400))
        await startProxy()
        await this.loadStatus()
      } finally {
        this.serviceTransition = null
        this.loading = false
      }
    },
    async reloadProxyConfigIfRunning() {
      if (this.status !== 'running') return
      await reloadProxyConfig(this.port, this.apiKey)
    },
    async clearCustomServiceConfig() {
      if (this.modelSourceSaving || this.modelSourceClearing) return
      this.modelSourceClearing = true
      const patch = {
        backend: {
          custom: {
            baseUrl: '',
            apiKey: '',
            resolvedBaseUrl: '',
          },
        },
      }

      try {
        await saveConfigPatch(patch)
        this.modelSource = 'custom'
        this.draftCustomBaseUrl = ''
        this.draftCustomApiKey = ''
        this.savedCustomBaseUrl = ''
        this.savedCustomApiKey = ''
        this.customModels = []
        this.updateTime = null
        this.lastModelLoadError = ''
        this.lastModelLoadDetails = ''
        this.clearCustomCheckFeedback()
        this.modelViewPhase = 'idle'
        this.modelsLoading = false
        this.modelsLoadingText = ''
        this.editingCustomConfig = true
        await this.reloadProxyConfigIfRunning()
        this.markActionDone('clear-custom-config')
        this.flashToast('自定义服务配置已清空')
      } catch (err) {
        console.error('[UI] Failed to clear custom service config:', err)
        alert(`清空自定义服务配置失败：${err?.message || err}`)
      } finally {
        this.modelSourceClearing = false
      }
    },
    async saveModelSource() {
      if (this.modelSourceSaving) return
      if (this.modelSource === 'custom' && !this.canAttemptCustomService) {
        this.flashToast('请先填写 Base URL 和 API Key')
        return
      }

      this.modelSourceSaving = true
      const patch = {
        ui: {
          modelSource: this.modelSource,
        },
        backend: {
          custom: {
            baseUrl: String(this.draftCustomBaseUrl || '').trim(),
            apiKey: String(this.draftCustomApiKey || '').trim(),
            resolvedBaseUrl: '',
          },
        },
      }

      try {
        let detectedCustomModels = null
        if (this.modelSource === 'custom') {
          this.setCustomCheckFeedback(
            'loading',
            '正在检测自定义服务...',
            '正在连接上游并读取模型列表，请稍候。'
          )
          this.modelViewPhase = 'loading'
          this.modelsLoading = true
          this.modelsLoadingText = '正在检测自定义服务模型列表...'
          detectedCustomModels = await this.detectCustomServiceModels({
            baseUrl: patch.backend.custom.baseUrl,
            apiKey: patch.backend.custom.apiKey,
          })
        } else {
          this.clearCustomCheckFeedback()
        }

        await saveConfigPatch(patch)
        await this.loadConfig()
        await this.reloadProxyConfigIfRunning()

        if (this.modelSource === 'custom') {
          this.customModels = detectedCustomModels || []
          this.updateTime = Date.now()
          this.lastModelLoadError = ''
          this.lastModelLoadDetails = ''
          this.modelViewPhase = 'ready'
          this.modelsLoading = false
          this.modelsLoadingText = ''
          this.flashModelRefresh()
          this.savedModelSource = 'custom'
          this.setCustomCheckFeedback(
            'success',
            '自定义服务检测成功',
            `已获取 ${this.customModels.length} 个模型，配置已生效。`
          )
        } else {
          if (this.status === 'running') {
            await this.fetchModels(10, {
              source: this.modelSource,
              loadingText: '正在刷新 OpenCode 免费模型列表...',
            })
          } else {
            this.updateTime = null
            this.modelViewPhase = 'idle'
          }
          this.savedModelSource = this.modelSource
        }
        this.editingCustomConfig = false
        this.markActionDone('save-model-source')
        if (this.modelSource === 'custom') {
          this.flashToast(`自定义服务已生效，获取 ${this.customModels.length} 个模型`)
        } else {
          this.flashToast(`${this.modelSourceLabel(this.modelSource)} 已生效`)
        }
      } catch (err) {
        console.error('[UI] Failed to save model source:', err)
        const isModelLoadFailure = String(err?.code || '').startsWith('MODEL_FETCH_') || this.isLocalProxyFetchError(err)
        if (this.modelSource === 'custom' && isModelLoadFailure) {
          const failure = this.describeModelLoadFailure(err, 'custom')
          this.lastModelLoadError = failure.message
          this.lastModelLoadDetails = failure.details
          this.modelViewPhase = 'error'
          this.setCustomCheckFeedback('error', failure.message, failure.details)
          this.flashToast(failure.toast)
        } else {
          this.modelSource = this.savedModelSource
          this.setCustomCheckFeedback('error', '模型来源更新失败', err?.message || String(err))
          alert(`模型来源更新失败：${err?.message || err}`)
        }
      } finally {
        if (this.modelViewPhase !== 'loading') {
          this.modelsLoading = false
          this.modelsLoadingText = ''
        }
        this.modelSourceSaving = false
      }
    },
    async syncLanIp() {
      if (!this.lanAccess) {
        this.lanIp = ''
        return
      }

      try {
        this.lanIp = await invoke('get_lan_ip')
      } catch (err) {
        console.error('[UI] Failed to get LAN IP:', err)
        this.lanIp = ''
      }
    },
    async applyNetworkConfigPatch(proxyPatch, successMessage) {
      this.networkBusy = true
      try {
        await saveConfigPatch({
          proxy: {
            ...proxyPatch,
          },
        })

        if (this.status === 'running') {
          this.suppressStatusRefreshUntil = Date.now() + 5000
          await this.restartProxyIfRunning()
        }

        await this.loadConfig()
        this.flashToast(successMessage)
      } finally {
        this.networkBusy = false
      }
    },
    toggleLanAccess() {
      if (this.networkBusy) return
      this.lanAccess = !this.lanAccess
    },
    async togglePrivacyMode() {
      if (this.networkBusy) return
      const nextValue = !this.privacyEnabled
      const previousValue = this.privacyEnabled
      this.privacyEnabled = nextValue
      this.networkBusy = true
      try {
        await saveConfigPatch({
          privacy: {
            enabled: nextValue,
            redactAssistantMessages: true,
            redactToolResults: true,
            logHits: true,
          },
        })

        if (this.status === 'running') {
          this.suppressStatusRefreshUntil = Date.now() + 5000
          await this.restartProxyIfRunning()
        }

        await this.loadConfig()
        this.flashToast(nextValue ? '已开启隐私模式' : '已关闭隐私模式')
      } catch (err) {
        console.error('Failed to update privacy mode:', err)
        this.privacyEnabled = previousValue
        alert(`隐私模式更新失败: ${err}`)
      } finally {
        this.networkBusy = false
      }
    },
    async applyLanAccessChange(nextValue, previousValue) {
      try {
        await this.applyNetworkConfigPatch({
          host: nextValue ? '0.0.0.0' : '127.0.0.1',
          port: 3210,
          lanAccess: nextValue,
          apiKey: this.apiKey,
          timeout: 3000000,
        }, nextValue ? '已开启局域网访问' : '已切回仅本机访问')
      } catch (err) {
        console.error('Failed to update LAN access:', err)
        this.suspendLanPersist = true
        this.lanAccess = previousValue
        this.suspendLanPersist = false
        alert(`网络设置更新失败: ${err}`)
      }

      // 获取局域网 IP（在 catch 外面，不影响设置回滚）
      if (nextValue) {
        await this.syncLanIp()
      } else {
        this.lanIp = ''
      }
    },
    async refreshToolStatuses() {
      this.toolStatusLoading = true
      try {
        const statuses = await invoke('detect_tool_configs')
        this.toolStatuses = Array.isArray(statuses) ? statuses : []
        this.syncClaudeMappingFromStatuses(this.toolStatuses)
        this.markActionDone('refresh-tools')
      } catch (err) {
        console.error('[UI] Failed to detect tool configs:', err)
        this.flashToast('工具检测失败')
      } finally {
        this.toolStatusLoading = false
      }
    },
    formatToolVersion(version) {
      return version.replace(/^v/i, '')
    },
    formatConfigPath(path) {
      const normalized = String(path || '')
      if (!normalized) return ''

      if (normalized.startsWith('~/') || normalized.startsWith('~\\')) {
        return normalized
      }

      const unixMatch = normalized.match(/^(\/Users\/[^/]+\/|\/home\/[^/]+\/)(.*)$/)
      if (unixMatch) {
        return `~/${unixMatch[2]}`
      }

      const windowsMatch = normalized.match(/^([A-Za-z]:[\\/]Users[\\/][^\\/]+[\\/])(.*)$/)
      if (windowsMatch) {
        const separator = normalized.includes('\\') ? '\\' : '/'
        return `~${separator}${windowsMatch[2]}`
      }

      return normalized
    },
    syncClaudeMappingFromStatuses(statuses = []) {
      const claude = statuses.find(item => item.tool === 'claude')
      const mapping = claude?.claude_mapping || {}
      this.claudeMapping = {
        opus: mapping.opus || this.claudeMapping.opus,
        sonnet: mapping.sonnet || this.claudeMapping.sonnet,
        haiku: mapping.haiku || this.claudeMapping.haiku,
      }
    },
    resetClaudeMapping() {
      this.claudeMapping = {
        opus: '',
        sonnet: '',
        haiku: '',
      }
    },
    isActionDone(key) {
      return Boolean(this.actionDoneMap[key])
    },
    markActionDone(key) {
      if (!key) return
      if (this.actionDoneTimers[key]) clearTimeout(this.actionDoneTimers[key])
      this.actionDoneMap = {
        ...this.actionDoneMap,
        [key]: true,
      }
      this.actionDoneTimers[key] = setTimeout(() => {
        const nextMap = { ...this.actionDoneMap }
        delete nextMap[key]
        this.actionDoneMap = nextMap
        delete this.actionDoneTimers[key]
      }, 1600)
    },
    async openToolPath(toolKey, path) {
      if (!path) return
      try {
        await invoke('open_path_in_finder', { path: String(path) })
        this.markActionDone(`open-tool-path-${toolKey}`)
      } catch (err) {
        console.error('[UI] Failed to open tool path:', err)
        this.flashToast('打开目录失败')
      }
    },
    updateClaudeMapping(key, value) {
      this.claudeMapping = {
        ...this.claudeMapping,
        [key]: value,
      }
    },
    async applyToolConfig(tool) {
      if (this.toolActionLoading) return

      let modelsForConfig = this.allToolModels
      if (modelsForConfig.length === 0) {
        try {
          this.flashToast('正在刷新模型列表...')
          await this.loadModels()
          modelsForConfig = this.allToolModels
        } catch (err) {
          this.flashToast(`刷新模型失败：${err?.message || err}`)
          return
        }
        if (modelsForConfig.length === 0) {
          this.flashToast('请先刷新模型列表')
          return
        }
      }

      if (tool === 'claude') {
        const requiredMappings = [
          ['opus', 'Opus'],
          ['sonnet', 'Sonnet'],
          ['haiku', 'Haiku'],
        ]
        const missing = requiredMappings
          .filter(([key]) => !String(this.claudeMapping[key] || '').trim())
          .map(([, label]) => label)
        if (missing.length > 0) {
          this.flashToast(`请填写 Claude ${missing.join(' / ')} 模型 ID`)
          return
        }
        const invalid = requiredMappings
          .map(([key]) => String(this.claudeMapping[key] || '').trim())
          .filter(value => !/^(opencode|custom)\/.+/.test(value))
        if (invalid.length > 0) {
          this.flashToast('Claude 模型 ID 需要使用 opencode/ 或 custom/ 前缀')
          return
        }
        const availableIds = new Set(modelsForConfig.map(model => model.id))
        const unknown = requiredMappings
          .map(([key]) => String(this.claudeMapping[key] || '').trim())
          .filter(value => !availableIds.has(value))
        if (unknown.length > 0) {
          this.flashToast('Claude 模型 ID 不在当前模型列表中，请先刷新模型列表')
          return
        }
      }
      this.toolActionLoading = tool
      try {
        const payload = modelsForConfig.map(model => ({
          id: model.id,
          name: model.name,
          input_modalities: model.inputModalities,
          reasoning: model.reasoning,
          context_window: model.contextWindow,
          max_output_tokens: model.maxOutputTokens,
        }))
        const status = await invoke('configure_tool', {
          tool,
          models: payload,
          claudeMapping: tool === 'claude' ? {
            opus: String(this.claudeMapping.opus || '').trim(),
            sonnet: String(this.claudeMapping.sonnet || '').trim(),
            haiku: String(this.claudeMapping.haiku || '').trim(),
          } : null,
        })
        this.toolStatuses = this.toolStatuses.map(item => item.tool === tool ? status : item)
        if (tool === 'claude') {
          this.syncClaudeMappingFromStatuses(this.toolStatuses)
        }
        this.markActionDone(`tool-config-${tool}`)
        this.flashToast(`${status.label} 已接入 OpenProxy`)
      } catch (err) {
        console.error('[UI] Failed to configure tool:', err)
        alert(`工具配置失败: ${err?.message || err}`)
      } finally {
        this.toolActionLoading = null
      }
    },
    flashToast(message) {
      this.toastText = message
      this.showCopyToast = true
      if (this.toastTimer) clearTimeout(this.toastTimer)
      this.toastTimer = setTimeout(() => {
        this.showCopyToast = false
      }, 2000)
    },
    flashModelRefresh() {
      this.refreshPulseVisible = true
      if (this.refreshPulseTimer) clearTimeout(this.refreshPulseTimer)
      this.refreshPulseTimer = setTimeout(() => {
        this.refreshPulseVisible = false
      }, 1800)
    },
    formatModelCapabilities(model) {
      const capabilities = Array.isArray(model?.inputModalities) && model.inputModalities.length > 0
        ? model.inputModalities
        : ['text']

      return capabilities.join('/')
    },
    async copyText(text, message = '已复制到剪贴板', actionKey = null) {
      try {
        await invoke('copy_to_clipboard', { text: String(text ?? '') })
        this.markActionDone(actionKey)
        this.flashToast(message)
      } catch (err) {
        console.error('[UI] Native clipboard copy failed:', err)
        this.flashToast('复制失败，请手动复制')
      }
    },
  },
}
</script>

<style>
:root {
  color-scheme: dark;
  --font-xs: 9px;
  --font-sm: 10px;
  --font-md: 11px;
  --font-lg: 13px;
  --font-xl: 15px;
}

* {
  box-sizing: border-box;
}

html,
body,
#app {
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: transparent;
}

body {
  margin: 0;
  font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: transparent;
  color: #f7f3ea;
  user-select: none;
  -webkit-user-select: none;
  -moz-user-select: none;
  -ms-user-select: none;
}

button,
input {
  font: inherit;
}

.popover-shell {
  height: 100vh;
  padding: 8px;
  overflow: hidden;
  background: transparent;
}

.panel-frame {
  height: 100%;
  border-radius: 18px;
  overflow: hidden;
  background: #3e2f24;
  border: 1px solid #5a4534;
  box-shadow:
    0 4px 16px rgba(0, 0, 0, 0.18),
    0 1px 3px rgba(0, 0, 0, 0.12);
}

.panel-surface {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  padding: 10px;
  border-radius: inherit;
  overflow: hidden;
  background: linear-gradient(170deg, #3a2c22 0%, #35281f 100%);
}

.panel-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-bottom: 4px;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.panel-body::-webkit-scrollbar {
  display: none;
}

.panel-surface::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  border-radius: inherit;
  border: 1px solid rgba(255, 244, 228, 0.12);
  background:
    radial-gradient(circle at 20% 0%, rgba(255, 244, 228, 0.08), transparent 34%),
    linear-gradient(180deg, rgba(255, 244, 228, 0.05), transparent 28%);
}

.panel-header,
.brand-block,
.mini-head,
.section-head,
.panel-footer {
  display: flex;
  align-items: center;
}

.panel-header,
.mini-head,
.section-head,
.panel-footer {
  justify-content: space-between;
}

.brand-block {
  gap: 10px;
}

.brand-mark {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
}

.brand-logo {
  width: 44px;
  height: 44px;
  display: block;
  filter: drop-shadow(0 8px 18px rgba(0, 0, 0, 0.18));
}

.brand-copy h1 {
  margin: 2px 0 1px;
  font-size: var(--font-xl);
  line-height: 1.05;
}

.brand-copy p,
.mini-copy,
.section-note,
.panel-footer p,
.mini-note {
  margin: 0;
  color: rgba(247, 243, 234, 0.72);
  font-size: var(--font-xs);
  line-height: 1.35;
}

.eyebrow {
  font-size: var(--font-xs);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgba(247, 243, 234, 0.9);
}

.status-pill,
.tag,
.mini-chip,
.mini-state,
.tiny-button,
.footer-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
}

.status-pill {
  min-height: 23px;
  padding: 0 9px;
  background: rgba(255, 255, 255, 0.06);
  font-size: var(--font-sm);
  font-weight: 600;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
}

.status-pill.running,
.mini-state.running,
.mini-chip-ready {
  color: #8be0ad;
}

.status-pill.stopped,
.mini-state.stopped {
  color: #f2d1bf;
}

.status-pill.checking,
.mini-state.checking {
  color: #f0c27b;
}

.tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.tag,
.mini-chip,
.mini-state {
  min-height: 19px;
  padding: 0 7px;
  background: rgba(255, 255, 255, 0.055);
  color: rgba(247, 243, 234, 0.76);
  font-size: var(--font-xs);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.07);
}

.tag-active,
.tiny-button-accent {
  color: #f0c27b;
  border-color: rgba(240, 194, 123, 0.18);
  background: rgba(240, 194, 123, 0.08);
}

.tiny-button-done {
  color: #8be0ad !important;
  background: rgba(139, 224, 173, 0.14) !important;
  box-shadow: inset 0 0 0 1px rgba(139, 224, 173, 0.24) !important;
}

.endpoint-banner,
.mini-card,
.tool-section {
  background: linear-gradient(180deg, #49392d 0%, #423227 100%);
  border-radius: 14px;
  border: 1px solid #604a38;
  box-shadow:
    0 2px 8px rgba(0, 0, 0, 0.14),
    inset 0 1px 0 rgba(255, 244, 228, 0.08);
}

.endpoint-banner {
  padding: 9px;
}

.endpoint-stack {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.endpoint-copy-secondary code {
  color: rgba(247, 243, 234, 0.84);
}

.endpoint-copy code {
  display: block;
  padding: 9px 10px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.06);
  color: #f7f3ea;
  font-family: 'SFMono-Regular', SFMono-Regular, ui-monospace, Menlo, Consolas, monospace;
  font-size: var(--font-md);
  overflow: hidden;
  text-overflow: ellipsis;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.045);
}

.endpoint-field {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.endpoint-field code {
  flex: 1;
  min-width: 0;
}

.tiny-button.endpoint-copy-button {
  flex: none;
  font-size: var(--font-sm);
}

.tiny-button.btn-refresh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: var(--font-sm);
  min-width: 84px;
  text-align: center;
}

.tiny-button.btn-refresh:hover,
.tiny-button.model-item-copy:hover,
.tiny-button.endpoint-copy-button:hover {
  transform: none;
}

.mini-actions,
.tool-grid {
  display: flex;
  gap: 6px;
}

.panel-actions {
  display: flex;
  justify-content: center;
  margin-top: 8px;
}

.panel-actions .action-button-primary {
  width: auto;
  min-width: 120px;
}

.action-button,
.tool-tile {
  appearance: none;
  border: 0;
  cursor: pointer;
  color: #f7f3ea;
  transition: transform 0.16s ease, opacity 0.16s ease, background 0.16s ease;
}

.action-button:hover,
.tool-tile:hover,
.tiny-button:hover,
.footer-button:hover {
  transform: translateY(-1px);
}

.action-button:hover {
  transform: none;
}

.action-button:disabled,
.tiny-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.action-button {
  min-width: 98px;
  min-height: 26px;
  border-radius: 10px;
  padding: 0 10px;
  font-size: var(--font-sm);
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.action-button-primary {
  background: linear-gradient(135deg, #f0c27b, #b07d43);
  color: #22180f;
  font-weight: 700;
}

.btn-icon {
  font-size: 12px;
  line-height: 1;
  opacity: 0.8;
}

.power-icon {
  display: inline-block;
  width: 10px;
  height: 10px;
  border: 1.5px solid currentColor;
  border-radius: 50%;
  position: relative;
}

.power-icon::after {
  content: '';
  position: absolute;
  top: -2px;
  left: 3px;
  width: 2px;
  height: 7px;
  background: currentColor;
}

.btn-icon-shell {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
}

.action-button-label {
  min-width: 34px;
  text-align: center;
}

.action-button-loading {
  opacity: 0.92;
}

.inline-spinner {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  border: 1.5px solid rgba(247, 243, 234, 0.25);
  border-top-color: currentColor;
  flex: none;
}

.spinning {
  animation: spin 0.8s linear infinite;
}

.action-button-danger {
  background: linear-gradient(135deg, #f2a173, #d86a4a);
  color: #20130d;
}

.action-button-ghost {
  background: rgba(255, 255, 255, 0.06);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
}

.card-grid {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.info-grid {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.mini-card {
  padding: 9px;
}

.network-strip {
  padding: 6px 8px;
  background: linear-gradient(180deg, #443428 0%, #3f3026 100%);
  border-radius: 12px;
  border: 1px solid #5d4736;
}

.network-inline-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
}

.network-toggle-group {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  min-width: 0;
}

.network-inline-row > .action-button {
  flex-shrink: 0;
}

.network-item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.network-item-port {
  gap: 6px;
  flex-wrap: nowrap;
}

.pill-port {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 52px;
  height: 24px;
  padding: 0 10px;
  border-radius: 10px;
  background: rgba(240, 194, 123, 0.15);
  color: #f0c27b;
  font-family: 'SFMono-Regular', SFMono-Regular, ui-monospace, Menlo, Consolas, monospace;
  font-size: var(--font-md);
  font-weight: 600;
  letter-spacing: 0.05em;
  box-shadow: inset 0 0 0 1px rgba(240, 194, 123, 0.2);
}

.icon-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  width: 100%;
  min-width: 0;
  min-height: 26px;
  padding: 0 8px;
  border: none;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(247, 243, 234, 0.72);
  cursor: pointer;
  transition: all 0.2s ease;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
}

.icon-toggle:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
  color: rgba(247, 243, 234, 0.8);
}

.icon-toggle:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.icon-toggle-active {
  background: rgba(139, 224, 173, 0.15);
  color: #8be0ad;
  box-shadow: inset 0 0 0 1px rgba(139, 224, 173, 0.25);
}

.icon-toggle-active:hover:not(:disabled) {
  background: rgba(139, 224, 173, 0.22);
}

.toggle-icon {
  font-size: var(--font-lg);
  line-height: 1;
}

.toggle-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-sm);
  font-weight: 600;
  letter-spacing: 0.03em;
}

.network-item-label {
  font-size: var(--font-sm);
  color: rgba(247, 243, 234, 0.72);
  white-space: nowrap;
}

.network-title {
  flex: none;
  font-size: 10px;
  font-weight: 600;
  color: #fff4e4;
}

.network-port-value {
  font-size: 12px;
  line-height: 1;
  color: #fff4e4;
}

.mini-head {
  gap: 6px;
  margin-bottom: 6px;
}

.model-head-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: 6px;
}

.model-refresh-badge {
  color: #8be0ad;
  font-size: var(--font-xs);
  white-space: nowrap;
}

.model-summary-row {
  min-height: 16px;
  margin-bottom: 6px;
}

.mini-head > span:first-child,
.section-head h2,
.setting-line strong {
  font-size: var(--font-md);
  font-weight: 600;
}

.mini-metric {
  display: block;
  margin-bottom: 5px;
  font-size: 17px;
  line-height: 1;
  color: #fff6e9;
}

.mini-metric-model {
  font-size: 13px;
  line-height: 1.2;
}

.mini-actions {
  margin-top: 6px;
}

.mini-actions-wrap {
  flex-wrap: wrap;
}

.tiny-button,
.footer-button {
  appearance: none;
  border: 0;
  min-width: 44px;
  min-height: 22px;
  padding: 0 7px;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.08);
  color: #f7f3ea;
  font-size: var(--font-sm);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
}

.switch {
  cursor: pointer;
}

.switch input {
  display: none;
}

.switch-track {
  display: inline-flex;
  align-items: center;
  width: 32px;
  height: 18px;
  padding: 2px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
}

.switch-knob {
  width: 12px;
  height: 12px;
  border-radius: 999px;
  background: #f7f3ea;
  transition: transform 0.16s ease;
}

.switch input:checked + .switch-track {
  background: rgba(240, 194, 123, 0.24);
  border-color: rgba(240, 194, 123, 0.2);
}

.switch input:checked + .switch-track .switch-knob {
  transform: translateX(14px);
}

.port-field {
  width: 68px;
  min-height: 26px;
  padding: 0 8px;
  border: none;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.06);
  color: #f7f3ea;
  text-align: center;
  font-size: var(--font-sm);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.075);
}

.port-field:focus {
  outline: none;
  box-shadow: inset 0 0 0 1px rgba(240, 194, 123, 0.4);
}

.port-field:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.mini-note {
  margin-top: 8px;
}

.mini-note-error {
  color: #ffbda6;
}

.mini-note-warn {
  color: #f0c27b;
}

.tool-section {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 240px;
  padding: 8px;
  margin-top: 2px;
}

.tool-status-note {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-xs);
  color: rgba(247, 243, 234, 0.72);
}

.model-card {
  display: flex;
  flex-direction: column;
  height: 236px;
  min-height: 236px;
  max-height: 236px;
  overflow: hidden;
}


.model-card-head {
  display: block;
  align-items: center;
}

.model-source-toggle {
  display: inline-flex;
  align-items: center;
  padding: 2px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.05);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.07);
}

.model-source-button {
  appearance: none;
  border: 0;
  min-height: 24px;
  padding: 0 8px;
  border-radius: 8px;
  background: transparent;
  color: rgba(247, 243, 234, 0.68);
  font-size: var(--font-xs);
  cursor: pointer;
  transition: background 0.16s ease, color 0.16s ease;
}

.model-source-button-active {
  background: rgba(240, 194, 123, 0.18);
  color: #fff4e4;
}

.model-head-buttons {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.model-upstream-form {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-bottom: 8px;
  padding: 7px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.04);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
}

.model-form-line {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.model-form-label {
  font-size: var(--font-xs);
  color: rgba(247, 243, 234, 0.72);
}

.model-form-field {
  width: 100%;
  min-height: 28px;
  padding: 0 10px;
  border: none;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.06);
  color: #f7f3ea;
  font-size: var(--font-sm);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.075);
}

.model-form-field:focus {
  outline: none;
  box-shadow: inset 0 0 0 1px rgba(240, 194, 123, 0.4);
}

.model-form-field:disabled {
  opacity: 0.65;
  cursor: not-allowed;
}

.model-form-feedback {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 8px;
  border-radius: 10px;
  font-size: var(--font-xs);
  line-height: 1.35;
  text-align: left;
}

.model-form-feedback-loading {
  color: #f0c27b;
  background: rgba(240, 194, 123, 0.1);
  box-shadow: inset 0 0 0 1px rgba(240, 194, 123, 0.22);
}

.model-form-feedback-success {
  color: #8be0ad;
  background: rgba(139, 224, 173, 0.1);
  box-shadow: inset 0 0 0 1px rgba(139, 224, 173, 0.22);
}

.model-form-feedback-error {
  color: #ffbda6;
  background: rgba(242, 161, 115, 0.1);
  box-shadow: inset 0 0 0 1px rgba(242, 161, 115, 0.22);
}

.feedback-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  flex: none;
  margin-top: 1px;
}

.feedback-icon-text {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 800;
  background: rgba(255, 255, 255, 0.09);
}

.feedback-copy {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.feedback-msg,
.feedback-details {
  overflow-wrap: anywhere;
}

.feedback-details {
  color: rgba(247, 243, 234, 0.68);
}

.model-form-actions {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  text-align: center;
}

.model-form-button-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex-wrap: nowrap;
}

.model-form-button-row .tiny-button {
  min-width: 88px;
  justify-content: center;
  white-space: nowrap;
}

.model-form-hint {
  margin: 0;
  padding: 0 8px;
  font-size: var(--font-sm);
  color: rgba(247, 243, 234, 0.65);
  line-height: 1.4;
  text-align: center;
}

.model-form-actions-compact {
  margin-bottom: 8px;
}

.model-save-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 112px;
}

.model-source-status {
  font-size: var(--font-xs);
  color: rgba(247, 243, 234, 0.62);
  text-align: center;
}

.model-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1;
  min-height: 0;
  max-height: none;
  overflow-y: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.model-list::-webkit-scrollbar {
  display: none;
}

.model-list-shell {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  transition: box-shadow 0.16s ease;
}

.model-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: 6px;
  background: rgba(247, 243, 234, 0.055);
  border: 1px solid rgba(247, 243, 234, 0.1);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.model-item:hover {
  background: rgba(247, 243, 234, 0.08);
}

.model-item-name {
  flex: 1;
  min-width: 0;
  font-size: var(--font-md);
  color: rgba(247, 243, 234, 0.9);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.model-item-id {
  flex: none;
  font-size: var(--font-xs);
  color: rgba(247, 243, 234, 0.52);
  white-space: nowrap;
}

.model-item-copy {
  flex-shrink: 0;
}

.model-card .model-empty-msg {
  display: flex !important;
  flex: 1;
  width: 100%;
  align-items: center;
  justify-content: center;
  min-height: 0;
  margin: 0 !important;
  font-size: var(--font-md);
  color: rgba(247, 243, 234, 0.62);
  white-space: pre-line;
  text-align: center;
  -webkit-line-clamp: unset !important;
  -webkit-box-orient: unset !important;
}

.model-loading-state {
  display: flex;
  flex: 1;
  width: 100%;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: rgba(247, 243, 234, 0.72);
  font-size: var(--font-sm);
  text-align: center;
}

.model-loading-text {
  max-width: 220px;
  line-height: 1.4;
}

.model-summary-text {
  display: inline-block;
  font-size: var(--font-xs);
  color: rgba(247, 243, 234, 0.62);
  transition: color 0.18s ease;
}

.model-summary-bar {
  flex: none;
  min-height: 16px;
  margin-bottom: 8px;
}

.model-refresh-badge {
  opacity: 0;
  transition: opacity 0.16s ease;
}

.model-refresh-badge-visible {
  opacity: 1;
}

.model-summary-text-active {
  color: #8be0ad;
}

.model-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.model-main {
  flex: 1;
  min-width: 0;
}

.model-id {
  display: block;
  margin-top: 6px;
  padding: 10px 11px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.14);
  color: #f7f3ea;
  font-family: 'SFMono-Regular', SFMono-Regular, ui-monospace, Menlo, Consolas, monospace;
  font-size: 9px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.045);
}

.model-copy {
  margin-bottom: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.model-card .mini-note {
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.section-head {
  margin-bottom: 8px;
}

.section-head h2 {
  margin: 3px 0 0;
  font-size: 12px;
  color: #fff4e4;
}

.tool-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}

.tool-stack {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.tool-stack::-webkit-scrollbar {
  display: none;
}

.tool-card {
  padding: 10px;
  border-radius: 12px;
  background: linear-gradient(180deg, #413127 0%, #3a2c22 100%);
  box-shadow:
    0 2px 6px rgba(0, 0, 0, 0.12),
    inset 0 1px 0 rgba(255, 244, 228, 0.07);
}

.tool-card-row {
  display: flex;
  align-items: center;
}

.tool-card-row {
  justify-content: space-between;
  gap: 6px;
  min-height: 28px;
}

.tool-card-heading {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  flex: 1;
  min-width: 0;
}

.tool-card-title {
  flex: none;
  min-width: 0;
  font-size: var(--font-md);
  color: #fff4e4;
  white-space: nowrap;
}

.tool-card-version {
  flex: none;
  min-height: 18px;
  display: inline-flex;
  align-items: center;
  padding: 0 7px;
  border-radius: 999px;
  font-size: var(--font-xs);
  font-weight: 700;
  color: #f0c27b;
  margin-left: 6px;
  white-space: nowrap;
  background: rgba(240, 194, 123, 0.12);
  box-shadow: inset 0 0 0 1px rgba(240, 194, 123, 0.24);
}

.tool-card-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
}

.tool-card-details {
  margin-top: 7px;
}

.tool-info-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tool-info-line {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr);
  gap: 8px;
  align-items: center;
}

.tool-info-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.tool-info-label {
  display: inline-flex;
  align-items: center;
  font-size: var(--font-xs);
  line-height: 1.5;
  color: rgba(247, 243, 234, 0.56);
  letter-spacing: 0.04em;
}

.tool-info-value {
  display: inline-flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  font-size: var(--font-sm);
  line-height: 1.45;
  color: rgba(247, 243, 234, 0.88);
  word-break: break-all;
}

.tool-info-value-warn {
  color: #f0c27b;
}

.tool-info-path {
  color: rgba(247, 243, 234, 0.72);
}





.tool-card-button {
  flex: none;
}

.tool-card-button-success {
  color: #8be0ad;
  background: rgba(139, 224, 173, 0.12);
  box-shadow: inset 0 0 0 1px rgba(139, 224, 173, 0.2);
}

.tool-card-button-danger {
  color: #f2a173;
  background: rgba(242, 161, 115, 0.12);
  box-shadow: inset 0 0 0 1px rgba(242, 161, 115, 0.2);
}

.tool-inline-button {
  flex: none;
  min-width: 44px;
}



.claude-mapping-select {
  width: 100%;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  border: 1px solid rgba(255, 244, 228, 0.12);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  color: #fff4e4;
  outline: none;
}

.claude-mapping-select option {
  background: #2a2a3a;
  color: #fff4e4;
}

.claude-mapping-select:focus {
  border-color: rgba(240, 194, 123, 0.5);
  box-shadow: 0 0 0 2px rgba(240, 194, 123, 0.12);
}

.tool-tile {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  width: 100%;
  min-height: 48px;
  padding: 7px 7px 6px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.05);
  text-align: left;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.05);
}

.tool-tile strong {
  font-size: 8px;
  line-height: 1.2;
}

.tool-tile span {
  margin-top: 3px;
  color: rgba(247, 243, 234, 0.56);
  font-size: 9px;
  line-height: 1.25;
}

.panel-footer {
  justify-content: center;
  flex: none;
  padding-top: 2px;
  padding-bottom: 2px;
  text-align: center;
}

.toast {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: 10px;
  min-height: 34px;
  display: grid;
  place-items: center;
  padding: 0 12px;
  border-radius: 11px;
  background: rgba(70, 49, 31, 0.98);
  border: 1px solid rgba(240, 194, 123, 0.4);
  color: #fff5e9;
  font-size: var(--font-sm);
  font-weight: 600;
  letter-spacing: 0.02em;
  box-shadow:
    0 12px 28px rgba(0, 0, 0, 0.34),
    inset 0 1px 0 rgba(255, 244, 228, 0.08);
  z-index: 5;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }

  to {
    transform: rotate(360deg);
  }
}

@media (max-height: 760px) {
  :root {
    --font-xs: 8px;
    --font-sm: 9px;
    --font-md: 10px;
    --font-lg: 12px;
    --font-xl: 14px;
  }

  .popover-shell {
    padding: 6px;
  }

  .panel-surface {
    gap: 8px;
    padding: 8px;
  }

  .panel-body,
  .info-grid,
  .card-grid {
    gap: 8px;
  }

  .brand-logo {
    width: 38px;
    height: 38px;
  }

  .endpoint-banner,
  .mini-card,
  .tool-section {
    padding: 7px;
  }

  .model-card {
    height: 200px;
    min-height: 200px;
    max-height: 200px;
  }

  .tool-section {
    min-height: 190px;
  }

  .tool-card {
    padding: 8px;
  }

  .panel-footer {
    display: none;
  }
}

@media (max-width: 360px) {
  .panel-actions,
  .panel-footer {
    flex-direction: column;
    align-items: stretch;
  }

  .endpoint-field,
  .model-row,
  .network-item {
    flex-direction: column;
    align-items: stretch;
  }

  .network-inline-row,
  .network-toggle-group {
    grid-template-columns: 1fr;
  }

  .tool-grid {
    grid-template-columns: 1fr;
  }

  .action-button,
  .panel-actions .action-button-primary {
    width: 100%;
  }

  .endpoint-copy-button,
  .port-field {
    width: 100%;
  }
}
</style>

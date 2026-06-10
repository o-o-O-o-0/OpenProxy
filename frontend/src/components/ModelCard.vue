<template>
  <article class="mini-card model-card">
    <div class="mini-head compact-head model-card-head">
      <div class="model-head-actions">
        <div class="model-source-toggle" role="tablist" aria-label="模型来源切换">
          <button
            type="button"
            :class="['model-source-button', { 'model-source-button-active': currentSource === 'opencode' }]"
            :disabled="sourceSaving || sourceClearing"
            @click="$emit('update-draft-source', 'opencode')"
          >OpenCode 免费</button>
          <button
            type="button"
            :class="['model-source-button', { 'model-source-button-active': currentSource === 'custom' }]"
            :disabled="sourceSaving || sourceClearing"
            @click="$emit('update-draft-source', 'custom')"
          >自定义服务</button>
        </div>
        <div class="model-head-buttons">
          <button
            v-if="showCustomEditButton"
            class="tiny-button"
            type="button"
            :disabled="sourceSaving || sourceClearing"
            @click="$emit('edit-custom-config')"
          >{{ customEditButtonLabel }}</button>
          <button
            :class="['tiny-button', 'btn-refresh', { 'tiny-button-done': isActionDone('refresh-models') && !refreshing }]"
            :aria-busy="refreshing"
            :disabled="refreshing || sourceSaving || sourceClearing"
            @click="$emit('refresh-models')"
          >
            <span :class="['inline-spinner', { spinning: refreshing }]" aria-hidden="true"></span>
            <span>{{ refreshing ? '刷新中' : '刷新' }}</span>
          </button>
        </div>
      </div>
    </div>

    <div class="model-summary-bar">
      <span :class="['model-summary-text', { 'model-summary-text-active': refreshPulseVisible }]">{{ modelSummary }}</span>
    </div>

    <div v-if="showCustomForm" class="model-upstream-form">
      <label class="model-form-line">
        <span class="model-form-label">接口地址</span>
        <input
          :value="draftCustomBaseUrl"
          class="model-form-field"
          type="text"
          placeholder="https://api.example.com 或 https://api.example.com/v1"
          :disabled="sourceSaving"
          @input="$emit('update-draft-custom-base-url', $event.target.value)"
          @keydown.enter.prevent="$emit('save-source')"
        />
      </label>

      <label class="model-form-line">
        <span class="model-form-label">请求密钥</span>
        <input
          :value="draftCustomApiKey"
          class="model-form-field"
          type="password"
          placeholder="sk-..."
          :disabled="sourceSaving"
          @input="$emit('update-draft-custom-api-key', $event.target.value)"
          @keydown.enter.prevent="$emit('save-source')"
        />
      </label>

      <div
        v-if="customCheckFeedback.message"
        :class="['model-form-feedback', `model-form-feedback-${customCheckFeedback.type}`]"
      >
        <span class="feedback-icon">
          <span v-if="customCheckFeedback.type === 'loading'" class="inline-spinner spinning"></span>
          <span v-else-if="customCheckFeedback.type === 'success'" class="feedback-icon-text">✓</span>
          <span v-else class="feedback-icon-text">!</span>
        </span>
        <span class="feedback-copy">
          <strong class="feedback-msg">{{ customCheckFeedback.message }}</strong>
          <small v-if="customCheckFeedback.details" class="feedback-details">{{ customCheckFeedback.details }}</small>
        </span>
      </div>

      <div class="model-form-actions">
        <div class="model-form-button-row">
          <button
            v-if="showCustomForm"
            class="tiny-button"
            type="button"
            :disabled="sourceSaving || sourceClearing || !canClearCustomConfig"
            @click="$emit('clear-custom-config')"
          >{{ sourceClearing ? '清空中' : '清空配置' }}</button>
          <button
            :class="['tiny-button', 'tiny-button-accent', 'model-save-button', { 'tiny-button-done': isActionDone('save-model-source') && !sourceSaving }]"
            :disabled="sourceSaving || sourceClearing || !canSaveSource"
            @click="$emit('save-source')"
          >
            <span v-if="sourceSaving" :class="['inline-spinner', 'spinning']" aria-hidden="true"></span>
            <span>{{ sourceSaving ? '检测中...' : sourceActionLabel }}</span>
          </button>
        </div>
        <span v-if="sourceStatusText && !customCheckFeedback.message" class="model-source-status">{{ sourceStatusText }}</span>
      </div>
    </div>

    <div v-if="!showCustomForm" class="model-list-shell">
      <div v-if="showModelLoadingState" class="model-loading-state">
        <span class="inline-spinner spinning" aria-hidden="true"></span>
        <span class="model-loading-text">{{ modelLoadingText }}</span>
      </div>

      <div v-else-if="models.length > 0" class="model-list">
        <div
          v-for="model in models"
          :key="model.id"
          class="model-item"
        >
          <span class="model-item-name">{{ model.id }}</span>
          <span class="model-item-id">{{ formatModelCapabilities(model) }}</span>
          <button
            :class="['tiny-button', 'model-item-copy', { 'tiny-button-done': isActionDone(`copy-model-${model.id}`) }]"
            @click.stop="$emit('copy-model', model.id)"
          >复制</button>
        </div>
      </div>

      <p v-else-if="modelEmptyMessage" class="mini-note model-empty-msg">{{ modelEmptyMessage }}</p>
    </div>
  </article>
</template>

<script setup>
defineEmits([
  'refresh-models',
  'copy-model',
  'update-draft-source',
  'edit-custom-config',
  'update-draft-custom-base-url',
  'update-draft-custom-api-key',
  'save-source',
  'clear-custom-config',
])

defineProps({
  models: {
    type: Array,
    required: true,
  },
  refreshing: {
    type: Boolean,
    required: true,
  },
  refreshPulseVisible: {
    type: Boolean,
    required: true,
  },
  modelSummary: {
    type: String,
    required: true,
  },
  modelEmptyMessage: {
    type: String,
    required: true,
  },
  showModelLoadingState: {
    type: Boolean,
    required: true,
  },
  modelLoadingText: {
    type: String,
    required: true,
  },
  currentSource: {
    type: String,
    required: true,
  },
  showCustomForm: {
    type: Boolean,
    required: true,
  },
  showCustomEditButton: {
    type: Boolean,
    required: true,
  },
  customEditButtonLabel: {
    type: String,
    required: true,
  },
  draftCustomBaseUrl: {
    type: String,
    required: true,
  },
  draftCustomApiKey: {
    type: String,
    required: true,
  },
  sourceSaving: {
    type: Boolean,
    required: true,
  },
  sourceClearing: {
    type: Boolean,
    required: true,
  },
  canSaveSource: {
    type: Boolean,
    required: true,
  },
  canClearCustomConfig: {
    type: Boolean,
    required: true,
  },
  sourceActionLabel: {
    type: String,
    required: true,
  },
  sourceStatusText: {
    type: String,
    required: true,
  },
  customCheckFeedback: {
    type: Object,
    required: true,
  },
  isActionDone: {
    type: Function,
    required: true,
  },
  formatModelCapabilities: {
    type: Function,
    required: true,
  },
})
</script>

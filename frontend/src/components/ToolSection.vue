<template>
  <section class="tool-section">
    <div class="section-head">
      <div>
        <h2>接入常用工具</h2>
      </div>
      <button
        :class="['tiny-button', { 'tiny-button-done': isActionDone('refresh-tools') && !toolStatusLoading }]"
        @click="$emit('refresh-tools')"
      >{{ toolStatusLoading ? '检测中' : '手动检测' }}</button>
    </div>

    <div v-if="toolStatusLoading" class="tool-status-note">
      <span class="inline-spinner spinning" aria-hidden="true"></span>
      <span>正在检测已安装工具与上游能力...</span>
    </div>

    <p v-else-if="toolStatuses.length === 0" class="tool-status-note">
      暂未检测到已安装的常用工具
    </p>

    <div v-else class="tool-stack">
      <article v-for="tool in toolStatuses" :key="tool.tool" class="tool-card">
        <div class="tool-card-row">
          <div class="tool-card-heading">
            <strong class="tool-card-title">{{ tool.label }}</strong>
            <span v-if="tool.version" class="tool-card-version">v{{ formatToolVersion(tool.version) }}</span>
          </div>
          <button
            :class="['tiny-button', 'tiny-button-accent', 'tool-card-button', { 'tiny-button-done': isActionDone(`tool-config-${tool.tool}`) && toolActionLoading !== tool.tool }]"
            :disabled="!tool.installed || !tool.supported || toolActionLoading === tool.tool"
            @click="$emit('apply-tool-config', tool.tool)"
          >
            <span v-if="toolActionLoading === tool.tool" :class="['inline-spinner', 'spinning']" aria-hidden="true"></span>
            <span>{{ toolActionLoading === tool.tool ? '配置中' : tool.configured ? '重配' : '配置' }}</span>
          </button>
        </div>

        <div class="tool-card-details">
          <div class="tool-info-grid">
            <div v-if="tool.binary_path" class="tool-info-line">
              <span class="tool-info-label">命令</span>
              <div class="tool-info-main">
                <span class="tool-info-value tool-info-path">{{ formatConfigPath(tool.binary_path) }}</span>
              </div>
            </div>

            <div class="tool-info-line">
              <span class="tool-info-label">配置</span>
              <div class="tool-info-main">
                <span class="tool-info-value tool-info-path">{{ formatConfigPath(tool.config_path) }}</span>
                <button
                  :class="['tiny-button', 'tool-inline-button', { 'tiny-button-done': isActionDone(`open-tool-path-${tool.tool}`) }]"
                  :disabled="!tool.config_path"
                  @click="$emit('open-tool-path', { toolKey: tool.tool, path: tool.config_path })"
                >打开</button>
              </div>
            </div>

            <div v-if="!tool.supported && tool.support_reason" class="tool-info-line">
              <span class="tool-info-label">原因</span>
              <div class="tool-info-main">
                <span class="tool-info-value tool-info-reason">{{ tool.support_reason }}</span>
              </div>
            </div>

            <template v-if="tool.tool === 'claude'">
              <div class="tool-info-line">
                <span class="tool-info-label">Opus</span>
                <div class="tool-info-main">
                  <input
                    class="claude-mapping-input"
                    :value="claudeMapping.opus"
                    placeholder="输入 Opus 模型 ID"
                    @input="$emit('update-claude-mapping', { key: 'opus', value: $event.target.value })"
                  />
                </div>
              </div>
              <div class="tool-info-line">
                <span class="tool-info-label">Sonnet</span>
                <div class="tool-info-main">
                  <input
                    class="claude-mapping-input"
                    :value="claudeMapping.sonnet"
                    placeholder="输入 Sonnet 模型 ID"
                    @input="$emit('update-claude-mapping', { key: 'sonnet', value: $event.target.value })"
                  />
                </div>
              </div>
              <div class="tool-info-line">
                <span class="tool-info-label">Haiku</span>
                <div class="tool-info-main">
                  <input
                    class="claude-mapping-input"
                    :value="claudeMapping.haiku"
                    placeholder="输入 Haiku 模型 ID"
                    @input="$emit('update-claude-mapping', { key: 'haiku', value: $event.target.value })"
                  />
                </div>
              </div>
            </template>
          </div>
        </div>
      </article>
    </div>
  </section>
</template>

<script setup>
defineEmits([
  'refresh-tools',
  'apply-tool-config',
  'open-tool-path',
  'update-claude-mapping',
])

defineProps({
  toolStatuses: {
    type: Array,
    required: true,
  },
  toolStatusLoading: {
    type: Boolean,
    required: true,
  },
  toolActionLoading: {
    type: String,
    default: null,
  },
  claudeMapping: {
    type: Object,
    required: true,
  },
  isActionDone: {
    type: Function,
    required: true,
  },
  formatToolVersion: {
    type: Function,
    required: true,
  },
  formatConfigPath: {
    type: Function,
    required: true,
  },
})
</script>

<style scoped>
.claude-mapping-input {
  width: 100%;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  border: 1px solid rgba(255, 244, 228, 0.12);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  color: #fff4e4;
  font-size: var(--font-sm, 11px);
  outline: none;
  box-sizing: border-box;
}

.claude-mapping-input::placeholder {
  color: rgba(255, 244, 228, 0.35);
}

.claude-mapping-input:focus {
  border-color: rgba(240, 194, 123, 0.5);
  box-shadow: 0 0 0 2px rgba(240, 194, 123, 0.12);
}

.tool-info-reason {
  color: #ff9500;
  font-size: var(--font-sm, 10px);
}
</style>

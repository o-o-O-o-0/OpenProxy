<template>
  <section class="network-strip mini-card network-card">
    <div class="network-inline-row">
      <div class="network-toggle-group">
        <div class="network-item network-item-switch">
          <button
            type="button"
            class="icon-toggle"
            :class="{ 'icon-toggle-active': lanAccess }"
            :disabled="networkBusy || loading"
            @click="$emit('toggle-lan-access')"
          >
            <span class="toggle-icon">🌐</span>
            <span class="toggle-label">局域网 · {{ lanAccess ? '开启' : '关闭' }}</span>
          </button>
        </div>

        <div class="network-item network-item-switch">
          <button
            type="button"
            class="icon-toggle"
            :class="{ 'icon-toggle-active': privacyEnabled }"
            :disabled="networkBusy || loading"
            @click="$emit('toggle-privacy-mode')"
          >
            <span class="toggle-icon">🔒</span>
            <span class="toggle-label">隐私 · {{ privacyEnabled ? '开启' : '关闭' }}</span>
          </button>
        </div>
      </div>

      <button
        :class="['action-button', serviceButtonClass, { 'action-button-loading': loading }]"
        :disabled="loading"
        @click="$emit('toggle-service')"
      >
        <span class="btn-icon-shell" aria-hidden="true">
          <span v-if="loading" class="inline-spinner spinning"></span>
          <span v-else class="power-icon"></span>
        </span>
        <span class="action-button-label">{{ serviceActionLabel }}</span>
      </button>
    </div>
  </section>
</template>

<script setup>
defineEmits(['toggle-service', 'toggle-lan-access', 'toggle-privacy-mode'])

defineProps({
  loading: {
    type: Boolean,
    required: true,
  },
  serviceButtonClass: {
    type: String,
    required: true,
  },
  serviceActionLabel: {
    type: String,
    required: true,
  },
  networkBusy: {
    type: Boolean,
    required: true,
  },
  lanAccess: {
    type: Boolean,
    required: true,
  },
  privacyEnabled: {
    type: Boolean,
    required: true,
  },
})
</script>

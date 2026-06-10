<template>
  <section class="endpoint-banner">
    <div class="endpoint-stack">
      <div class="endpoint-copy">
        <span class="eyebrow">接口地址</span>
        <div class="endpoint-field">
          <code>{{ openaiUrl }}</code>
          <button
            :class="['tiny-button', 'endpoint-copy-button', { 'tiny-button-done': isActionDone('copy-openai-url') }]"
            @click="$emit('copy-openai-url')"
          >复制</button>
        </div>
      </div>

      <div class="endpoint-copy endpoint-copy-secondary">
        <span class="eyebrow">访问密钥</span>
        <div class="endpoint-field">
          <code>{{ apiKey }}</code>
          <button
            :class="['tiny-button', 'endpoint-copy-button', { 'tiny-button-done': isActionDone('copy-api-key') }]"
            @click="$emit('copy-api-key')"
          >复制</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup>
defineEmits(['copy-openai-url', 'copy-api-key'])

defineProps({
  openaiUrl: {
    type: String,
    required: true,
  },
  apiKey: {
    type: String,
    required: true,
  },
  isActionDone: {
    type: Function,
    required: true,
  },
})
</script>

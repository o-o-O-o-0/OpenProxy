<template>
  <header class="panel-header">
    <div class="brand-block">
      <div class="brand-mark">
        <img :src="brandLogo" alt="OpenProxy" class="brand-logo" />
      </div>
      <div class="brand-copy">
        <span class="eyebrow">本地模型网关</span>
        <h1>OpenProxy</h1>
        <p>{{ statusDescription }}</p>
      </div>
    </div>

    <span :class="['status-pill', status]">{{ statusText }}</span>
  </header>

  <div class="tag-row">
    <span class="tag">双协议</span>
    <span class="tag">本地代理</span>
    <span class="tag">端口 {{ port }}</span>
    <span :class="['tag', lanAccess ? 'tag-active' : '']">{{ lanAccess ? '局域网已开' : '仅本机' }}</span>
  </div>
</template>

<script setup>
defineProps({
  brandLogo: {
    type: String,
    required: true,
  },
  status: {
    type: String,
    required: true,
  },
  statusText: {
    type: String,
    required: true,
  },
  statusDescription: {
    type: String,
    required: true,
  },
  port: {
    type: Number,
    required: true,
  },
  lanAccess: {
    type: Boolean,
    required: true,
  },
})
</script>

<template>
  <div class="searchable-select" ref="wrapperRef">
    <input
      ref="inputRef"
      class="searchable-select-input"
      :placeholder="placeholder"
      :value="displayText"
      @input="onInput"
      @focus="open"
      @keydown.escape.prevent="close"
      @keydown.enter.prevent="selectHighlighted"
      @keydown.down.prevent="highlightNext"
      @keydown.up.prevent="highlightPrev"
    />
    <div v-if="isOpen" class="searchable-select-dropdown">
      <div
        v-for="(opt, i) in filteredOptions"
        :key="opt.id"
        :class="['searchable-select-option', { 'searchable-select-option-active': i === highlightIndex, 'searchable-select-option-selected': opt.id === modelValue }]"
        @mousedown.prevent="select(opt.id)"
        @mouseenter="highlightIndex = i"
      >
        <span class="searchable-select-option-id">{{ opt.id }}</span>
        <span v-if="opt.name && opt.name !== opt.id" class="searchable-select-option-name">{{ opt.name }}</span>
      </div>
      <div v-if="filteredOptions.length === 0" class="searchable-select-empty">未找到匹配模型</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue'

const props = defineProps({
  modelValue: { type: String, default: '' },
  options: { type: Array, default: () => [] },
  placeholder: { type: String, default: '' },
})

const emit = defineEmits(['update:modelValue'])

const wrapperRef = ref(null)
const inputRef = ref(null)
const isOpen = ref(false)
const filterText = ref('')
const highlightIndex = ref(0)

const currentOption = computed(() =>
  props.options.find(opt => opt.id === props.modelValue)
)

const displayText = computed(() => {
  if (isOpen.value) return filterText.value
  return currentOption.value?.name || currentOption.value?.id || props.modelValue || ''
})

const filteredOptions = computed(() => {
  const q = filterText.value.toLowerCase().trim()
  if (!q) return props.options
  return props.options.filter(opt =>
    opt.id.toLowerCase().includes(q) ||
    (opt.name && opt.name.toLowerCase().includes(q))
  )
})

watch(isOpen, (open) => {
  if (open) {
    highlightIndex.value = 0
    const cur = currentOption.value
    if (cur) filterText.value = cur.name || cur.id || ''
    else filterText.value = ''
    nextTick(() => inputRef.value?.select())
  }
})

function onInput(e) {
  filterText.value = e.target.value
  if (!isOpen.value) isOpen.value = true
  highlightIndex.value = 0
}

function open() {
  isOpen.value = true
}

function close() {
  isOpen.value = false
  filterText.value = ''
}

function select(value) {
  emit('update:modelValue', value)
  isOpen.value = false
  filterText.value = ''
  inputRef.value?.blur()
}

function selectHighlighted() {
  const opt = filteredOptions.value[highlightIndex.value]
  if (opt) select(opt.id)
}

function highlightNext() {
  if (highlightIndex.value < filteredOptions.value.length - 1)
    highlightIndex.value++
}

function highlightPrev() {
  if (highlightIndex.value > 0)
    highlightIndex.value--
}

function onDocumentClick(e) {
  if (wrapperRef.value && !wrapperRef.value.contains(e.target)) {
    isOpen.value = false
    filterText.value = ''
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', onDocumentClick)
}
</script>

<style scoped>
.searchable-select {
  position: relative;
  width: 100%;
}

.searchable-select-input {
  width: 100%;
  height: 28px;
  padding: 0 8px;
  border: 1px solid rgba(255, 244, 228, 0.12);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  color: #fff4e4;
  font-size: var(--font-sm, 11px);
  outline: none;
  box-sizing: border-box;
  cursor: text;
}

.searchable-select-input::placeholder {
  color: rgba(255, 244, 228, 0.35);
}

.searchable-select-input:focus {
  border-color: rgba(240, 194, 123, 0.5);
  box-shadow: 0 0 0 2px rgba(240, 194, 123, 0.12);
}

.searchable-select-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  max-height: 156px;
  overflow-y: auto;
  background: #1e1e2e;
  border: 1px solid rgba(255, 244, 228, 0.12);
  border-radius: 8px;
  z-index: 100;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}

.searchable-select-option {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 26px;
  padding: 4px 10px;
  cursor: pointer;
  color: rgba(255, 244, 228, 0.7);
  font-size: var(--font-xs, 10px);
  transition: background 0.1s;
}

.searchable-select-option:hover,
.searchable-select-option-active {
  background: rgba(240, 194, 123, 0.12);
  color: #fff4e4;
}

.searchable-select-option-selected {
  color: #f0c27b;
}

.searchable-select-option-id {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.searchable-select-option-name {
  flex: none;
  color: rgba(255, 244, 228, 0.4);
  font-size: 9px;
}

.searchable-select-empty {
  padding: 10px;
  text-align: center;
  color: rgba(255, 244, 228, 0.35);
  font-size: var(--font-xs, 10px);
}
</style>

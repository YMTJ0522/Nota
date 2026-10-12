<script setup lang="ts">
/**
 * 单行输入弹窗：重命名这类「问一句话」的场合。
 *
 * 为什么不让它去用目录树里的行内改名：那个输入框只存在于树里，
 * 而笔记列表的「收藏 / 未归类 / 搜索结果」这些视图下，那篇笔记
 * 根本不在树上，点了没反应。改成弹窗，在哪儿点都能改。
 */
import { nextTick, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    title?: string
    /** 输入框前面的小标签 */
    label?: string
    initial?: string
    placeholder?: string
    confirmText?: string
  }>(),
  {
    title: '输入',
    label: '',
    initial: '',
    placeholder: '',
    confirmText: '确定',
  },
)

const emit = defineEmits<{ (e: 'confirm', value: string): void; (e: 'cancel'): void }>()

const value = ref('')
const input = ref<HTMLInputElement | null>(null)

watch(
  () => props.open,
  async (v) => {
    if (!v) return
    value.value = props.initial ?? ''
    await nextTick()
    input.value?.focus()
    // 选中主文件名，但要留住扩展名——改名时多数人只改前半段
    input.value?.select()
  },
)

function ok() {
  const v = value.value.trim()
  if (!v) return
  emit('confirm', v)
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    ok()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    emit('cancel')
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="pd-mask" @pointerdown.self="emit('cancel')">
      <div class="pd" role="dialog" aria-modal="true" :aria-label="title" @keydown="onKey">
        <h3 class="pd-title">{{ title }}</h3>
        <label class="pd-field">
          <span v-if="label" class="pd-label">{{ label }}</span>
          <input
            ref="input"
            v-model="value"
            class="pd-input"
            type="text"
            :placeholder="placeholder"
            spellcheck="false"
          />
        </label>
        <div class="pd-actions">
          <button class="pd-btn pd-cancel" @click="emit('cancel')">取消</button>
          <button class="pd-btn pd-primary" :disabled="!value.trim()" @click="ok">
            {{ confirmText }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.pd-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--n-mask);
  backdrop-filter: blur(2px);
  animation: pd-fade 120ms var(--n-ease);
}

.pd {
  width: 360px;
  max-width: calc(100vw - 32px);
  padding: 18px;
  background: var(--n-raised);
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-lg);
  box-shadow: var(--n-shadow-xl);
  animation: pd-in 140ms var(--n-ease);
}

.pd-title {
  margin: 0 0 12px;
  font-size: 14.5px;
  font-weight: 650;
  letter-spacing: -0.01em;
  color: var(--n-fg);
}

.pd-field {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pd-label {
  flex: none;
  font-size: 12.5px;
  color: var(--n-fg-dim);
}

.pd-input {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-sm);
  background: var(--n-surface);
  color: var(--n-fg);
  font-family: inherit;
  font-size: 13px;
  outline: none;
  transition: border-color var(--n-dur) var(--n-ease);
}

.pd-input:focus {
  border-color: var(--n-accent);
}

.pd-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}

.pd-btn {
  height: 30px;
  padding: 0 14px;
  border-radius: var(--n-r-sm);
  border: 1px solid transparent;
  font-size: 13px;
  transition: background var(--n-dur) var(--n-ease);
}

.pd-cancel {
  color: var(--n-fg-dim);
  background: var(--n-surface);
  border-color: var(--n-line);
}

.pd-cancel:hover {
  color: var(--n-fg);
  background: var(--n-raised);
}

.pd-primary {
  color: #fff;
  background: var(--n-accent);
}

.pd-primary:disabled {
  opacity: 0.45;
}

.pd-primary:hover:not(:disabled) {
  filter: brightness(1.08);
}

@keyframes pd-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes pd-in {
  from { opacity: 0; transform: translateY(-6px) scale(0.985); }
  to { opacity: 1; transform: none; }
}
</style>

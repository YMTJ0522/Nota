<script setup lang="ts">
/**
 * 轻提示（toast）。
 *
 * 全应用各处（导入、导出、插入附件、恢复版本…）都在往外抛 `nota:toast`
 * 事件，但一直没有谁去接——动作做完了屏幕上毫无反应，用户只能猜。
 * 这里把这条线接上：底部中间浮一条，2.6 秒后自己走。
 *
 * 同一时刻最多留 3 条：连着导几篇笔记时不至于糊满屏幕。
 * 层级压在所有对话框之上（z-index 2000），不然在附件库/设置里触发的
 * 提示会被遮罩盖住。
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'

interface Item {
  id: number
  text: string
}

const items = ref<Item[]>([])
let seq = 0

/** 每条自己计时；定时器留着，组件卸载时统一清掉 */
const timers = new Set<ReturnType<typeof setTimeout>>()

function push(text: string) {
  if (!text) return
  seq += 1
  const id = seq
  items.value = [...items.value, { id, text }].slice(-3)
  const t = setTimeout(() => {
    items.value = items.value.filter((i) => i.id !== id)
    timers.delete(t)
  }, 2600)
  timers.add(t)
}

function onToast(e: Event) {
  push(String((e as CustomEvent<string>).detail ?? ''))
}

onMounted(() => window.addEventListener('nota:toast', onToast))
onBeforeUnmount(() => {
  window.removeEventListener('nota:toast', onToast)
  for (const t of timers) clearTimeout(t)
  timers.clear()
})
</script>

<template>
  <Teleport to="body">
    <div v-if="items.length" class="toasts" role="status" aria-live="polite">
      <div v-for="i in items" :key="i.id" class="toast">{{ i.text }}</div>
    </div>
  </Teleport>
</template>

<style scoped>
.toasts {
  position: fixed;
  left: 50%;
  bottom: 32px;
  z-index: 2000;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  transform: translateX(-50%);
  pointer-events: none;
}

.toast {
  max-width: min(70vw, 560px);
  padding: 8px 14px;
  border: 1px solid var(--n-line);
  border-radius: 999px;
  background: var(--n-raised);
  box-shadow: var(--n-shadow-lg);
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--n-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  animation: toast-in 160ms var(--n-ease);
}

@keyframes toast-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
</style>

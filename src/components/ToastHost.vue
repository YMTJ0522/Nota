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

/**
 * 一条可以「反悔」的提示。
 *
 * 便签存进笔记库之后会自己收起来，这个动作不该是不可逆的 —— 带上一个
 * 「撤销」，整件事才是「默认动作 + 例外可改」，而不是「替你决定」。
 */
export interface ToastAction {
  label: string
  run: () => void
}

export interface ToastPayload {
  text: string
  action?: ToastAction
}

interface Item {
  id: number
  text: string
  action?: ToastAction
}

const items = ref<Item[]>([])
let seq = 0

/** 每条自己计时；定时器留着，组件卸载时统一清掉 */
const timers = new Set<ReturnType<typeof setTimeout>>()

function push(payload: string | ToastPayload) {
  const p: ToastPayload = typeof payload === 'string' ? { text: payload } : payload
  if (!p.text) return
  seq += 1
  const id = seq
  items.value = [...items.value, { id, text: p.text, action: p.action }].slice(-3)
  // 带按钮的多留一会儿：2.6 秒刚读完字，手还来不及移到那颗「撤销」上
  const t = setTimeout(
    () => {
      items.value = items.value.filter((i) => i.id !== id)
      timers.delete(t)
    },
    p.action ? 5200 : 2600,
  )
  timers.add(t)
}

function drop(id: number) {
  items.value = items.value.filter((i) => i.id !== id)
}

function run(i: Item) {
  drop(i.id)
  try {
    i.action?.run()
  } catch {
    /* 撤销失败不该把整个提示层带崩 */
  }
}

function onToast(e: Event) {
  push((e as CustomEvent<string | ToastPayload>).detail ?? '')
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
      <div v-for="i in items" :key="i.id" class="toast">
        <span class="toast-text">{{ i.text }}</span>
        <button v-if="i.action" class="toast-act" @click="run(i)">
          {{ i.action.label }}
        </button>
      </div>
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
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border: 1px solid var(--n-line);
  border-radius: 999px;
  background: var(--n-raised);
  box-shadow: var(--n-shadow-lg);
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--n-fg);
  animation: toast-in 160ms var(--n-ease);
}

/* 只有文字的那条压成一行，别把长路径撑成两行 */
.toast-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 容器整条是 pointer-events:none 的（不能挡住下面的界面），
   所以按钮自己得把事件收回来 */
.toast-act {
  flex: none;
  padding: 0 2px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--n-accent);
  white-space: nowrap;
  pointer-events: auto;
}
.toast-act:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
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

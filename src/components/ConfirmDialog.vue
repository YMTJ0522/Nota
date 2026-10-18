<script setup lang="ts">
import { watch, nextTick, ref } from 'vue'

/**
 * 通用确认弹窗。
 *
 * 为什么不用原生 window.confirm：
 *  - 它带系统浏览器的样式，跟应用的深色主题完全不搭，视觉上很突兀；
 *  - 它会阻塞渲染进程，Electron 里更容易出怪问题；
 *  - 无法做「危险操作」的语义区分（确认按钮该是红色还是绿色）。
 *
 * 承载内容用 Teleport 到 body，避免被任何 overflow 容器裁掉——
 * 这是本项目里反复踩过的坑（见 README 里下拉菜单那一节）。
 */
const props = withDefaults(
  defineProps<{
    open: boolean
    title?: string
    message?: string
    /** 确认按钮文案 */
    confirmText?: string
    cancelText?: string
    /** 危险操作：确认按钮走红色 */
    danger?: boolean
  }>(),
  {
    title: '确认操作',
    message: '',
    confirmText: '确认',
    cancelText: '取消',
    danger: false,
  },
)

const emit = defineEmits<{ (e: 'confirm'): void; (e: 'cancel'): void }>()

const confirmBtn = ref<HTMLButtonElement | null>(null)

/** 打开时把焦点给「取消」——危险操作的默认落点应当是安全那一侧 */
watch(
  () => props.open,
  async (v) => {
    if (!v) return
    await nextTick()
    confirmBtn.value?.focus()
  },
)

function onKey(e: KeyboardEvent) {
  if (!props.open) return
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('cancel')
  } else if (e.key === 'Enter') {
    e.preventDefault()
    emit('confirm')
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="cf-mask" tabindex="-1" @click.self="emit('cancel')" @keydown="onKey">
      <div class="cf" role="dialog" aria-modal="true" :aria-label="title">
        <h3 class="cf-title">{{ title }}</h3>
        <p v-if="message" class="cf-msg">{{ message }}</p>

        <div class="cf-actions">
          <button ref="confirmBtn" class="cf-btn cf-cancel" @click="emit('cancel')">
            {{ cancelText }}
          </button>
          <button
            class="cf-btn"
            :class="danger ? 'cf-danger' : 'cf-primary'"
            @click="emit('confirm')"
          >
            {{ confirmText }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.cf-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--n-mask);
  /* 不用 backdrop-filter：全窗模糊在软件合成下会把每次重绘拖到个位数帧率（实测 60 → 7），
     而 2px 的模糊肉眼几乎看不出来。改用纯色遮罩，遮罩本身已经够分层了。 */
  animation: cf-fade 120ms var(--n-ease);
}

.cf {
  width: 340px;
  max-width: calc(100vw - 32px);
  padding: 18px 18px 14px;
  background: var(--n-raised);
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-lg);
  box-shadow: var(--n-shadow-xl);
  animation: cf-in 140ms var(--n-ease);
}

.cf-title {
  margin: 0;
  font-size: 14.5px;
  font-weight: 650;
  letter-spacing: -0.01em;
  color: var(--n-fg);
}

.cf-msg {
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--n-fg-dim);
  word-break: break-all;
}

.cf-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}

.cf-btn {
  height: 30px;
  padding: 0 14px;
  border-radius: var(--n-r-sm);
  font-size: 13px;
  border: 1px solid transparent;
  transition: background var(--n-dur) var(--n-ease), border-color var(--n-dur) var(--n-ease);
}

.cf-cancel {
  color: var(--n-fg-dim);
  background: var(--n-surface);
  border-color: var(--n-line);
}

.cf-cancel:hover {
  color: var(--n-fg);
  background: var(--n-raised);
}

/* 确认按钮：普通操作走强调色，危险操作走红色。
   两者都用实心，保证「主按钮」的视觉权重。 */
.cf-primary {
  color: #fff;
  background: var(--n-accent);
}

.cf-primary:hover {
  filter: brightness(1.08);
}

.cf-danger {
  color: #fff;
  background: var(--n-danger);
}

.cf-danger:hover {
  filter: brightness(1.08);
}

.cf-btn:focus-visible {
  outline: 2px solid var(--n-accent);
  outline-offset: 2px;
}

@keyframes cf-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes cf-in {
  from { opacity: 0; transform: translateY(-6px) scale(0.985); }
  to { opacity: 1; transform: none; }
}
</style>

<script setup lang="ts">
/**
 * 远程图片弹窗：填一个链接，顺手看一眼图对不对，再插进正文。
 *
 * 原来这一项是在光标处直接插 `![]()`，然后把「把链接粘进括号里」这件事
 * 交给用户——括号又窄又容易被行内预览顶来顶去，粘贴经常粘歪。
 * 改成弹窗之后有三件事顺手了：链接和说明各有一格、能看到图、
 * 从别处复制来的 `![alt](url)` 或 `<url>` 不用先手动拆一遍。
 *
 * 说明文字是可选的，但它在图裂的时候就是唯一还看得见的东西，
 * 所以留一格、并且默认把选中的正文填进来。
 */
import { computed, nextTick, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    /** 打开时预填的说明文字（一般是正文里选中的那几个字） */
    initialAlt?: string
  }>(),
  { initialAlt: '' },
)

const emit = defineEmits<{
  (e: 'confirm', payload: { url: string; alt: string }): void
  (e: 'cancel'): void
}>()

const url = ref('')
const alt = ref('')
const urlInput = ref<HTMLInputElement | null>(null)
const altInput = ref<HTMLInputElement | null>(null)

/** 'idle' | 'ok' | 'bad' —— 只管预览那一小块，不影响能不能插入 */
const shot = ref<'idle' | 'ok' | 'bad'>('idle')

/**
 * 把从别处复制来的东西还原成一条纯链接。
 *
 * 实际会粘进来的样本就这三种：
 *   `![封面](https://x/a.png)`、`<https://x/a.png>`、`"https://x/a.png"`
 * 再加上首尾空白和末尾的标点。全都剥掉，人不用先回浏览器抄一遍。
 */
function normalize(raw: string): string {
  let s = raw.trim()
  // Markdown 图片 / 链接：取括号里那一段
  const md = /^!?\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)$/.exec(s)
  if (md) s = md[1]
  // 尖括号包起来的自动链接
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1)
  // 整段被引号裹住（从聊天窗口复制常见）
  if (/^["'「『]/.test(s) && /["'」』]$/.test(s)) s = s.slice(1, -1)
  return s.trim()
}

const clean = computed(() => normalize(url.value))

/** 只挡明显的注入写法；其余一律放行，别替人判断「这算不算一个网址」 */
const blocked = computed(() => /^javascript:/i.test(clean.value))
const canSubmit = computed(() => clean.value.length > 0 && !blocked.value)

/** 看着不像完整链接时提示一句，但不拦着——相对路径、附件路径也是合法的 */
const oddShape = computed(() => {
  const s = clean.value
  if (!s) return false
  if (/^https?:\/\//i.test(s)) return false
  if (s.startsWith('/') || s.startsWith('./') || s.startsWith('../')) return false
  return !/^attachments\//.test(s)
})

watch(
  () => props.open,
  async (v) => {
    if (!v) return
    url.value = ''
    alt.value = props.initialAlt ?? ''
    shot.value = 'idle'
    await nextTick()
    urlInput.value?.focus()
  },
)

/* 链接一变，预览回到「加载中」：旧图裁掉之前那张的 ok 状态会留在框里，
   看起来像新链接已经加载好了。img 用 :key 重挂，load/error 会再报一次。 */
watch(clean, () => {
  shot.value = 'idle'
})

function ok() {
  if (!canSubmit.value) return
  emit('confirm', { url: clean.value, alt: alt.value.trim() })
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault()
    ok()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    emit('cancel')
  }
}

/** 从链接里猜一个说明文字，当占位符用——不自动填，免得改掉人选中的字 */
const guessAlt = computed(() => {
  const s = clean.value
  if (!s) return ''
  const name = s.split(/[?#]/)[0].split('/').pop() ?? ''
  return /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(name) ? name.replace(/\.[^.]+$/, '') : ''
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="ri-mask" @pointerdown.self="emit('cancel')">
      <div class="ri" role="dialog" aria-modal="true" aria-label="插入远程图片" @keydown="onKey">
        <h3 class="ri-title">插入远程图片</h3>

        <label class="ri-field">
          <span class="ri-label">链接</span>
          <input
            ref="urlInput"
            v-model="url"
            class="ri-input ri-input--url"
            type="text"
            placeholder="https://…/图片.png"
            spellcheck="false"
            autocomplete="off"
          />
        </label>

        <label class="ri-field">
          <span class="ri-label">说明</span>
          <input
            ref="altInput"
            v-model="alt"
            class="ri-input"
            type="text"
            :placeholder="guessAlt || '可选，图片加载不出来时显示这几个字'"
            spellcheck="false"
          />
        </label>

        <!-- 预览：图对不对，看一眼比读一遍链接可靠 -->
        <div v-if="clean" class="ri-shot" :data-state="shot">
          <img
            :key="clean"
            :src="clean"
            alt=""
            @load="shot = 'ok'"
            @error="shot = 'bad'"
          />
          <span v-if="shot !== 'ok'" class="ri-shot-note">
            {{ shot === 'bad' ? '这张图加载不出来 · 仍然可以插入' : '加载中…' }}
          </span>
        </div>

        <p v-if="blocked" class="ri-hint ri-hint--bad">这个链接不能当图片插入。</p>
        <p v-else-if="oddShape" class="ri-hint">
          看着不是完整链接——要以 https:// 开头才对，除非它是附件里的相对路径。
        </p>

        <div class="ri-actions">
          <button class="ri-btn ri-cancel" @click="emit('cancel')">取消</button>
          <button class="ri-btn ri-primary" :disabled="!canSubmit" @click="ok">插入</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ri-mask {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 与 PromptDialog 同一套遮罩：不用 backdrop-filter，
     全窗模糊在软件合成下会把重绘拖到个位数帧率 */
  background: var(--n-mask);
  animation: ri-fade 120ms var(--n-ease);
}

.ri {
  width: 440px;
  max-width: calc(100vw - 32px);
  padding: 18px;
  background: var(--n-raised);
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-lg);
  box-shadow: var(--n-shadow-xl);
  animation: ri-in 140ms var(--n-ease);
}

.ri-title {
  margin: 0 0 14px;
  font-size: 14.5px;
  font-weight: 650;
  letter-spacing: -0.01em;
  color: var(--n-fg);
}

.ri-field {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.ri-label {
  flex: none;
  width: 28px;
  font-size: 12.5px;
  color: var(--n-fg-dim);
}

.ri-input {
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

/* 链接是机器写的字，等宽更好核对——差一个字符完全看不出来 */
.ri-input--url {
  font-family: var(--n-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12.5px;
}

.ri-input:focus {
  border-color: var(--n-accent);
}

.ri-shot {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 132px;
  margin: 4px 0 10px 38px;
  overflow: hidden;
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-sm);
  background: var(--n-surface);
}

.ri-shot img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  opacity: 0;
  transition: opacity 160ms var(--n-ease);
}

.ri-shot[data-state='ok'] img {
  opacity: 1;
}

.ri-shot-note {
  position: absolute;
  font-size: 12px;
  color: var(--n-fg-dim);
}

.ri-shot[data-state='bad'] img {
  display: none;
}

.ri-hint {
  margin: 0 0 0 38px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--n-fg-dim);
}

.ri-hint--bad {
  color: var(--n-danger);
}

.ri-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}

.ri-btn {
  height: 30px;
  padding: 0 14px;
  border-radius: var(--n-r-sm);
  border: 1px solid transparent;
  font-size: 13px;
  transition: background var(--n-dur) var(--n-ease);
}

.ri-cancel {
  color: var(--n-fg-dim);
  background: var(--n-surface);
  border-color: var(--n-line);
}

.ri-cancel:hover {
  color: var(--n-fg);
  background: var(--n-raised);
}

.ri-primary {
  color: #fff;
  background: var(--n-accent);
}

.ri-primary:disabled {
  opacity: 0.45;
}

.ri-primary:hover:not(:disabled) {
  filter: brightness(1.08);
}

@keyframes ri-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes ri-in {
  from { opacity: 0; transform: translateY(-6px) scale(0.985); }
  to { opacity: 1; transform: none; }
}
</style>

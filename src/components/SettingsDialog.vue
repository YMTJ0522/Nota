<script setup lang="ts">
/**
 * 设置面板：左侧五分区 + 右侧行式内容。
 *
 * 每一行的形状都一样——左边「这是什么」，右边「改成什么」。
 * 不用卡片、不用堆叠表单，是为了让真正要动手的控件排在同一条垂直线上：
 * 眼睛从上往下扫一遍就能找到目标，不用先读标题再猜输入框在下面还是右边。
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import {
  Blocks,
  Check,
  ChevronDown,
  Columns2,
  Eye,
  EyeOff,
  FileCode2,
  HardDrive,
  History,
  Info,
  KeyRound,
  Link2,
  Loader2,
  Moon,
  Palette,
  Pencil,
  RotateCcw,
  Server,
  Settings2,
  Sparkles,
  Sun,
  Type,
  X,
  Cloud,
  RefreshCw,
} from 'lucide-vue-next'
import { ACCENTS, ACCENT_SWATCH, AI_DEFAULTS, AI_PRESETS, BG_STYLES, DENSITY, MEASURES, store } from '@/store'
import appIcon from '@/assets/app-icon.png'
import type { AccentName, BgStyle, Density, MeasureName, SettingsSection, ViewMode } from '@/store'

type SectionId = SettingsSection

const props = defineProps<{ open: boolean; section?: SectionId }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const { state } = store

/** 版本号由 vite define 注入（值取自 package.json），避免两处写死对不上 */
const APP_VERSION: string = __APP_VERSION__

const SECTIONS: { id: SectionId; label: string; icon: unknown }[] = [
  { id: 'general', label: '通用', icon: Settings2 },
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'editor', label: '编辑', icon: Type },
  { id: 'ai', label: 'AI 编写', icon: Sparkles },
  { id: 'sync', label: '云同步', icon: Cloud },
  { id: 'about', label: '关于', icon: Info },
]

const section = ref<SectionId>('general')
const current = computed(() => SECTIONS.find((s) => s.id === section.value)!)

/** 外部（工具栏 AI 菜单、聊天页的设置按钮）指定分区时跟过去 */
watch(
  () => [props.open, props.section] as const,
  ([open, want]) => {
    if (!open || !want) return
    if (SECTIONS.some((s) => s.id === want)) section.value = want
  },
  { immediate: true },
)

const VIEWS: { id: ViewMode; label: string; icon: unknown }[] = [
  { id: 'write', label: '编辑', icon: Pencil },
  { id: 'split', label: '分栏', icon: Columns2 },
  { id: 'read', label: '预览', icon: Eye },
]

/* ── 关于页的运行环境 ──
   版本号只在主进程拿得到，等对话框真的打开时再取一次，取不到就留空。 */
const env = ref({ electron: '', chrome: '', node: '', platform: '', arch: '' })
const PLATFORM_TEXT: Record<string, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
}
const envText = computed(() => {
  const p = PLATFORM_TEXT[env.value.platform] ?? env.value.platform
  return env.value.arch ? `${p} · ${env.value.arch}` : p || '—'
})

/** 关于页的四张特性卡。只写真有的东西 —— 这一页是「这软件能干什么」的清单，
    写上去的每一条都得是在这个版本里点得到的。 */
const ABOUT_FEATURES: { title: string; desc: string; icon: unknown }[] = [
  { title: '纯 Markdown', desc: '正文就是 .md 文件', icon: FileCode2 },
  { title: '本地优先', desc: '数据只在你的磁盘上', icon: HardDrive },
  { title: '富内容', desc: '表格 / 图表 / 公式 / 提示块', icon: Blocks },
  { title: '版本历史', desc: '每篇都有独立快照', icon: History },
]

const ABOUT_KEYS: { label: string; key: string }[] = [
  { label: '保存', key: 'Ctrl + S' },
  { label: '新建笔记', key: 'Ctrl + N' },
  { label: '打开目录', key: 'Ctrl + O' },
  { label: '编辑 / 分栏 / 预览', key: 'Ctrl + 1 / 2 / 3' },
  { label: '查找与替换', key: 'Ctrl + F' },
  { label: '命令菜单', key: '/' },
  { label: '折叠侧边栏', key: 'Ctrl + \\' },
]

watch(
  () => props.open,
  async (open) => {
    if (!open || env.value.electron) return
    try {
      env.value = await window.api.appInfo()
    } catch {
      /* 拿不到就显示占位，不影响设置页其它部分 */
    }
  },
  { immediate: true },
)

/* ── AI ── */
const testing = ref(false)
const testResult = ref<{ ok: boolean; text: string } | null>(null)

/** 云端目录的占位符：没填就用工作区文件夹自己的名字 */
const workspaceDirName = computed(() => {
  if (!state.root) return ''
  return state.root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
})
const testModels = ref<string[]>([])
const showModels = ref(false)
const showKey = ref(false)

/** 改任意一项都立刻落盘，跟主题/视图的处理保持一致 */
watch(
  () => JSON.stringify(state.ai),
  () => store.setAiConfig({ ...state.ai }),
)

/** 服务商预设：自绘下拉。用「当前 baseUrl 命中哪套预设」反推选中项，
    不去另外存一份状态 —— 用户手改过地址之后，这里显示的仍然是真实的那套。
    比对前把地址抹平（去 / 去协议大小写），手敲的 `https://api.deepseek.com/v1/`
    也该认成 DeepSeek，而不是掉回「自定义」。 */
const presetOpen = ref(false)
const normUrl = (u: string) => u.trim().toLowerCase().replace(/\/+$/, '')
const presetIndex = computed(() => {
  const cur = normUrl(state.ai.baseUrl)
  const i = AI_PRESETS.findIndex((p) => normUrl(p.baseUrl) === cur)
  return i < 0 ? 0 : i + 1
})
const presetLabel = computed(() =>
  presetIndex.value ? AI_PRESETS[presetIndex.value - 1].label : '自定义…',
)

/** 「自定义…」不是一个状态、是一件动作：把光标送进接口地址那一格，接着打字就行。
    它同时是「当前这套地址不匹配任何一个预设」的指示灯 —— 匹配不上时那一行打勾。 */
const urlInput = ref<HTMLInputElement | null>(null)

function pickPreset(i: number) {
  presetOpen.value = false
  if (i < 0) {
    urlInput.value?.focus()
    urlInput.value?.select()
    return
  }
  const p = AI_PRESETS[i]
  if (!p) return
  store.setAiConfig({ baseUrl: p.baseUrl, model: p.model })
  testResult.value = null
  testModels.value = []
}

/**
 * 预设菜单就地弹出，点别处要收起来。
 *
 * 这里**必须**放过落在 `.st-drop` 里的那一下。之前是「捕获阶段无条件收起」，
 * 结果 pointerdown 一进来菜单就被 Vue 拆掉，等 mouseup 时按钮已经不在 DOM 里，
 * click 事件根本不产生 —— 表现就是「每一项都点得动，但永远还是自定义」。
 * 跟 SidePanel / Toolbar 那几处保持同一个套路：点在菜单内就不收。
 */
function onDocPointer(e: PointerEvent) {
  if (!presetOpen.value) return
  if ((e.target as HTMLElement | null)?.closest('.st-drop')) return
  presetOpen.value = false
}
function onEsc(e: KeyboardEvent) {
  if (!presetOpen.value || e.key !== 'Escape') return
  e.stopPropagation()
  presetOpen.value = false
}

async function testConnection() {
  testing.value = true
  testResult.value = null
  try {
    const r = await window.api.aiTest({ ...state.ai })
    testModels.value = r.models ?? []
    testResult.value = r.ok
      ? { ok: true, text: `连接成功${r.models?.length ? `，可用 ${r.models.length} 个模型` : ''}` }
      : { ok: false, text: r.error ?? '连接失败' }
    if (r.ok && r.models?.length) showModels.value = true
  } catch (e) {
    testResult.value = { ok: false, text: String(e) }
  } finally {
    testing.value = false
  }
}

/** 工具栏 AI 菜单的「模型设置…」走同一个入口 */
function onJump(e: Event) {
  const id = (e as CustomEvent<string>).detail
  if (id === 'ai') section.value = 'ai'
}

onMounted(() => {
  window.addEventListener('nota:settings', onJump)
  document.addEventListener('pointerdown', onDocPointer)
  document.addEventListener('keydown', onEsc, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('nota:settings', onJump)
  document.removeEventListener('pointerdown', onDocPointer)
  document.removeEventListener('keydown', onEsc, true)
})

/** 色板圆点的预览色：跟着当前主题取对应那一套 */
function swatchOf(id: AccentName) {
  return state.theme === 'dark' ? ACCENT_SWATCH[id].dark : ACCENT_SWATCH[id].light
}

/** 工作区路径太长，这里只把最后一段放大显示，完整路径挂在 title 上 */
const rootTail = computed(() => {
  const r = state.root ?? ''
  if (!r) return ''
  const parts = r.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? r
})

/**
 * 「恢复默认」只回滚当前这一页的项。
 * 一次把所有设置都推平太粗暴——多数时候用户只是想把某一页调回去。
 */
const RESET_LABEL: Record<SectionId, string> = {
  general: '恢复通用设置',
  appearance: '恢复外观设置',
  editor: '恢复编辑设置',
  ai: '恢复 AI 设置',
  sync: '',
  about: '',
}

function resetSection() {
  if (section.value === 'appearance' || section.value === 'editor') {
    store.resetPrefs()
  } else if (section.value === 'ai') {
    store.setAiConfig({ ...AI_DEFAULTS })
    testResult.value = null
    testModels.value = []
  } else if (section.value === 'general') {
    store.setViewMode('split')
    store.setAutoSave(true)
  }
}

async function changeWorkspace() {
  emit('close')
  await store.openWorkspace()
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="st-mask" @click.self="emit('close')">
      <div class="st" role="dialog" aria-modal="true" aria-label="设置">
        <!-- 左：分区导航 -->
        <nav class="st-nav">
          <div class="st-nav-title">设置</div>
          <button
            v-for="s in SECTIONS"
            :key="s.id"
            class="st-nav-item"
            :class="{ on: section === s.id }"
            @click="section = s.id"
          >
            <span class="st-nav-ico"><component :is="s.icon" :size="14" :stroke-width="1.9" /></span>
            <span class="st-nav-label">{{ s.label }}</span>
          </button>
        </nav>

        <!-- 右：内容 -->
        <div class="st-main">
          <header class="st-head">
            <h2 class="st-title">{{ current.label }}</h2>
            <button class="st-x" title="关闭 (Esc)" @click="emit('close')">
              <X :size="15" :stroke-width="1.9" />
            </button>
          </header>

          <div class="st-body">
            <!-- ══ 通用 ══ -->
            <template v-if="section === 'general'">
              <div class="st-row">
                <div class="st-label">
                  <span class="st-name">工作区</span>
                  <span class="st-desc" :title="state.root ?? ''">
                    {{ rootTail || '尚未选择目录' }}
                  </span>
                </div>
                <button class="st-btn" @click="changeWorkspace">更换目录</button>
              </div>

              <div class="st-row">
                <div class="st-label">
                  <span class="st-name">笔记数量</span>
                  <span class="st-desc">当前工作区里所有 .md 文件</span>
                </div>
                <span class="st-value">{{ store.allFiles.value.length }}</span>
              </div>

              <div class="st-row">
                <div class="st-label">
                  <span class="st-name">默认视图</span>
                  <span class="st-desc">打开笔记时的初始模式，也可用 Ctrl+1 / 2 / 3 随时切换</span>
                </div>
                <div class="st-seg" role="radiogroup" aria-label="默认视图">
                  <button
                    v-for="v in VIEWS"
                    :key="v.id"
                    class="st-seg-btn"
                    role="radio"
                    :aria-checked="state.viewMode === v.id"
                    :class="{ on: state.viewMode === v.id }"
                    @click="store.setViewMode(v.id)"
                  >
                    <component :is="v.icon" :size="13" :stroke-width="1.9" /><span>{{ v.label }}</span>
                  </button>
                </div>
              </div>

              <div class="st-row">
                <div class="st-label">
                  <span class="st-name">自动保存</span>
                  <span class="st-desc">停止输入 600ms 后自动写入磁盘</span>
                </div>
                <button
                  class="st-switch"
                  role="switch"
                  :aria-checked="state.autoSave"
                  :class="{ on: state.autoSave }"
                  @click="store.setAutoSave(!state.autoSave)"
                >
                  <span class="st-knob" />
                </button>
              </div>

              <div class="st-row">
                <div class="st-label">
                  <span class="st-name">显示侧边栏</span>
                  <span class="st-desc">左侧的资料库导航，也可用 Ctrl+\ 折叠</span>
                </div>
                <button
                  class="st-switch"
                  role="switch"
                  :aria-checked="state.sidebar"
                  :class="{ on: state.sidebar }"
                  @click="store.toggleSidebar()"
                >
                  <span class="st-knob" />
                </button>
              </div>
            </template>

            <!-- ══ 外观 ══ -->
            <template v-else-if="section === 'appearance'">
              <div class="st-row">
                <div class="st-label">
                  <span class="st-name">主题</span>
                  <span class="st-desc">浅色适合白天，深色适合夜间写作</span>
                </div>
                <div class="st-seg" role="radiogroup" aria-label="主题">
                  <button
                    class="st-seg-btn"
                    role="radio"
                    :aria-checked="state.theme === 'light'"
                    :class="{ on: state.theme === 'light' }"
                    @click="store.setTheme('light')"
                  >
                    <Sun :size="13" :stroke-width="1.9" /><span>浅色</span>
                  </button>
                  <button
                    class="st-seg-btn"
                    role="radio"
                    :aria-checked="state.theme === 'dark'"
                    :class="{ on: state.theme === 'dark' }"
                    @click="store.setTheme('dark')"
                  >
                    <Moon :size="13" :stroke-width="1.9" /><span>深色</span>
                  </button>
                </div>
              </div>

              <div class="st-row">
                <div class="st-label">
                  <span class="st-name">强调色</span>
                  <span class="st-desc">
                    作用于链接、选中、按钮等所有强调元素；浅色底和深色底各有一套取值
                  </span>
                </div>
                <div class="st-swatches" role="radiogroup" aria-label="强调色">
                  <button
                    v-for="a in ACCENTS"
                    :key="a.id"
                    class="st-swatch"
                    role="radio"
                    :aria-checked="state.accent === a.id"
                    :class="{ on: state.accent === a.id }"
                    :title="a.label"
                    :style="{ '--swatch-c': swatchOf(a.id) }"
                    @click="store.setAccent(a.id)"
                  >
                    <span
                      class="st-swatch-dot"
                      :style="{ background: swatchOf(a.id) }"
                    />
                  </button>
                </div>
              </div>

              <div class="st-row">
                <div class="st-label">
                  <span class="st-name">画布底纹</span>
                  <span class="st-desc">纸张更接近实体本子，纯色更干净</span>
                </div>
                <div class="st-seg" role="radiogroup" aria-label="画布底纹">
                  <button
                    v-for="b in BG_STYLES"
                    :key="b.id"
                    class="st-seg-btn"
                    role="radio"
                    :aria-checked="state.bg === b.id"
                    :class="{ on: state.bg === b.id }"
                    @click="store.setPrefs({ bg: b.id as BgStyle })"
                  >
                    <span>{{ b.label }}</span>
                  </button>
                </div>
              </div>

              <div class="st-row">
                <div class="st-label">
                  <span class="st-name">界面密度</span>
                  <span class="st-desc">影响侧边栏与列表的行距，紧凑模式一屏能多放几行</span>
                </div>
                <div class="st-seg" role="radiogroup" aria-label="界面密度">
                  <button
                    v-for="d in DENSITY"
                    :key="d.id"
                    class="st-seg-btn"
                    role="radio"
                    :aria-checked="state.density === d.id"
                    :class="{ on: state.density === d.id }"
                    @click="store.setPrefs({ density: d.id as Density })"
                  >
                    <span>{{ d.label }}</span>
                  </button>
                </div>
              </div>
            </template>

            <!-- ══ 编辑 ══ -->
            <template v-else-if="section === 'editor'">
              <div class="st-row">
                <div class="st-label">
                  <span class="st-name">正文栏宽</span>
                  <span class="st-desc">限制一行的最大宽度，读长句时眼睛不用横扫太远</span>
                </div>
                <div class="st-seg" role="radiogroup" aria-label="正文栏宽">
                  <button
                    v-for="m in MEASURES"
                    :key="m.id"
                    class="st-seg-btn"
                    role="radio"
                    :aria-checked="state.measure === m.id"
                    :class="{ on: state.measure === m.id }"
                    @click="store.setPrefs({ measure: m.id as MeasureName })"
                  >
                    <span>{{ m.label }}</span>
                  </button>
                </div>
              </div>

              <div class="st-row">
                <div class="st-label">
                  <span class="st-name">正文字号</span>
                  <span class="st-desc">{{ state.fontSize }} px</span>
                </div>
                <input
                  class="st-range"
                  type="range"
                  min="13"
                  max="19"
                  step="1"
                  :value="state.fontSize"
                  @input="store.setPrefs({ fontSize: Number(($event.target as HTMLInputElement).value) })"
                />
              </div>

              <div class="st-row">
                <div class="st-label">
                  <span class="st-name">行高</span>
                  <span class="st-desc">{{ state.lineHeight.toFixed(2) }} — 写长文时 1.8 更舒服</span>
                </div>
                <input
                  class="st-range"
                  type="range"
                  min="1.5"
                  max="2.2"
                  step="0.05"
                  :value="state.lineHeight"
                  @input="store.setPrefs({ lineHeight: Number(($event.target as HTMLInputElement).value) })"
                />
              </div>

              <div class="st-row">
                <div class="st-label">
                  <span class="st-name">自动换行</span>
                  <span class="st-desc">长行折回来显示；关掉后横向滚动，适合看表格和长代码块</span>
                </div>
                <button
                  class="st-switch"
                  role="switch"
                  :aria-checked="state.lineWrap"
                  :class="{ on: state.lineWrap }"
                  @click="store.setPrefs({ lineWrap: !state.lineWrap })"
                >
                  <span class="st-knob" />
                </button>
              </div>

              <div class="st-row">
                <div class="st-label">
                  <span class="st-name">显示行号</span>
                  <span class="st-desc">编辑器左侧的装订线</span>
                </div>
                <button
                  class="st-switch"
                  role="switch"
                  :aria-checked="state.lineNumbers"
                  :class="{ on: state.lineNumbers }"
                  @click="store.setPrefs({ lineNumbers: !state.lineNumbers })"
                >
                  <span class="st-knob" />
                </button>
              </div>

              <div class="st-row">
                <div class="st-label">
                  <span class="st-name">显示大纲</span>
                  <span class="st-desc">资料栏里的「大纲」页签</span>
                </div>
                <button
                  class="st-switch"
                  role="switch"
                  :aria-checked="state.outline"
                  :class="{ on: state.outline }"
                  @click="store.toggleOutline()"
                >
                  <span class="st-knob" />
                </button>
              </div>
            </template>

            <!-- ══ AI 编写 ══
                 全部按「一行一项」排：左边说清楚这是什么，右边放控件，
                 输入框统一宽度，让它们在同一条竖线上对齐。 -->
            <template v-else-if="section === 'ai'">
              <div class="st-row">
                <div class="st-label">
                  <span class="st-name">启用 AI 编写</span>
                  <span class="st-desc">关掉之后侧边栏不再出现「AI 编写」入口</span>
                </div>
                <button
                  class="st-switch"
                  role="switch"
                  :aria-checked="state.ai.enabled"
                  :class="{ on: state.ai.enabled }"
                  @click="store.setAiConfig({ enabled: !state.ai.enabled })"
                >
                  <span class="st-knob" />
                </button>
              </div>

              <div class="st-row">
                <div class="st-label">
                  <span class="st-name">服务商预设</span>
                  <span class="st-desc">都是 OpenAI 兼容接口；本机跑模型选 Ollama 或 LM Studio</span>
                </div>
                <!-- 预设用自绘下拉：原生 select 一展开就是一屏系统样式的
                     蓝色选中块，跟这个界面不是一套东西 -->
                <div class="st-drop">
                  <button
                    class="n-select st-select"
                    data-role="preset-select"
                    :class="{ on: presetOpen }"
                    :aria-expanded="presetOpen"
                    @click="presetOpen = !presetOpen"
                  >
                    <span class="n-select-name">{{ presetLabel }}</span>
                    <ChevronDown class="n-select-caret" :size="12" :stroke-width="2" />
                  </button>
                  <div v-if="presetOpen" class="n-menu n-menu-inline st-drop-menu">
                    <button
                      class="n-menu-item"
                      :class="{ on: !presetIndex }"
                      data-preset="自定义"
                      @click="pickPreset(-1)"
                    >
                      <span class="n-menu-name">自定义…</span>
                      <Check v-if="!presetIndex" :size="12" :stroke-width="2.2" />
                    </button>
                    <button
                      v-for="(p, i) in AI_PRESETS"
                      :key="p.label"
                      class="n-menu-item"
                      :class="{ on: presetIndex === i + 1 }"
                      :data-preset="p.label"
                      @click="pickPreset(i)"
                    >
                      <span class="n-menu-name">{{ p.label }}</span>
                      <Check v-if="presetIndex === i + 1" :size="12" :stroke-width="2.2" />
                    </button>
                  </div>
                </div>
              </div>

              <div class="st-row">
                <div class="st-label">
                  <span class="st-name">接口地址</span>
                  <span class="st-desc">末尾不要带 /chat/completions，程序会自动拼</span>
                </div>
                <div class="st-field">
                  <Link2 class="st-field-ico" :size="13" :stroke-width="1.9" />
                  <input
                    ref="urlInput"
                    v-model="state.ai.baseUrl"
                    class="st-input"
                    type="text"
                    placeholder="http://localhost:11434/v1"
                    spellcheck="false"
                  />
                </div>
              </div>

              <div class="st-row">
                <div class="st-label">
                  <span class="st-name">API Key</span>
                  <span class="st-desc">存在本机 localStorage，不会随笔记上传；本地模型可留空</span>
                </div>
                <div class="st-field">
                  <KeyRound class="st-field-ico" :size="13" :stroke-width="1.9" />
                  <input
                    v-model="state.ai.apiKey"
                    class="st-input"
                    :type="showKey ? 'text' : 'password'"
                    placeholder="留空则不发送鉴权头"
                    spellcheck="false"
                  />
                  <button
                    class="st-eye"
                    :title="showKey ? '隐藏' : '显示'"
                    @click="showKey = !showKey"
                  >
                    <EyeOff v-if="showKey" :size="13" :stroke-width="1.9" />
                    <Eye v-else :size="13" :stroke-width="1.9" />
                  </button>
                </div>
              </div>

              <div class="st-row">
                <div class="st-label">
                  <span class="st-name">模型名称</span>
                  <span class="st-desc">填服务商文档里写的那个名字，区分大小写</span>
                </div>
                <div class="st-field">
                  <Server class="st-field-ico" :size="13" :stroke-width="1.9" />
                  <input
                    v-model="state.ai.model"
                    class="st-input"
                    type="text"
                    placeholder="llama3.2"
                    spellcheck="false"
                  />
                  <button
                    v-if="testModels.length"
                    class="st-mini-btn"
                    @click="showModels = !showModels"
                  >
                    {{ showModels ? '收起' : `可选 ${testModels.length} 个` }}
                  </button>
                </div>
              </div>

              <div v-if="showModels && testModels.length" class="st-row st-row-sub">
                <div class="st-label">
                  <span class="st-name">可用模型</span>
                  <span class="st-desc">点一下即填入上方输入框</span>
                </div>
                <div class="st-chips">
                  <button
                    v-for="m in testModels"
                    :key="m"
                    class="st-chip"
                    :class="{ on: state.ai.model === m }"
                    @click="state.ai.model = m"
                  >
                    {{ m }}
                  </button>
                </div>
              </div>

              <div class="st-row">
                <div class="st-label">
                  <span class="st-name">温度</span>
                  <span class="st-desc">
                    {{ state.ai.temperature.toFixed(1) }} — 越高越发散，写作建议 0.6~0.8
                  </span>
                </div>
                <input
                  v-model.number="state.ai.temperature"
                  class="st-range"
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                />
              </div>

              <div class="st-row">
                <div class="st-label">
                  <span class="st-name">系统提示词</span>
                  <span class="st-desc">每次请求都会带上，用来约束语气和语言</span>
                </div>
                <textarea
                  v-model="state.ai.system"
                  class="st-textarea"
                  rows="3"
                  spellcheck="false"
                />
              </div>

              <div class="st-row st-row-last">
                <div class="st-label">
                  <span class="st-name">测试连接</span>
                  <span
                    class="st-desc"
                    :class="{ 'is-ok': testResult?.ok, 'is-bad': testResult && !testResult.ok }"
                  >
                    {{ testResult ? testResult.text : '会去拉一次 /models 列表' }}
                  </span>
                </div>
                <button class="st-btn" :disabled="testing" @click="testConnection">
                  <Loader2 v-if="testing" class="spin" :size="13" :stroke-width="2" />
                  <span>{{ testing ? '测试中…' : '测试连接' }}</span>
                </button>
              </div>
            </template>

            <!-- ══ 云同步 ══
                 WebDAV 一条协议覆盖坚果云 / InfiniCloud / 群晖 / Nextcloud。
                 密码是各家的「应用密码」而不是登录密码（坚果云在网页端
                 安全选项里生成），存在本机 localStorage，不随笔记上传。 -->
            <template v-else-if="section === 'sync'">
              <div class="st-row">
                <div class="st-label">
                  <span class="st-name">服务器地址</span>
                  <span class="st-desc">坚果云填 https://dav.jianguoyun.com/dav/ 就行</span>
                </div>
                <div class="st-field">
                  <Cloud class="st-field-ico" :size="13" :stroke-width="1.9" />
                  <input
                    v-model="state.sync.config.url"
                    class="st-input"
                    type="text"
                    placeholder="https://dav.jianguoyun.com/dav/"
                    spellcheck="false"
                    @change="store.setSyncConfig({ url: state.sync.config.url })"
                  />
                </div>
              </div>

              <div class="st-row">
                <div class="st-label">
                  <span class="st-name">账号</span>
                  <span class="st-desc">坚果云是注册邮箱</span>
                </div>
                <div class="st-field">
                  <input
                    v-model="state.sync.config.username"
                    class="st-input"
                    type="text"
                    placeholder="you@example.com"
                    spellcheck="false"
                    @change="store.setSyncConfig({ username: state.sync.config.username })"
                  />
                </div>
              </div>

              <div class="st-row">
                <div class="st-label">
                  <span class="st-name">应用密码</span>
                  <span class="st-desc">在服务商网页端生成；存本机，不随笔记上传</span>
                </div>
                <div class="st-field">
                  <input
                    v-model="state.sync.config.password"
                    class="st-input"
                    type="password"
                    placeholder="••••••••"
                    spellcheck="false"
                    @change="store.setSyncConfig({ password: state.sync.config.password })"
                  />
                </div>
              </div>

              <div class="st-row">
                <div class="st-label">
                  <span class="st-name">云端目录</span>
                  <span class="st-desc">默认用工作区文件夹的名字；没有会自动创建</span>
                </div>
                <div class="st-field">
                  <input
                    v-model="state.sync.config.dir"
                    class="st-input"
                    type="text"
                    :placeholder="workspaceDirName"
                    spellcheck="false"
                    @change="store.setSyncConfig({ dir: state.sync.config.dir })"
                  />
                </div>
              </div>

              <div class="st-row">
                <div class="st-label">
                  <span class="st-name">自动同步</span>
                  <span class="st-desc">打开应用时和每 10 分钟各同步一轮（当前：{{ state.sync.config.auto ? '开' : '关' }}）</span>
                </div>
                <button
                  class="st-switch"
                  role="switch"
                  :aria-checked="state.sync.config.auto"
                  :class="{ on: state.sync.config.auto }"
                  @click="store.setSyncConfig({ auto: !state.sync.config.auto })"
                >
                  <span class="st-knob" />
                </button>
              </div>

              <div class="st-row st-row-last">
                <div class="st-label">
                  <span class="st-name">立即同步</span>
                  <span
                    class="st-desc"
                    :class="{ 'is-ok': state.sync.status === 'ok', 'is-bad': state.sync.status === 'error' }"
                  >
                    {{ state.sync.message || '上传 / 下载两边改过的文件；冲突会留底不覆盖' }}
                  </span>
                </div>
                <button class="st-btn" :disabled="state.sync.status === 'busy'" @click="store.runSync()">
                  <RefreshCw
                    class="spin"
                    :class="{ 'is-spinning': state.sync.status === 'busy' }"
                    :size="13"
                    :stroke-width="2"
                  />
                  <span>{{ state.sync.status === 'busy' ? '同步中…' : '立即同步' }}</span>
                </button>
              </div>

              <div class="st-row">
                <div class="st-label">
                  <span class="st-name">测试连接</span>
                  <span class="st-desc">只验证地址和密码，不动任何文件</span>
                </div>
                <button class="st-btn" :disabled="state.sync.status === 'busy'" @click="store.testSync()">
                  <span>测试连接</span>
                </button>
              </div>

              <div class="st-note">
                这版同步不做删除：在一台设备上删掉的笔记，云端那份会留下来。两边同时改过的文件算冲突——你的本地版本会改名成
                xxx.conflict-时间.md 留底，再落云端版本，谁的字都不会丢。
              </div>
            </template>

            <!-- ══ 关于 ══
                 以前是一段说明文字加两张清单，像一份说明书。
                 改成「一块带标的头图 + 四张特性卡 + 两张清单」：
                 第一眼看到的是这个应用长什么样、能干什么，
                 版本号和运行环境退到下面，需要的时候才看。 -->
            <template v-else>
              <div class="ab-hero">
                <span class="ab-hero-glow" aria-hidden="true" />
                <span class="ab-mark" aria-hidden="true">
                  <!-- 关于页这枚标用应用图标本身：它是「这个应用长什么样」
                       的直接回答，52px 也足够撑住位图细节。 -->
                  <img :src="appIcon" width="48" height="48" alt="Nota" />
                </span>
                <span class="ab-hero-meta">
                  <span class="ab-hero-name">
                    Nota
                    <span class="ab-hero-tag">本地优先</span>
                  </span>
                  <span class="ab-hero-ver">
                    <span class="ab-dot" />
                    版本 {{ APP_VERSION }}
                  </span>
                </span>
                <span class="ab-hero-note">纯本地 · 无账号 · 无服务端</span>
              </div>

              <p class="ab-lead">
                一个轻量的本地 Markdown 笔记应用。笔记就是普通的 <code>.md</code> 文件，
                放在你自己选的目录里，随时可以用别的编辑器打开、用 Git 管理、直接拷走。
                没有账号，没有服务端，没有云端同步 —— 所有东西都留在你自己的磁盘上。
              </p>

              <div class="ab-cards">
                <div v-for="f in ABOUT_FEATURES" :key="f.title" class="ab-card">
                  <span class="ab-card-ico"><component :is="f.icon" :size="15" :stroke-width="1.9" /></span>
                  <span class="ab-card-title">{{ f.title }}</span>
                  <span class="ab-card-desc">{{ f.desc }}</span>
                </div>
              </div>

              <div class="st-h4">运行环境</div>
              <div class="ab-env">
                <div class="ab-env-cell">
                  <span class="ab-env-k">Electron</span>
                  <span class="ab-env-v">{{ env.electron || '—' }}</span>
                </div>
                <div class="ab-env-cell">
                  <span class="ab-env-k">Chromium</span>
                  <span class="ab-env-v">{{ env.chrome || '—' }}</span>
                </div>
                <div class="ab-env-cell">
                  <span class="ab-env-k">Node</span>
                  <span class="ab-env-v">{{ env.node || '—' }}</span>
                </div>
                <div class="ab-env-cell">
                  <span class="ab-env-k">平台</span>
                  <span class="ab-env-v">{{ envText }}</span>
                </div>
              </div>

              <div class="st-h4">快捷键</div>
              <div class="ab-keys">
                <div v-for="k in ABOUT_KEYS" :key="k.label" class="ab-key">
                  <span>{{ k.label }}</span><kbd>{{ k.key }}</kbd>
                </div>
              </div>

              <p class="ab-foot">
                © 2026 YMTJ0522 · 用 Electron + Vue 3 + CodeMirror 6 写的本地小工具
              </p>
            </template>
          </div>

          <!-- 底栏：只回滚当前这页，不做全局清除 -->
          <footer v-if="RESET_LABEL[section]" class="st-foot">
            <span class="st-foot-hint">所有改动即时生效，无需重启</span>
            <button class="st-reset" @click="resetSection">
              <RotateCcw :size="12" :stroke-width="1.9" />
              <span>{{ RESET_LABEL[section] }}</span>
            </button>
          </footer>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.st-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--n-mask);
  backdrop-filter: blur(2px);
  animation: st-fade 120ms var(--n-ease);
}

/* 横向：左导航固定 168px，右内容自适应 */
.st {
  display: flex;
  width: 780px;
  max-width: 100%;
  height: 560px;
  max-height: 100%;
  background: var(--n-raised);
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-lg);
  box-shadow: var(--n-shadow-xl);
  overflow: hidden;
  animation: st-in 150ms var(--n-ease);
}

.st-nav {
  flex: none;
  width: 168px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 12px 10px;
  background: var(--n-sunken);
  border-right: 1px solid var(--n-line);
}

.st-nav-title {
  padding: 4px 8px 10px;
  font-size: 13.5px;
  font-weight: 650;
  color: var(--n-fg);
}

.st-nav-item {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 30px;
  padding: 0 8px;
  border-radius: var(--n-r-md);
  color: var(--n-fg-dim);
  text-align: left;
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.st-nav-ico {
  flex: none;
  display: inline-flex;
  color: var(--n-fg-faint);
  transition: color var(--n-dur) var(--n-ease);
}

.st-nav-ico svg {
  fill: none;
  stroke: currentColor;
}

.st-nav-label {
  font-size: 12.5px;
  font-weight: 500;
}

.st-nav-item:hover {
  background: var(--n-raised);
  color: var(--n-fg);
}

.st-nav-item.on {
  background: var(--n-accent-soft);
  color: var(--n-fg);
}

.st-nav-item.on .st-nav-ico {
  color: var(--n-accent);
}

.st-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.st-head {
  flex: none;
  height: 46px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px 0 20px;
  border-bottom: 1px solid var(--n-line);
}

.st-title {
  margin: 0;
  font-size: 13.5px;
  font-weight: 650;
  color: var(--n-fg);
}

.st-x {
  padding: 0;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-dim);
}

.st-x svg {
  fill: none;
  stroke: currentColor;
}

.st-x:hover {
  background: var(--n-bg);
  color: var(--n-fg);
}

.st-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 20px 18px;
}

/* ── 行：左侧说明，右侧控件 ──
   统一 300px 的控件区宽度，让整页的输入框右边沿对齐成一条线。 */
.st-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  align-items: center;
  gap: 16px;
  padding: 11px 0;
  border-bottom: 1px solid var(--n-line);
}

.st-row:last-child,
.st-row-last {
  border-bottom: none;
}

.st-row-sub {
  padding-top: 4px;
  border-bottom: none;
}

.st-label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.st-name {
  font-size: 13px;
  color: var(--n-fg);
}

.st-desc {
  font-size: 11.5px;
  color: var(--n-fg-faint);
  line-height: 1.5;
}

.st-value {
  justify-self: end;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--n-fg-dim);
}

.st-text {
  margin: 0 0 10px;
  font-size: 12.5px;
  line-height: 1.8;
  color: var(--n-fg-dim);
}

.st-muted {
  color: var(--n-fg-faint);
}

.st-text code {
  font-family: var(--n-font-mono);
  font-size: 0.92em;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--n-code-bg);
  color: var(--n-code-fg);
}

.st-btn {
  justify-self: end;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--n-line-strong);
  border-radius: var(--n-r-md);
  font-size: 12.5px;
  color: var(--n-fg);
  background: var(--n-bg);
  transition: border-color var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

/* 云同步页底部那条说明：跨列的整行小字，交代这版同步不做什么 */
.st-note {
  grid-column: 1 / -1;
  margin-top: 2px;
  padding: 9px 12px;
  border: 1px dashed var(--n-line);
  border-radius: var(--n-r-md);
  font-size: 11.5px;
  line-height: 1.75;
  color: var(--n-fg-faint);
}

.st-btn:hover:not(:disabled) {
  border-color: var(--n-accent);
  color: var(--n-accent);
}

.st-btn:disabled {
  opacity: 0.55;
  cursor: default;
}

/* 分段控件：和顶栏视图切换同款 */
.st-seg {
  justify-self: end;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: var(--n-r-md);
  background: var(--n-bg);
  border: 1px solid var(--n-line);
}

.st-seg-btn {
  height: 26px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 11px;
  border-radius: var(--n-r-sm);
  font-size: 12.5px;
  color: var(--n-fg-dim);
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.st-seg-btn svg {
  fill: none;
  stroke: currentColor;
}

.st-seg-btn:hover {
  color: var(--n-fg);
}

.st-seg-btn.on {
  background: var(--n-raised);
  color: var(--n-accent);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
}

/* 强调色板：一圈圆点，当前项用一圈描边标出来 */
.st-swatches {
  justify-self: end;
  display: flex;
  gap: 6px;
}
.st-swatch {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 24px;
  height: 24px;
  /* 浏览器默认给 button 留了 1px 6px 的内边距，不清掉的话
     24px 的圆只剩 10px 可以放内容，里面的色点会被挤成椭圆 */
  padding: 0;
  border-radius: 50%;
  border: 1px solid transparent;
  /* 选中圈的颜色由模板按色板值写到 --swatch-c 上，
     没拿到值时退回当前主题的强调色 */
  transition: border-color var(--n-dur) var(--n-ease);
}
.st-swatch-dot {
  /* 绝对定位 + inset:0 + margin:auto 才是真正的同心：
     靠 flex 居中时，外圈那 1px 描边会把内容盒挤歪半像素，
     七个点排一行就能看出「圈和点不是同一个圆心」。 */
  position: absolute;
  inset: 0;
  margin: auto;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  transition: width var(--n-dur) var(--n-ease), height var(--n-dur) var(--n-ease);
}
.st-swatch:hover {
  border-color: var(--n-line-strong);
}
/* 选中：外圈不再是黑白，而是这一格自己的颜色——
   一眼就能看出「现在用的是哪个色」 */
.st-swatch.on {
  border-color: var(--swatch-c, var(--n-accent));
}
/* 选中时色点收小一点，和外圈之间留出一圈底色，
   读起来才是「圈套点」而不是一个大圆 */
.st-swatch.on .st-swatch-dot {
  width: 12px;
  height: 12px;
}

/* 开关 */
.st-switch {
  justify-self: end;
  flex: none;
  width: 38px;
  height: 22px;
  padding: 2px;
  border-radius: 999px;
  background: var(--n-line-strong);
  transition: background var(--n-dur) var(--n-ease);
}

.st-switch.on {
  background: var(--n-accent);
}

.st-knob {
  padding: 0;
  display: block;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.28);
  transition: transform var(--n-dur) var(--n-ease);
}

.st-switch.on .st-knob {
  transform: translateX(16px);
}

/* ── 输入类控件：图标 + 输入框 + 尾随按钮 ── */
.st-field {
  justify-self: end;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 7px;
}

.st-field-ico {
  flex: none;
  fill: none;
  stroke: currentColor;
  color: var(--n-fg-faint);
}

.st-input,
.st-textarea,
.st-select {
  min-width: 0;
  flex: 1;
  padding: 7px 10px;
  border: 1px solid var(--n-line-strong);
  border-radius: var(--n-r-md);
  background: var(--n-bg);
  font-family: var(--n-font-ui);
  font-size: 12.5px;
  color: var(--n-fg);
  outline: none;
  transition: border-color var(--n-dur) var(--n-ease);
}

/* ── 自绘下拉（服务商预设） ── */
.st-drop {
  position: relative;
  flex: 1;
  min-width: 0;
  justify-self: end;
}

/* 宽度跟着选项文字走：撑满 300px 的控件列纯属浪费，
   但也不能比按钮窄太多，所以给一个 150px 的下限 */
.st-drop-menu {
  right: 0;
  width: max-content;
  min-width: 150px;
  max-width: 240px;
  max-height: 260px;
  overflow-y: auto;
}

.st-textarea {
  justify-self: end;
  width: 100%;
  resize: vertical;
  min-height: 62px;
  line-height: 1.6;
}

.st-select {
  justify-self: end;
  flex: none;
  width: 100%;
  padding: 6px 8px;
  height: 32px;
}

.st-input:focus,
.st-textarea:focus,
.st-select:focus {
  border-color: var(--n-accent);
}

.st-eye {
  padding: 0;
  flex: none;
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-faint);
}

.st-eye svg {
  fill: none;
  stroke: currentColor;
}

.st-eye:hover {
  background: var(--n-raised);
  color: var(--n-fg);
}

.st-mini-btn {
  flex: none;
  padding: 0 10px;
  height: 30px;
  border: 1px solid var(--n-line-strong);
  border-radius: var(--n-r-md);
  font-size: 11.5px;
  color: var(--n-fg-dim);
  white-space: nowrap;
}
.st-mini-btn:hover {
  border-color: var(--n-accent);
  color: var(--n-accent);
}

/* 测试成功后列出的可用模型 */
.st-chips {
  justify-self: end;
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.st-chip {
  max-width: 100%;
  padding: 3px 9px;
  border: 1px solid var(--n-line-strong);
  border-radius: 999px;
  font-family: var(--n-font-mono);
  font-size: 11px;
  color: var(--n-fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.st-chip:hover {
  border-color: var(--n-accent);
  color: var(--n-accent);
}
.st-chip.on {
  background: var(--n-accent-soft);
  border-color: var(--n-accent);
  color: var(--n-accent);
}

.st-range {
  justify-self: end;
  width: 180px;
  accent-color: var(--n-accent);
}

.st-desc.is-ok {
  color: var(--n-ok);
}
.st-desc.is-bad {
  color: var(--n-danger);
}
.spin {
  animation: st-spin 900ms linear infinite;
}
@keyframes st-spin {
  to {
    transform: rotate(360deg);
  }
}

/* ── 底栏 ── */
.st-foot {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 20px;
  border-top: 1px solid var(--n-line);
  background: color-mix(in oklab, var(--n-sunken) 60%, var(--n-raised));
}

.st-foot-hint {
  font-size: 11px;
  color: var(--n-fg-faint);
}

.st-reset {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 11px;
  border: 1px solid var(--n-line-strong);
  border-radius: var(--n-r-md);
  font-size: 12px;
  color: var(--n-fg-dim);
  transition: border-color var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.st-reset svg {
  fill: none;
  stroke: currentColor;
}

.st-reset:hover {
  border-color: var(--n-accent);
  color: var(--n-accent);
}

/* ══ 关于 ══ */
/* 头图：一块带渐变与光晕的横幅，不再是「一行信息 + 一张清单」。
   内容是「这是什么 + 什么版本」，右下角那句话负责把定位说清楚。 */
.ab-hero {
  position: relative;
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 16px 18px;
  margin: 12px 0 14px;
  border: 1px solid color-mix(in oklab, var(--n-accent) 22%, var(--n-line));
  border-radius: var(--n-r-lg);
  background:
    linear-gradient(
      135deg,
      color-mix(in oklab, var(--n-accent) 14%, var(--n-bg)),
      color-mix(in oklab, var(--n-accent) 4%, var(--n-bg))
    );
  overflow: hidden;
}

/* 右上角一团柔光：让渐变有个来源，不至于看着像色块没铺匀 */
.ab-hero-glow {
  position: absolute;
  top: -70px;
  right: -50px;
  width: 210px;
  height: 210px;
  border-radius: 50%;
  background: radial-gradient(
    circle,
    color-mix(in oklab, var(--n-accent) 26%, transparent),
    transparent 68%
  );
  pointer-events: none;
}

.ab-mark {
  position: relative;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  border-radius: var(--n-r-lg);
  overflow: hidden;
}

.ab-mark img {
  width: 48px;
  height: 48px;
  border-radius: calc(var(--n-r-lg) - 2px);
}

.ab-hero-meta {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.ab-hero-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 19px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--n-fg);
  line-height: 1.2;
}

.ab-hero-tag {
  padding: 2px 8px;
  border-radius: 999px;
  background: color-mix(in oklab, var(--n-accent) 18%, transparent);
  color: var(--n-accent);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0;
}

.ab-hero-ver {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  font-family: var(--n-font-mono);
  color: var(--n-fg-dim);
}

.ab-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--n-ok);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--n-ok) 22%, transparent);
}

.ab-hero-note {
  position: relative;
  margin-left: auto;
  flex: none;
  padding-left: 12px;
  font-size: 11px;
  color: var(--n-fg-faint);
  text-align: right;
  line-height: 1.5;
}

.ab-lead {
  margin: 0 0 4px;
  font-size: 12.5px;
  line-height: 1.85;
  color: var(--n-fg-dim);
}

.ab-lead code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--n-surface);
  border: 1px solid var(--n-line);
  font-family: var(--n-font-mono);
  font-size: 11.5px;
  color: var(--n-fg);
}

/* 四张特性卡：两列，一眼扫完「这软件能干什么」 */
.ab-cards {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: 14px;
}

.ab-card {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr);
  grid-template-rows: auto auto;
  align-items: center;
  gap: 2px 9px;
  padding: 10px 12px;
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-md);
  background: var(--n-bg);
  transition: border-color var(--n-dur) var(--n-ease);
}

.ab-card:hover {
  border-color: color-mix(in oklab, var(--n-accent) 42%, var(--n-line));
}

.ab-card-ico {
  padding: 0;
  grid-row: 1 / span 2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: var(--n-r-sm);
  background: var(--n-accent-soft);
  color: var(--n-accent);
}

.ab-card-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--n-fg);
}

.ab-card-desc {
  font-size: 11px;
  color: var(--n-fg-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 运行环境：四格 2×2，比原来四行「左标签右值」短一半 */
.ab-env {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1px;
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-md);
  background: var(--n-line);
  overflow: hidden;
}

.ab-env-cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 13px;
  background: var(--n-bg);
}

.ab-env-k {
  font-size: 10.5px;
  letter-spacing: 0.04em;
  color: var(--n-fg-faint);
}

.ab-env-v {
  font-family: var(--n-font-mono);
  font-size: 12px;
  color: var(--n-fg);
}

/* 快捷键：两列，行高比原来矮，一屏能看全 */
.ab-keys {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px 18px;
}

.ab-key {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 0;
  font-size: 12.5px;
  color: var(--n-fg-dim);
  border-bottom: 1px dashed color-mix(in oklab, var(--n-line) 70%, transparent);
}

.ab-foot {
  margin: 18px 0 2px;
  padding-top: 12px;
  border-top: 1px solid var(--n-line);
  font-size: 11px;
  color: var(--n-fg-faint);
  text-align: center;
}

/* 小节标题：比分区导航矮一档，用来分段但不抢视线 */
.st-h4 {
  margin: 18px 0 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--n-fg-faint);
}

.st-rows {
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-md);
  overflow: hidden;
}
.st-mini {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 13px;
  font-size: 12.5px;
  color: var(--n-fg-dim);
}
.st-mini + .st-mini {
  border-top: 1px solid var(--n-line);
}
.st-mono {
  font-family: var(--n-font-mono);
  font-size: 11.5px;
  color: var(--n-fg);
}

.st-keys {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 14px;
}

.st-key {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 5px 0;
  font-size: 12.5px;
  color: var(--n-fg-dim);
}

.st-key kbd {
  font-family: var(--n-font-mono);
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 5px;
  background: var(--n-bg);
  border: 1px solid var(--n-line);
  color: var(--n-fg-faint);
}

@keyframes st-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes st-in {
  from { opacity: 0; transform: translateY(-8px) scale(0.99); }
  to { opacity: 1; transform: none; }
}
</style>

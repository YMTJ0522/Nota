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
  StickyNote,
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

/**
 * 重看新手引导。
 *
 * 这个入口原来挂在左侧栏底栏，跟「设置」并排两枚 28px 的图标 ——
 * 底栏就 231px 宽，多一枚按钮直接从文件夹名字里抠，长一点的名字就只剩
 * 省略号。引导是低频动作，挪进设置里最合适。
 *
 * 浮层由 App.vue 监听 `nota:tour` 打开；先关面板再发事件，
 * 那几条提示瞄的是主界面，压在设置上面就全指错了。
 */
function replayTour() {
  emit('close')
  window.setTimeout(() => window.dispatchEvent(new CustomEvent('nota:tour')), 160)
}

/** 版本号由 vite define 注入（值取自 package.json），避免两处写死对不上 */
const APP_VERSION: string = __APP_VERSION__

/* ── 检查更新 ──
   判据是官网 info.json 里的 version，软件里不存「最新是多少」。
   只报不装：安装包没签名，静默下载再执行会被 SmartScreen 拦，装进
   Program Files 还要管理员权限 —— 半途失败留下半个程序，比不更新更糟。

   结果分两处摆（按钮上一句话 + 头图下面一条横幅），而不是挤在一行：
   设置面板这个宽度，「有新版本 2.7.9 · 70 MB · 去下载」会换行断得很难看。 */
type UpdState = 'idle' | 'checking' | 'latest' | 'newer' | 'failed'

const updState = ref<UpdState>('idle')
const updInfo = ref<{ latest: string; size: number; url: string; error?: string; detail?: string } | null>(
  null,
)

const updText = computed(() => {
  switch (updState.value) {
    case 'checking':
      return '检查中'
    case 'latest':
      return '已是最新'
    case 'newer':
      return '有新版'
    case 'failed':
      return '检查失败'
    default:
      return '检查更新'
  }
})

/** 安装包大小按 MB 取整；官网没写 size 时这段整个不显示 */
const updMB = computed(() => {
  const n = updInfo.value?.size ?? 0
  return n > 0 ? Math.round(n / 1048576) : 0
})

async function checkNow() {
  if (updState.value === 'checking') return
  updState.value = 'checking'
  try {
    const r = await window.api.checkUpdate(APP_VERSION)
    updInfo.value = r
    updState.value = r.error ? 'failed' : r.newer ? 'newer' : 'latest'
  } catch (e) {
    // 主进程都调不通（极少见）也得给个结果，不能停在「检查中」上转一辈子
    updInfo.value = {
      latest: '',
      size: 0,
      url: '',
      error: e instanceof Error ? e.message : String(e),
    }
    updState.value = 'failed'
  }
}

/* ── 桌面整合：开机自启 / 全局快捷键 ──
 *
 * 这两项没有跟其他偏好一起放 localStorage，而是由主进程存在
 * %LOCALAPPDATA%\Nota\prefs.json。原因很实际：它们必须在**没有窗口**的
 * 时候也生效 —— 主窗收在托盘里时渲染进程已经销毁，开机自启那一轮更是
 * 压根不建窗口。放在 localStorage 里，主进程就读不到。
 *
 * 所以这里每次打开面板都重新问一次主进程，不做本地缓存。 */
const desk = ref<DesktopPrefsInfo | null>(null)
const deskBusy = ref(false)

async function loadDesk() {
  try {
    desk.value = await window.api.desktopPrefs()
  } catch {
    desk.value = null
  }
}

function toast(text: string) {
  window.dispatchEvent(new CustomEvent('nota:toast', { detail: text }))
}

/** 开机自启。免安装版和开发环境下按钮是灰的 —— 那两种身份写进注册表的
    路径都是临时的，重启后指向一个不存在的地方，属于「设了但没生效」 */
async function toggleAutoStart() {
  if (!desk.value || deskBusy.value || !desk.value.canAutoStart) return
  const want = !desk.value.openAtLogin
  deskBusy.value = true
  try {
    const ok = await window.api.setAutoStart(want)
    await loadDesk()
    if (want && !ok) toast('开机自启没设上，可能被安全软件拦了')
  } finally {
    deskBusy.value = false
  }
}

async function toggleHotkey() {
  if (!desk.value || deskBusy.value) return
  const want = !desk.value.hotkey
  deskBusy.value = true
  try {
    const r = await window.api.setHotkey(want)
    await loadDesk()
    if (want && !r.ok) toast(r.error || '快捷键被别的程序占用了')
  } finally {
    deskBusy.value = false
  }
}

async function revealStickyDir() {
  await window.api.revealStickies()
}

const SECTIONS: { id: SectionId; label: string; icon: unknown }[] = [
  { id: 'general', label: '通用', icon: Settings2 },
  { id: 'sticky', label: '便签', icon: StickyNote },
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'editor', label: '编辑', icon: Type },
  { id: 'ai', label: 'AI 编写', icon: Sparkles },
  { id: 'sync', label: '云同步', icon: Cloud },
  { id: 'about', label: '关于', icon: Info },
]

const section = ref<SectionId>('general')
const current = computed(() => SECTIONS.find((s) => s.id === section.value)!)

/**
 * 换分区时把内容区拨回顶部。
 * 上一页滚到一半，下一页会接在那个位置上 —— 尤其是从「关于」那种长页
 * 切回「通用」这种短页，一进来就是中间那一截，看着像点错了。
 */
const bodyEl = ref<HTMLElement | null>(null)
function resetScroll() {
  if (bodyEl.value) bodyEl.value.scrollTop = 0
}

/** 外部（工具栏 AI 菜单、聊天页的设置按钮）指定分区时跟过去 */
watch(
  () => [props.open, props.section] as const,
  ([open, want]) => {
    if (!open || !want) return
    if (SECTIONS.some((s) => s.id === want)) section.value = want
    // 托盘那边也能改这两项，所以每次打开面板都重新问一次主进程
    void loadDesk()
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
/** 数据存放位置。这一版把设置/便签/对话全收进了库目录，
    关于页得如实写出来 —— 用户最常问的就是「我的东西到底在哪」 */
const dataLoc = ref({ vault: '', nota: '', machine: '' })
const PLATFORM_TEXT: Record<string, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
}
const envText = computed(() => {
  const p = PLATFORM_TEXT[env.value.platform] ?? env.value.platform
  return env.value.arch ? `${p} · ${env.value.arch}` : p || '—'
})

/** 在资源管理器里打开一个目录。路径为空时按钮不渲染，这里只是兜底 */
function reveal(p: string) {
  if (p) void window.api.revealPath(p)
}

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
    /* 每次打开都重取：可能刚切过库 */
    try {
      dataLoc.value = await window.api.dataLocation()
    } catch {
      /* 拿不到就不显示路径，不影响别处 */
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

/**
 * 用户点过「自定义…」。
 *
 * 只靠地址反推不够：地址还停在一套预设上时点「自定义」，反推出来的仍是那套
 * 预设，于是下拉文字一动不动 —— 点了没反应。可「自定义」又不是一种地址，
 * 没法从 baseUrl 里读出来，只能当场记一笔。
 *
 * 这笔只在**手改地址或重选预设**时清掉：地址变了，反推才是准的。
 * 不落盘 —— 关掉设置再打开，显示的仍然由地址决定，那才是它真实的样子。
 */
const presetCustom = ref(false)
const isCustom = computed(() => presetCustom.value || !presetIndex.value)
const presetLabel = computed(() =>
  isCustom.value ? '自定义…' : AI_PRESETS[presetIndex.value - 1].label,
)

/** 「自定义…」是一个动作 + 一枚指示灯：先把光标送进接口地址那一格（接着打字就行），
    同时把下拉文字切成「自定义」。匹配不上任何预设时那一行本来就会打勾。 */
const urlInput = ref<HTMLInputElement | null>(null)

function pickPreset(i: number) {
  presetOpen.value = false
  if (i < 0) {
    presetCustom.value = true
    urlInput.value?.focus()
    urlInput.value?.select()
    return
  }
  const p = AI_PRESETS[i]
  if (!p) return
  presetCustom.value = false
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
/**
 * Esc 一次退一层：先收里面的下拉（模型列表），再关面板本身。
 *
 * 以前这里只管下拉 —— 面板本身按 Esc 关不掉，可关闭按钮的 title 一直写着
 * 「关闭 (Esc)」。承诺了却没做到，用户按一下没反应，会以为界面卡住了。
 */
function onEsc(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (presetOpen.value) {
    e.stopPropagation()
    presetOpen.value = false
    return
  }
  if (!props.open) return
  e.stopPropagation()
  emit('close')
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
  sticky: '',
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

          <div ref="bodyEl" class="st-body">
            <!-- 换分区：旧的一页先淡出，新的再淡入（mode="out-in"）。
                 不做重叠是因为各页高度差得多，叠在一起会先被拉长再回弹，
                 比直接硬切还难看。 -->
            <Transition name="st-swap" mode="out-in" @enter="resetScroll">
              <div :key="section" class="st-sec">
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

                <div class="st-row">
                  <div class="st-label">
                    <span class="st-name">新手引导</span>
                    <span class="st-desc">第一次打开会自动走一遍，看漏了可以再走一次</span>
                  </div>
                  <button class="st-btn" @click="replayTour">重看引导</button>
                </div>

                <!-- 开机自启放在「通用」而不是「便签」：它管的是整个程序上不上电，
                     只是便签最需要它（快捷键要在 Nota 没被打开时也管用） -->
                <div class="st-row">
                  <div class="st-label">
                    <span class="st-name">开机时自动启动</span>
                    <span class="st-desc">
                      {{
                        desk && !desk.canAutoStart
                          ? desk.portable
                            ? '免安装版不支持：解压路径每次都会变，注册表指向会失效'
                            : '仅安装版可用'
                          : '开机后静默待在托盘里，不占屏幕，快捷键随时可用'
                      }}
                    </span>
                  </div>
                  <button
                    class="st-switch"
                    role="switch"
                    :aria-checked="!!desk?.openAtLogin"
                    :class="{ on: !!desk?.openAtLogin }"
                    :disabled="!desk?.canAutoStart || deskBusy"
                    @click="toggleAutoStart"
                  >
                    <span class="st-knob" />
                  </button>
                </div>
              </template>

              <!-- ══ 便签 ══ -->
              <template v-else-if="section === 'sticky'">
                <div class="st-row">
                  <div class="st-label">
                    <span class="st-name">全局快捷键</span>
                    <span class="st-desc">在任何程序里按下都能弹出一张便签，连按连开</span>
                  </div>
                  <button
                    class="st-switch"
                    role="switch"
                    :aria-checked="!!desk?.hotkey"
                    :class="{ on: !!desk?.hotkey }"
                    :disabled="deskBusy"
                    @click="toggleHotkey"
                  >
                    <span class="st-knob" />
                  </button>
                </div>

                <!-- 被占用时把话说清楚：不写这句的话，用户按下去没反应，
                     只会以为是软件坏了 -->
                <div v-if="desk?.hotkeyError" class="st-row warn">
                  <div class="st-label">
                    <span class="st-name">快捷键被占用了</span>
                    <span class="st-desc">{{ desk.hotkeyError }}</span>
                  </div>
                </div>

                <div class="st-row">
                  <div class="st-label">
                    <span class="st-name">新便签</span>
                    <span class="st-desc">按一次出一张，位置会一张张错开，不会叠在一起</span>
                  </div>
                  <span class="st-keys">
                    <kbd v-for="k in (desk?.hotkeyNew ?? 'Alt+N').split('+')" :key="k">{{ k }}</kbd>
                  </span>
                </div>

                <div class="st-row">
                  <div class="st-label">
                    <span class="st-name">收起全部便签</span>
                    <span class="st-desc">一键把桌面上的纸都收进抽屉，内容还在，随时能捞回来</span>
                  </div>
                  <span class="st-keys">
                    <kbd v-for="k in (desk?.hotkeyCloseAll ?? 'Alt+Shift+N').split('+')" :key="k">{{ k }}</kbd>
                  </span>
                </div>

                <div class="st-row">
                  <div class="st-label">
                    <span class="st-name">单张便签</span>
                    <span class="st-desc">Esc 收起当前这张 · Ctrl+S 存进笔记本</span>
                  </div>
                </div>

                <div class="st-row">
                  <div class="st-label">
                    <span class="st-name">便签存在哪</span>
                    <span class="st-desc">
                      和笔记库分开存，换目录、拔硬盘都不影响记东西
                    </span>
                  </div>
                  <button class="st-btn" @click="revealStickyDir">打开文件夹</button>
                </div>

                <div class="st-row">
                  <div class="st-label">
                    <span class="st-name">存为笔记</span>
                    <span class="st-desc">
                      便签上点那个笔按钮，会存进当前库的「便签」目录；同名的自动加序号，不会盖掉旧笔记
                    </span>
                  </div>
                </div>

                <div class="st-row">
                  <div class="st-label">
                    <span class="st-name">关闭主窗口</span>
                    <span class="st-desc">
                      只是收进托盘，程序继续在后台跑 —— 否则快捷键会跟着一起失效。要退出请右键托盘图标
                    </span>
                  </div>
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
                        :class="{ on: isCustom }"
                        data-preset="自定义"
                        @click="pickPreset(-1)"
                      >
                        <span class="n-menu-name">自定义…</span>
                        <Check v-if="isCustom" :size="12" :stroke-width="2.2" />
                      </button>
                      <button
                        v-for="(p, i) in AI_PRESETS"
                        :key="p.label"
                        class="n-menu-item"
                        :class="{ on: !isCustom && presetIndex === i + 1 }"
                        :data-preset="p.label"
                        @click="pickPreset(i)"
                      >
                        <span class="n-menu-name">{{ p.label }}</span>
                        <Check
                          v-if="!isCustom && presetIndex === i + 1"
                          :size="12"
                          :stroke-width="2.2"
                        />
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
                      @input="presetCustom = false"
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
                      <button
                        type="button"
                        class="ab-upd"
                        :class="updState"
                        :disabled="updState === 'checking'"
                        @click="checkNow"
                      >
                        <Loader2 v-if="updState === 'checking'" :size="11" class="ab-upd-spin" />
                        {{ updText }}
                      </button>
                    </span>
                  </span>
                  <span class="ab-hero-note">纯本地 · 无账号 · 无服务端</span>
                </div>

                <!-- 更新结果。只在新版 / 失败时出现 —— 「已是最新」不值得再占一条，
                     那句话已经落在按钮上了，摆两遍等于同一件事说两次。 -->
                <div v-if="updState === 'newer'" class="ab-updbar is-newer">
                  <Sparkles :size="14" class="ab-updbar-ico" />
                  <span class="ab-updbar-text">
                    官网已发布 <b>v{{ updInfo?.latest }}</b>
                    <template v-if="updMB"> · 安装包 {{ updMB }} MB</template>
                  </span>
                  <a class="ab-updbar-btn" :href="updInfo?.url" target="_blank" rel="noreferrer">去下载</a>
                </div>
                <div v-else-if="updState === 'failed'" class="ab-updbar is-failed">
                  <span class="ab-updbar-text" :title="updInfo?.detail || ''">
                    {{ updInfo?.error || '没能取到版本信息' }}，稍后再试
                  </span>
                  <button type="button" class="ab-updbar-btn" @click="checkNow">重试</button>
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

                <div class="st-h4">数据存放</div>
                <!-- 一个库装完全部：笔记、附件、历史、图标、便签、设置、AI 配置、
                     对话记录。这里如实写出来，是因为「我的东西到底在哪」
                     是用户问得最多的那句，而对得上号的答案应该是一个能点开的路径。 -->
                <div class="ab-store">
                  <div class="ab-store-row">
                    <span class="ab-store-k">笔记库</span>
                    <span class="ab-store-v" :title="dataLoc.vault">
                      {{ dataLoc.vault || '还没有打开库' }}
                    </span>
                    <button
                      v-if="dataLoc.vault"
                      type="button"
                      class="ab-store-btn"
                      @click="reveal(dataLoc.vault)"
                    >
                      打开
                    </button>
                  </div>
                  <div class="ab-store-row">
                    <span class="ab-store-k">设置与便签</span>
                    <span class="ab-store-v" :title="dataLoc.nota">{{ dataLoc.nota }}</span>
                    <button type="button" class="ab-store-btn" @click="reveal(dataLoc.nota)">
                      打开
                    </button>
                  </div>
                  <p class="ab-store-note">
                    拷走上面这个库文件夹，笔记、附件、便签、设置、AI 配置和对话记录就全在里面了。
                  </p>
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
            </Transition>
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
  /* 不用 backdrop-filter：全窗模糊在软件合成下会把每次重绘拖到个位数帧率（实测 60 → 7），
     而 2px 的模糊肉眼几乎看不出来。改用纯色遮罩，遮罩本身已经够分层了。 */
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

.st-sec {
  min-width: 0;
}

/* 换分区：淡 + 一点上移，**不做左右位移** ——
   左右一动就会被读成「翻页」，可这里只是同一块面板换了内容。
   出去快、进来稍慢：先让位，再稳稳落定。 */
.st-swap-leave-active {
  /* 出去要快：从淡完到新内容挂载之间有段空白，留久了读起来是「闪了一下」。
     70ms 差不多是一眨眼的边缘，能看出来在退场，又来不及让人觉得空了。 */
  transition: opacity 70ms var(--n-ease);
}

.st-swap-leave-to {
  opacity: 0;
}

.st-swap-enter-active {
  transition:
    opacity 170ms var(--n-ease),
    transform 170ms var(--n-ease);
}

.st-swap-enter-from {
  opacity: 0;
  transform: translateY(5px);
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

/* 灰掉的开关要读得出来是「不能动」而不是「关着」：
   只降透明度的话，用户会以为是关着、然后反复点 */
.st-switch:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 快捷键键帽。拆成一个个 kbd 而不是一整串文字，
   是因为 Alt+N 里的加号在正文里太小，一眼扫不到边界 */
.st-keys {
  justify-self: end;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.st-keys kbd {
  display: inline-block;
  min-width: 18px;
  padding: 2px 5px;
  border-radius: 4px;
  background: var(--n-raised);
  border: 1px solid var(--n-line-strong);
  border-bottom-width: 2px;
  font-family: inherit;
  font-size: 11px;
  line-height: 1.2;
  text-align: center;
  color: var(--n-fg-dim);
}

/* 出问题的那一行（快捷键被占用）带一点底色，否则在十几行里根本找不到 */
.st-row.warn {
  border-radius: 8px;
  background: color-mix(in oklab, #c0392b 8%, transparent);
  box-shadow: inset 2px 0 0 #c0392b;
  padding-left: 10px;
}
.st-row.warn .st-name {
  color: #c0392b;
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
/* 数据存放：两行路径 + 一个「打开」。
   路径一定比栏宽，所以值那一格必须 min-width:0，否则 flex 子项按内容撑开，
   整块会被顶出面板（这是这套面板里反复踩到的那条）。 */
.ab-store {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--n-surface);
  border: 1px solid var(--n-line);
}
.ab-store-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.ab-store-k {
  flex: none;
  width: 5.2em;
  font-size: 12px;
  color: var(--n-fg-faint);
}
.ab-store-v {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-family: var(--n-font-mono);
  color: var(--n-fg-mute);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ab-store-btn {
  flex: none;
  padding: 2px 8px;
  font-size: 11.5px;
  border-radius: 6px;
  border: 1px solid var(--n-line);
  background: transparent;
  color: var(--n-fg-mute);
  cursor: pointer;
}
.ab-store-btn:hover {
  color: var(--n-fg);
  background: var(--n-hover);
}
.ab-store-note {
  margin: 2px 0 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--n-fg-faint);
}

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

/* 版本号后面那枚小药丸。默认几乎不像按钮（淡到接近注释），
   因为「检查更新」是低频动作，不该在头图上抢视线。 */
.ab-upd {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 2px;
  padding: 1px 7px;
  border: 1px solid var(--n-line);
  border-radius: 999px;
  background: transparent;
  font: inherit;
  font-size: 10.5px;
  font-family: var(--n-font-mono);
  color: var(--n-fg-faint);
  cursor: pointer;
  transition:
    color 0.15s,
    border-color 0.15s,
    background 0.15s;
}

.ab-upd:hover:not(:disabled) {
  color: var(--n-fg);
  border-color: var(--n-line-strong);
}

.ab-upd:disabled {
  cursor: default;
  opacity: 0.7;
}

.ab-upd.latest {
  color: var(--n-ok);
  border-color: color-mix(in oklab, var(--n-ok) 38%, var(--n-line));
}

.ab-upd.newer {
  color: var(--n-accent);
  border-color: color-mix(in oklab, var(--n-accent) 45%, var(--n-line));
  background: color-mix(in oklab, var(--n-accent) 12%, transparent);
}

.ab-upd-spin {
  animation: ab-spin 0.9s linear infinite;
}

@keyframes ab-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 更新结果条：一条窄横幅，跟头图同宽。不做成对话框 ——
   检查更新不该打断正在写东西的人，也不该让人以为「不点就装不上」。 */
.ab-updbar {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: -4px 0 14px;
  padding: 9px 13px;
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-md);
  font-size: 12px;
  line-height: 1.5;
  color: var(--n-fg-dim);
}

.ab-updbar.is-newer {
  border-color: color-mix(in oklab, var(--n-accent) 34%, var(--n-line));
  background: color-mix(in oklab, var(--n-accent) 9%, var(--n-bg));
  color: var(--n-fg);
}

.ab-updbar.is-newer b {
  font-family: var(--n-font-mono);
  color: var(--n-accent);
}

.ab-updbar-text {
  min-width: 0;
}

.ab-updbar-ico {
  flex: none;
  color: var(--n-accent);
}

.ab-updbar-btn {
  flex: none;
  margin-left: auto;
  padding: 3px 11px;
  border: 1px solid color-mix(in oklab, var(--n-accent) 45%, var(--n-line));
  border-radius: 999px;
  background: transparent;
  font: inherit;
  font-size: 11.5px;
  color: var(--n-accent);
  text-decoration: none;
  cursor: pointer;
  transition: background 0.15s;
}

.ab-updbar-btn:hover {
  background: color-mix(in oklab, var(--n-accent) 14%, transparent);
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

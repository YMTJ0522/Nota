<script setup lang="ts">
import { ref, computed } from 'vue'
import {
  BrainCircuit,
  Cloud,
  Columns2,
  Database,
  Eye,
  Info,
  Moon,
  Palette,
  Pencil,
  RefreshCw,
  Sun,
  Type,
  UserRound,
  X,
} from 'lucide-vue-next'
import { store } from '@/store'
import type { ViewMode } from '@/store'

/**
 * 设置面板：左侧分区导航 + 右侧内容，横向铺开。
 *
 * 只放真正生效的项。同步 / MCP / 账户这几页如实写明「尚未接入」——
 * 摆一堆点了没反应的开关，比没有设置更伤信任。
 */
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const { state } = store

/** 版本号由 vite define 注入（值取自 package.json），避免两处写死对不上 */
const APP_VERSION: string = __APP_VERSION__

type SectionId =
  | 'appearance'
  | 'editor'
  | 'backup'
  | 'sync'
  | 'mcp'
  | 'account'
  | 'data'
  | 'about'

const SECTIONS: { id: SectionId; label: string; icon: unknown }[] = [
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'editor', label: '编辑器', icon: Type },
  { id: 'backup', label: '备份', icon: Cloud },
  { id: 'sync', label: '同步', icon: RefreshCw },
  { id: 'mcp', label: 'MCP', icon: BrainCircuit },
  { id: 'account', label: '账户', icon: UserRound },
  { id: 'data', label: '数据', icon: Database },
  { id: 'about', label: '关于', icon: Info },
]

const section = ref<SectionId>('appearance')
const current = computed(() => SECTIONS.find((s) => s.id === section.value)!)

const VIEWS: { id: ViewMode; label: string; icon: unknown }[] = [
  { id: 'write', label: '编辑', icon: Pencil },
  { id: 'split', label: '分栏', icon: Columns2 },
  { id: 'read', label: '预览', icon: Eye },
]

/** 工作区路径太长，这里只把最后一段放大显示，完整路径挂在 title 上 */
const rootTail = computed(() => {
  const r = state.root ?? ''
  if (!r) return ''
  const parts = r.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? r
})

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
            <!-- 外观 -->
            <template v-if="section === 'appearance'">
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
            </template>

            <!-- 编辑器 -->
            <template v-else-if="section === 'editor'">
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
                  <span class="st-desc">停止输入后自动写入磁盘</span>
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
                  <span class="st-desc">左侧的资料库目录树</span>
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
                  <span class="st-name">显示大纲</span>
                  <span class="st-desc">预览区右侧的标题导航</span>
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

            <!-- 备份 -->
            <template v-else-if="section === 'backup'">
              <p class="st-text">
                每次手动保存（Ctrl+S、切换笔记、关闭窗口）都会在
                <code>工作区/.history</code> 下留一份快照，自动保存不会重复记录。
              </p>
              <p class="st-text st-muted">
                快照按时间倒序排列，可在顶栏的「版本历史」里查看与恢复。
              </p>
            </template>

            <!-- 同步 -->
            <template v-else-if="section === 'sync'">
              <p class="st-text st-muted">尚未接入。当前版本只做本地文件，没有任何账号或云端依赖。</p>
            </template>

            <!-- MCP -->
            <template v-else-if="section === 'mcp'">
              <p class="st-text st-muted">
                尚未接入。计划中的形态是让外部 AI 工具直接读写你的工作区，
                目前还没有可用的服务端。
              </p>
            </template>

            <!-- 账户 -->
            <template v-else-if="section === 'account'">
              <p class="st-text st-muted">
                本地模式。笔记就是你磁盘上的普通 <code>.md</code> 文件，不需要登录。
              </p>
            </template>

            <!-- 数据 -->
            <template v-else-if="section === 'data'">
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
            </template>

            <!-- 关于 -->
            <template v-else>
              <div class="st-about-card">
                <div class="st-about-name">Nota</div>
                <div class="st-about-ver">版本 {{ APP_VERSION }}</div>
              </div>
              <p class="st-text st-muted">
                一个轻量的本地 Markdown 笔记应用。笔记就是普通的 <code>.md</code> 文件，
                直接放在你选的目录里，随时可以用别的工具打开。
              </p>
              <div class="st-keys">
                <div class="st-key"><span>保存</span><kbd>Ctrl + S</kbd></div>
                <div class="st-key"><span>新建笔记</span><kbd>Ctrl + N</kbd></div>
                <div class="st-key"><span>打开目录</span><kbd>Ctrl + O</kbd></div>
                <div class="st-key"><span>编辑 / 分栏 / 预览</span><kbd>Ctrl + 1 / 2 / 3</kbd></div>
                <div class="st-key"><span>折叠侧边栏</span><kbd>Ctrl + \</kbd></div>
                <div class="st-key"><span>查找与替换</span><kbd>Ctrl + F</kbd></div>
                <div class="st-key"><span>命令菜单</span><kbd>/</kbd></div>
              </div>
            </template>
          </div>
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

/* 横向：左导航固定 176px，右内容自适应 */
.st {
  display: flex;
  width: 760px;
  max-width: 100%;
  height: 540px;
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
  width: 176px;
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
  padding: 14px 20px 22px;
}

.st-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 0;
  border-bottom: 1px solid var(--n-line);
}

.st-row:last-child {
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
  flex: none;
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
  flex: none;
  height: 28px;
  padding: 0 12px;
  font-size: 12.5px;
  border-radius: var(--n-r-sm);
  border: 1px solid var(--n-line);
  background: var(--n-bg);
  color: var(--n-fg);
  transition: border-color var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.st-btn:hover {
  border-color: var(--n-accent);
  color: var(--n-accent);
}

/* 分段控件：和顶栏视图切换同款 */
.st-seg {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: var(--n-r-md);
  background: var(--n-bg);
  border: 1px solid var(--n-line);
  flex: none;
}

.st-seg-btn {
  height: 24px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 10px;
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

/* 开关 */
.st-switch {
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

/* 关于 */
.st-about-card {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 10px 0 14px;
  border-bottom: 1px solid var(--n-line);
  margin-bottom: 14px;
}

.st-about-name {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--n-fg);
}

.st-about-ver {
  font-size: 11.5px;
  font-family: var(--n-font-mono);
  color: var(--n-fg-faint);
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

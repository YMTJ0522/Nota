<script setup lang="ts">
/**
 * 使用指南：把窗口里每一块是干什么的、能怎么用，一次讲清楚。
 *
 * 为什么不做成「首次启动弹一串气泡」：气泡得按当前布局算位置，用户一缩窗口、
 * 一收侧栏就全错位；而且他跳过一次就再也不想看了。这里做成一页可随时翻的说明，
 * 顺带能在设置之外独立打开（侧栏底栏那枚问号、首屏那行「看看怎么用」）。
 *
 * 内容只写代码里真实存在的东西 —— 快捷键全部对过 App.vue 与 editor/*-keymap.ts，
 * 斜杠命令对过 slash-commands.ts 的 SLASH_LABELS。
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import {
  PanelLeft,
  ListTree,
  Paperclip,
  Trash2,
  Sparkles,
  Network,
  Search,
  Download,
  PenLine,
  FolderTree,
  Keyboard,
  Compass,
  Lightbulb,
  X,
} from 'lucide-vue-next'

type SectionId = 'layout' | 'writing' | 'organize' | 'find' | 'export' | 'keys'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const SECTIONS: { id: SectionId; label: string; icon: unknown }[] = [
  { id: 'layout', label: '界面', icon: Compass },
  { id: 'writing', label: '写作', icon: PenLine },
  { id: 'organize', label: '整理', icon: FolderTree },
  { id: 'find', label: '查找', icon: Search },
  { id: 'export', label: '导出', icon: Download },
  { id: 'keys', label: '快捷键', icon: Keyboard },
]

const section = ref<SectionId>('layout')
const current = computed(() => SECTIONS.find((s) => s.id === section.value)!)

/** 每次打开都回到第一页：上次停在「快捷键」不代表这次还想看它 */
watch(
  () => props.open,
  (v) => {
    if (v) section.value = 'layout'
  },
)

function onKey(e: KeyboardEvent) {
  if (!props.open) return
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
  }
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

/** 界面各区域：图示里的编号与下面这张表一一对应 */
const REGIONS = [
  {
    no: '1',
    name: '资料库',
    icon: PanelLeft,
    text: '左边这一栏。文件夹树在上面，下面是全部 / 收藏 / 标签几类筛选。',
    tips: [
      '底栏那行显示当前工作区一共有多少篇，右边是设置。',
      'Ctrl + \\ 收起成一条窄轨，把地方让给正文；再按一次展开。',
      '右键文件或文件夹可以改名、移动、删除、加星。',
    ],
  },
  {
    no: '2',
    name: '资料栏',
    icon: ListTree,
    text: '中间这一栏。顶上三个页签：笔记 / 大纲 / 引用。',
    tips: [
      '笔记 —— 当前范围内的笔记列表。',
      '大纲 —— 正在写这一篇的标题树，点一下跳过去。',
      '引用 —— 工作区里哪些笔记提到了当前这一篇（反向链接）。',
      '宽度可以拖；窗口窄的时候它会自己让出位置给正文，不用手动收。',
    ],
  },
  {
    no: '3',
    name: '编辑区',
    icon: PenLine,
    text: '右边最大的那块。左边写 Markdown 源码，右边看排版效果。',
    tips: [
      '顶部那行是标题与路径，右边有分栏、导出、窗口控制。',
      '分栏按钮在「只写」和「边写边看」之间切换。',
      '没打开笔记时这一块是空的 —— 从左边选一篇，或按 Ctrl + N 新建。',
    ],
  },
]

/** 侧栏底栏那几枚入口。AI 那一枚要设置里打开过才出现，所以单独标注 */
const ENTRIES = [
  { icon: Paperclip, name: '附件库', text: '工作区里引用过的图片和文件，集中看一遍' },
  { icon: Trash2, name: '回收站', text: '删掉的笔记先进这里，还能还原' },
  { icon: Sparkles, name: 'AI 编写', text: '对话式写作，需要先在设置里接上模型' },
  { icon: Network, name: '关系图', text: 'Ctrl + Shift + G，看双链织出来的网络' },
  { icon: Search, name: '全文搜索', text: 'Ctrl + Shift + F，连正文一起搜' },
]

/** 斜杠菜单按用途分组，只列常按的几个，全表在写作那一节的说明里 */
const SLASH_GROUPS = [
  { title: '结构', items: ['一级 / 二级 / 三级标题', '无序 / 有序 / 任务列表', '引用块', '分割线'] },
  { title: '内容块', items: ['表格', '代码块 / 高级代码块', 'Mermaid 图表', '行内公式 / 块级公式', 'Callout 提示块', '折叠详情块', '分栏标签'] },
  { title: '关联', items: ['双链笔记 [[ ]]', '笔记嵌入 ![[ ]]', '块引用', '标签', '脚注', '图片'] },
  { title: '元信息', items: ['Front Matter', '块 ID', '隐藏注释'] },
]

const KEYS: { group: string; rows: [string, string][] }[] = [
  {
    group: '文件与工作区',
    rows: [
      ['Ctrl + O', '打开 / 切换工作区目录'],
      ['Ctrl + N', '新建笔记'],
      ['Ctrl + S', '保存当前笔记'],
      ['Ctrl + \\', '收起 / 展开侧边栏'],
    ],
  },
  {
    group: '查找',
    rows: [
      ['Ctrl + P', '按标题与路径搜索（快）'],
      ['Ctrl + Shift + F', '连正文一起搜索'],
      ['Ctrl + F', '在当前笔记内查找'],
      ['Ctrl + Shift + G', '打开 / 关闭关系图'],
    ],
  },
  {
    group: '格式',
    rows: [
      ['Ctrl + B / I', '加粗 / 斜体'],
      ['Ctrl + E', '行内代码'],
      ['Ctrl + Shift + X', '删除线'],
      ['Ctrl + Shift + H', '高亮'],
      ['Ctrl + 1 ~ 6', '一至六级标题'],
      ['Ctrl + Shift + .', '引用块'],
      ['Ctrl + Shift + 7 / 8 / 9', '有序 / 无序 / 任务列表'],
    ],
  },
  {
    group: '输入辅助',
    rows: [
      ['/', '行首敲斜杠，出命令菜单'],
      ['[[', '弹出笔记选择器，插入双链'],
      ['Ctrl + Shift + Space', '手动唤出补全'],
      ['Alt + /', '同上（备用键）'],
      ['Esc', '关掉当前浮层'],
    ],
  },
]
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="gd-mask" @click.self="emit('close')">
      <div class="gd" role="dialog" aria-modal="true" aria-label="使用指南">
        <!-- 左：分区 -->
        <nav class="gd-nav">
          <div class="gd-nav-title">使用指南</div>
          <button
            v-for="s in SECTIONS"
            :key="s.id"
            class="gd-nav-item"
            :class="{ on: section === s.id }"
            @click="section = s.id"
          >
            <span class="gd-nav-ico"><component :is="s.icon" :size="14" :stroke-width="1.9" /></span>
            <span class="gd-nav-label">{{ s.label }}</span>
          </button>
          <div class="gd-nav-foot">随时可以从侧栏底栏的问号再打开</div>
        </nav>

        <div class="gd-main">
          <header class="gd-head">
            <h2 class="gd-title">{{ current.label }}</h2>
            <button class="gd-x" title="关闭 (Esc)" @click="emit('close')">
              <X :size="15" :stroke-width="1.9" />
            </button>
          </header>

          <div class="gd-body">
            <!-- ══ 界面 ══ -->
            <template v-if="section === 'layout'">
              <p class="gd-lead">
                整扇窗口横向切成三块，各管一件事：左边找笔记，中间看线索，右边写东西。
              </p>

              <!-- 这张示意图是纯 CSS 画的，跟着主题走。
                   比截图好在：深色浅色都对、不会过期、也不用多带一张图。 -->
              <div class="gd-map" aria-hidden="true">
                <div class="gd-map-row">
                  <div class="gd-map-cell c1"><span>1</span>资料库</div>
                  <div class="gd-map-cell c2"><span>2</span>资料栏</div>
                  <div class="gd-map-cell c3"><span>3</span>编辑区</div>
                </div>
                <div class="gd-map-foot">
                  <i />附件库
                  <i />回收站
                  <i />AI
                  <i />关系图
                  <i />搜索
                </div>
              </div>

              <div v-for="r in REGIONS" :key="r.no" class="gd-card">
                <div class="gd-card-head">
                  <span class="gd-no">{{ r.no }}</span>
                  <component :is="r.icon" :size="14" :stroke-width="1.9" class="gd-ic" />
                  <span class="gd-card-name">{{ r.name }}</span>
                </div>
                <p class="gd-card-text">{{ r.text }}</p>
                <ul class="gd-list">
                  <li v-for="t in r.tips" :key="t">{{ t }}</li>
                </ul>
              </div>

              <h3 class="gd-h3">侧栏底栏那几枚</h3>
              <div class="gd-entries">
                <div v-for="e in ENTRIES" :key="e.name" class="gd-entry">
                  <component :is="e.icon" :size="13" :stroke-width="1.9" class="gd-ic" />
                  <span class="gd-entry-name">{{ e.name }}</span>
                  <span class="gd-entry-text">{{ e.text }}</span>
                </div>
              </div>
            </template>

            <!-- ══ 写作 ══ -->
            <template v-else-if="section === 'writing'">
              <p class="gd-lead">
                笔记就是磁盘上一个 .md 文件，没有数据库、没有私有格式。Nota 只负责让它写起来顺手。
              </p>

              <h3 class="gd-h3">斜杠菜单</h3>
              <p class="gd-p">
                在行首敲 <kbd>/</kbd>，弹出命令菜单，上下键选、回车插入。
                不用背语法，也不用去记 Markdown 怎么写。
              </p>
              <div class="gd-groups">
                <div v-for="g in SLASH_GROUPS" :key="g.title" class="gd-group">
                  <div class="gd-group-title">{{ g.title }}</div>
                  <ul class="gd-list tight">
                    <li v-for="i in g.items" :key="i">{{ i }}</li>
                  </ul>
                </div>
              </div>

              <h3 class="gd-h3">直接写 Markdown 也完全可以</h3>
              <ul class="gd-list">
                <li>选中文字按 <kbd>Ctrl</kbd>+<kbd>B</kbd>、<kbd>I</kbd>、<kbd>E</kbd> 加粗、斜体、行内代码。</li>
                <li><kbd>Ctrl</kbd>+<kbd>1</kbd> 到 <kbd>6</kbd> 直接变标题，不用手动敲井号。</li>
                <li>输入 <code>[[</code> 会弹笔记选择器，挑一篇就插好双链。</li>
                <li>输入 <code>#</code> 开始打标签，已用过的标签会提示。</li>
              </ul>

              <div class="gd-note">
                <Lightbulb :size="13" :stroke-width="1.9" />
                <span>
                  右侧预览是实时的。想安静写，按编辑区顶部的分栏按钮切回单栏。
                </span>
              </div>
            </template>

            <!-- ══ 整理 ══ -->
            <template v-else-if="section === 'organize'">
              <p class="gd-lead">用文件夹管位置，用标签管属性，用双链管关系 —— 三件事不要混着用。</p>

              <h3 class="gd-h3">文件夹</h3>
              <ul class="gd-list">
                <li>文件夹就是磁盘上的目录，你在别处看到的层级跟这里一模一样。</li>
                <li>右键可以新建、改名、移动、删除。删除会先进回收站。</li>
                <li>一篇笔记只能在一个文件夹里，所以「既是工作又是读书」这种别用文件夹表达。</li>
              </ul>

              <h3 class="gd-h3">标签</h3>
              <ul class="gd-list">
                <li>正文里写 <code>#标签名</code>，这篇就自动进了那个标签。</li>
                <li>侧栏的「标签」筛选聚合了整个工作区用过的标签。</li>
                <li>标签是跨文件夹的，适合「状态」和「类型」这种横切属性。</li>
              </ul>

              <h3 class="gd-h3">收藏</h3>
              <p class="gd-p">右键加星，进侧栏的「收藏」。适合放几篇天天要翻的。</p>

              <h3 class="gd-h3">双链</h3>
              <ul class="gd-list">
                <li><code>[[笔记名]]</code> 指向另一篇笔记。</li>
                <li><code>![[笔记名]]</code> 把那一篇整段嵌进来（原件改了这里跟着变）。</li>
                <li><code>[[笔记名#标题]]</code> 指到某一节，<code>[[笔记名#^块ID]]</code> 指到某一段。</li>
                <li>被指向的那篇，打开「引用」页签就能看到谁提到了它。</li>
              </ul>

              <div class="gd-note">
                <Lightbulb :size="13" :stroke-width="1.9" />
                <span>双链多了之后按 <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> 看关系图，比翻引用页签更容易发现孤岛。</span>
              </div>
            </template>

            <!-- ══ 查找 ══ -->
            <template v-else-if="section === 'find'">
              <p class="gd-lead">两个搜索键分工明确：一个快、一个全。日常用快的那个。</p>

              <div class="gd-card">
                <div class="gd-card-head">
                  <span class="gd-no">P</span>
                  <Search :size="14" :stroke-width="1.9" class="gd-ic" />
                  <span class="gd-card-name">Ctrl + P · 按标题搜</span>
                </div>
                <p class="gd-card-text">
                  只比文件名和路径，纯内存，几十毫秒就出结果。记得名字就用它。
                </p>
              </div>

              <div class="gd-card">
                <div class="gd-card-head">
                  <span class="gd-no">⇧F</span>
                  <Search :size="14" :stroke-width="1.9" class="gd-ic" />
                  <span class="gd-card-name">Ctrl + Shift + F · 连正文搜</span>
                </div>
                <p class="gd-card-text">
                  要读磁盘，所以单独给了个键。找「我记得写过但忘了在哪篇」用这个。
                </p>
              </div>

              <h3 class="gd-h3">三种不用搜的找法</h3>
              <ul class="gd-list">
                <li><b>大纲</b> —— 正在写、也正在读的那一篇，标题树就在中间栏。</li>
                <li><b>引用</b> —— 想找「谁提到了这篇」，翻它比搜关键词准。</li>
                <li><b>标签 / 收藏</b> —— 已经分好类的东西，别再去搜。</li>
              </ul>
            </template>

            <!-- ══ 导出 ══ -->
            <template v-else-if="section === 'export'">
              <p class="gd-lead">编辑区顶部那枚导出按钮，一共四项。选哪个取决于拿去干什么。</p>

              <div class="gd-card">
                <div class="gd-card-head">
                  <span class="gd-no">A4</span>
                  <span class="gd-card-name">PDF</span>
                </div>
                <p class="gd-card-text">
                  按打印样式排，固定 A4。图表、公式、代码高亮都跟屏幕上一致，用来发给人看最稳。
                </p>
                <ul class="gd-list tight">
                  <li>要保真就选它 —— 尤其是有复杂公式的时候。</li>
                </ul>
              </div>

              <div class="gd-card">
                <div class="gd-card-head">
                  <span class="gd-no">W</span>
                  <span class="gd-card-name">Word（.doc）</span>
                </div>
                <p class="gd-card-text">
                  逐元素写内联样式，Word 和 WPS 都能正常打开。人家要在上面改内容，就交这个。
                </p>
                <ul class="gd-list tight">
                  <li>块级公式会转成图片，行内公式转成 Word 自己的公式对象。</li>
                  <li>复杂行内公式（比如分式）可能退化成文本 —— 这种还是给 PDF。</li>
                </ul>
              </div>

              <div class="gd-card">
                <div class="gd-card-head">
                  <span class="gd-no">H</span>
                  <span class="gd-card-name">HTML</span>
                </div>
                <p class="gd-card-text">单个网页文件，样式全内嵌。丢到任何地方打开都一样。</p>
              </div>

              <div class="gd-card">
                <div class="gd-card-head">
                  <span class="gd-no">M</span>
                  <span class="gd-card-name">Markdown</span>
                </div>
                <p class="gd-card-text">
                  原始源码，带 frontmatter。要迁到别处、或者进 Git 就选它。
                </p>
              </div>

              <div class="gd-note">
                <Lightbulb :size="13" :stroke-width="1.9" />
                <span>导出前先保存。导出用的是磁盘上的那一份，不是还没落盘的内容。</span>
              </div>
            </template>

            <!-- ══ 快捷键 ══ -->
            <template v-else-if="section === 'keys'">
              <p class="gd-lead">全部键位都在这里，Ctrl 和 ⌘ 通用。</p>
              <div v-for="k in KEYS" :key="k.group" class="gd-keygroup">
                <div class="gd-group-title">{{ k.group }}</div>
                <div v-for="[combo, what] in k.rows" :key="combo" class="gd-keyrow">
                  <kbd class="gd-kbd">{{ combo }}</kbd>
                  <span class="gd-keytext">{{ what }}</span>
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.gd-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--n-mask);
  backdrop-filter: blur(2px);
  animation: gd-fade 120ms var(--n-ease);
}

.gd {
  display: flex;
  width: 820px;
  max-width: 100%;
  height: 600px;
  max-height: 100%;
  background: var(--n-raised);
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-lg);
  box-shadow: var(--n-shadow-xl);
  overflow: hidden;
  animation: gd-in 150ms var(--n-ease);
}

@keyframes gd-fade {
  from {
    opacity: 0;
  }
}

@keyframes gd-in {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.995);
  }
}

/* ── 左导航 ── */
.gd-nav {
  flex: none;
  width: 168px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 12px 10px;
  background: var(--n-sunken);
  border-right: 1px solid var(--n-line);
}

.gd-nav-title {
  padding: 4px 8px 10px;
  font-size: 13.5px;
  font-weight: 650;
  color: var(--n-fg);
}

.gd-nav-item {
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

.gd-nav-ico {
  flex: none;
  display: inline-flex;
  color: var(--n-fg-faint);
  transition: color var(--n-dur) var(--n-ease);
}

.gd-nav-ico svg {
  fill: none;
  stroke: currentColor;
}

.gd-nav-label {
  font-size: 12.5px;
  font-weight: 500;
}

.gd-nav-item:hover {
  background: var(--n-raised);
  color: var(--n-fg);
}

.gd-nav-item.on {
  background: var(--n-accent-soft);
  color: var(--n-fg);
}

.gd-nav-item.on .gd-nav-ico {
  color: var(--n-accent);
}

.gd-nav-foot {
  margin-top: auto;
  padding: 10px 8px 2px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--n-fg-faint);
}

/* ── 右侧内容 ── */
.gd-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.gd-head {
  flex: none;
  height: 46px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px 0 20px;
  border-bottom: 1px solid var(--n-line);
}

.gd-title {
  margin: 0;
  font-size: 13.5px;
  font-weight: 650;
  color: var(--n-fg);
}

.gd-x {
  padding: 0;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-dim);
}

.gd-x svg {
  fill: none;
  stroke: currentColor;
}

.gd-x:hover {
  background: var(--n-bg);
  color: var(--n-fg);
}

.gd-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 20px 24px;
}

.gd-lead {
  margin: 0 0 14px;
  font-size: 13px;
  line-height: 1.75;
  color: var(--n-fg-dim);
}

.gd-h3 {
  margin: 20px 0 8px;
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.04em;
  color: var(--n-fg-faint);
}

.gd-p {
  margin: 0 0 10px;
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--n-fg-dim);
}

/* ── 示意图 ── */
.gd-map {
  margin-bottom: 16px;
  padding: 10px;
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-md);
  background: var(--n-bg);
}

.gd-map-row {
  display: flex;
  gap: 6px;
  height: 62px;
}

.gd-map-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--n-fg-dim);
  border: 1px dashed var(--n-line-strong, var(--n-line));
  border-radius: var(--n-r-sm);
  background: var(--n-raised);
}

.gd-map-cell span {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  font-size: 10px;
  font-weight: 700;
  background: var(--n-accent-soft);
  color: var(--n-accent);
}

.gd-map-cell.c1 {
  flex: 0 0 108px;
}

.gd-map-cell.c2 {
  flex: 0 0 96px;
}

.gd-map-cell.c3 {
  flex: 1;
}

.gd-map-foot {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 7px;
  padding-left: 2px;
  font-size: 10.5px;
  color: var(--n-fg-faint);
  flex-wrap: wrap;
}

.gd-map-foot i {
  width: 8px;
  height: 8px;
  margin-left: 6px;
  border-radius: 2px;
  background: var(--n-accent-soft);
  border: 1px solid var(--n-line);
}

.gd-map-foot i:first-child {
  margin-left: 0;
}

/* ── 卡片 ── */
.gd-card {
  margin-bottom: 10px;
  padding: 10px 12px;
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-md);
  background: var(--n-bg);
}

.gd-card-head {
  display: flex;
  align-items: center;
  gap: 7px;
}

.gd-no {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 700;
  background: var(--n-accent-soft);
  color: var(--n-accent);
}

.gd-ic {
  flex: none;
  color: var(--n-fg-faint);
}

.gd-ic svg {
  fill: none;
  stroke: currentColor;
}

.gd-card-name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--n-fg);
}

.gd-card-text {
  margin: 6px 0 0;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--n-fg-dim);
}

.gd-list {
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
}

.gd-list li {
  position: relative;
  padding-left: 13px;
  margin-bottom: 3px;
  font-size: 12.5px;
  line-height: 1.72;
  color: var(--n-fg-dim);
}

.gd-list li::before {
  content: '';
  position: absolute;
  left: 2px;
  top: 8px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--n-fg-faint);
}

.gd-list.tight li {
  margin-bottom: 1px;
  font-size: 12px;
}

/* ── 入口列表 ── */
.gd-entries {
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-md);
  overflow: hidden;
}

.gd-entry {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--n-bg);
}

.gd-entry + .gd-entry {
  border-top: 1px solid var(--n-line);
}

.gd-entry-name {
  flex: none;
  width: 62px;
  font-size: 12.5px;
  font-weight: 550;
  color: var(--n-fg);
}

.gd-entry-text {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--n-fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 斜杠命令分组 ──
   用分栏而不是两列 grid：grid 的每一行高度取两边较高的那个，
   「结构」4 条配「内容块」7 条会留出一大块空白，看着像漏了内容。
   分栏按总高度自动均分，四组正好对半。 */
.gd-groups {
  column-count: 2;
  column-gap: 22px;
  margin-bottom: 4px;
}

.gd-group {
  break-inside: avoid;
}

.gd-group-title {
  margin: 10px 0 4px;
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.04em;
  color: var(--n-fg-faint);
}

/* ── 快捷键表 ── */
.gd-keygroup + .gd-keygroup {
  margin-top: 4px;
}

.gd-keyrow {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 3px 0;
}

.gd-kbd {
  flex: none;
  min-width: 150px;
  font-family: var(--n-font-mono);
  font-size: 11.5px;
  color: var(--n-fg);
  background: var(--n-bg);
  border: 1px solid var(--n-line);
  border-radius: 4px;
  padding: 1px 6px;
  text-align: center;
}

.gd-keytext {
  font-size: 12.5px;
  color: var(--n-fg-dim);
}

/* ── 提示条 ── */
.gd-note {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  margin-top: 12px;
  padding: 8px 10px;
  border-radius: var(--n-r-sm);
  background: var(--n-accent-soft);
  font-size: 12px;
  line-height: 1.65;
  color: var(--n-fg-dim);
}

.gd-note svg {
  flex: none;
  margin-top: 2px;
  fill: none;
  stroke: var(--n-accent);
}

/* 正文里出现行内代码和键帽时统一一下长相 */
.gd-p code,
.gd-list code {
  font-family: var(--n-font-mono);
  font-size: 11.5px;
  padding: 0 3px;
  border-radius: 3px;
  background: var(--n-sunken);
  color: var(--n-fg);
}

.gd-p kbd,
.gd-list kbd,
.gd-lead kbd {
  font-family: var(--n-font-mono);
  font-size: 11px;
  padding: 0 4px;
  border-radius: 3px;
  border: 1px solid var(--n-line);
  background: var(--n-bg);
  color: var(--n-fg);
}
</style>

import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t, tagHighlighter } from "@lezer/highlight";

/**
 * Nota 的 CodeMirror 主题。
 *
 * 两层结构：
 *  - 基础层（本文件前半）：编辑器外壳、光标、选区、gutter、搜索面板、补全气泡；
 *  - 表现层（本文件后半，配合 live-preview.ts 的装饰器）：标题层级、行内标记淡化、
 *    代码块贴边圆角、引用竖线、列表标记、任务状态。
 *
 * 颜色一律读 `--n-*` 自定义属性，所以深浅主题共用这一份定义。
 */

export const notaTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "transparent",
    color: "var(--n-fg)",
    fontSize: "var(--n-fs-body)",
  },

  /* ── 滚动与居左 ──
     行号 gutter 与正文 content 是 scroller 下的并列 flex 子节点。
     早期做法是给 scroller 加对称留白 `(100% - measure)/2`，
     结果行号被一起推到窗口中间——用户看到的就是「行号飘在中间」。

     现在改成：scroller 只留一个小的固定左内边距（行号紧贴左侧），
     正文列的宽度约束交给 .cm-content 自己（max-width + 左对齐）。
     这样行号归位到左边，正文也不会拉成一条超长的行。 */
  ".cm-scroller": {
    /* 正文用界面那一套圆体，跟右侧预览、侧栏是同一个字族 —— 左边写、右边看，
       两边字形一样才像同一篇笔记。真正要等宽的地方（代码块、行内代码、行号）
       下面各自另设，不受这里影响。 */
    fontFamily: "var(--n-font-ui)",
    lineHeight: "var(--n-lh)",
    overflowY: "auto",
    overflowX: "hidden",
    paddingTop: "24px",
    paddingBottom: "42vh",
    paddingInline: "0",
  },
  ".cm-content": {
    padding: "0",
    caretColor: "var(--n-accent)",
    minWidth: "0",
    /* 正文列宽上限；超过就停住，避免宽屏下一行拉到几百字 */
    maxWidth: "var(--n-measure)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-line": { padding: "0 18px" },

  /* ── 行号 ──
     scroller 的 paddingInline 已归零，所以左右留白落在这里。

     左留白定 2px、行号格 20px：加上折叠箭头那 9px 与格内 6px 右留白，
     数字的**右边界**停在离编辑区左边 25px 上，一位数字的字形落在 18px ——
     跟顶栏那枚搜索按钮里图标的 16px 基本同一条竖线。以前是 12px + 28px，
     数字飘到离边 36px 开外，看着像多出来一栏，这就是「行号离边框太远」的来处。

     格子要定宽（20px 刚好装下两位数字 + 右留白）：不定宽的话，
     笔记从 9 行写到 10 行时格子会自己变宽，整列数字跟着右移两像素，
     写着写着忽然晃一下。

     底色必须是不透明的：gutter 是 sticky 的，正文一旦横向滚动就会从它
     底下经过，透明底会让「文字压着行号」——早期就是这么翻车的。 */
  ".cm-gutters": {
    backgroundColor: "var(--n-bg)",
    color: "var(--n-fg-faint)",
    border: "none",
    /* 行号是数字，要的是「每一位一样宽」——圆体是比例字体，写成 11 和 111
       长度会不一样，右对齐也压不齐。所以这一条单独留在等宽栈里。 */
    fontFamily: "var(--n-font-mono)",
    fontSize: "12px",
    paddingInlineStart: "2px",
    paddingInlineEnd: "6px",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 6px 0 0",
    minWidth: "20px",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--n-fg-dim)",
  },
  ".cm-activeLine": { backgroundColor: "var(--n-active-line)" },
  /* 折叠箭头平时隐形，hover 才出现——安静，不干扰写作 */
  ".cm-foldGutter .cm-gutterElement": {
    color: "var(--n-fg-faint)",
    opacity: 0,
    transition: "opacity var(--n-dur) var(--n-ease)",
  },
  ".cm-editor:hover .cm-foldGutter .cm-gutterElement": { opacity: 1 },

  /* ── 光标与选区 ── */
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--n-accent)",
    borderLeftWidth: "2px",
    borderRadius: "1px",
  },

  /* 选区除了给背景色，还要把文字压深（--n-selection-fg）。
     只加背景的话，正文的灰字压在绿底上会"糊在一起"，看起来像没选中。

     选择器为什么写这么长、还带 !important：CodeMirror 的 baseTheme 里有一条
     「&light.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground」
     背景写死成 #d7d4f0（浅紫），展开后是六个类，比常规写法重得多 —— 光写
     .cm-selectionBackground 压不过它，深色主题下就会一直是一块浅紫，白字压上去
     直接看不清。这里用同样深的选择器再加上 !important 把它彻底盖掉：
     选中的颜色只该有一个来源，就是 --n-selection。 */
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--n-selection) !important",
    color: "var(--n-selection-fg) !important",
  },
  ".cm-selectionMatch": {
    backgroundColor: "var(--n-selection)",
    borderRadius: "2px",
  },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "var(--n-selection)",
    outline: "1px solid var(--n-line-strong)",
  },
  ".cm-placeholder": {
    color: "var(--n-fg-faint)",
    fontStyle: "normal",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--n-surface)",
    border: "1px solid var(--n-line)",
    color: "var(--n-fg-dim)",
    borderRadius: "4px",
    padding: "0 6px",
  },

  /* ── 查找替换面板 ──
     默认面板是一串裸 inline 元素，挤在一起完全看不出层级。
     这里给它排成一行：输入框 → 按钮 → 选项开关 → 关闭（推最右）。 */
  ".cm-panels": {
    backgroundColor: "var(--n-surface)",
    borderColor: "var(--n-line)",
    color: "var(--n-fg)",
  },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--n-line)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--n-line)" },
  ".cm-panel.cm-search": {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "6px",
    padding: "7px 10px",
    fontFamily: "var(--n-font-ui)",
    fontSize: "12.5px",
  },
  ".cm-panel.cm-search input.cm-textfield": {
    width: "180px",
    height: "24px",
    padding: "0 8px",
    fontFamily: "var(--n-font-ui)",
    fontSize: "12.5px",
    color: "var(--n-fg)",
    background: "var(--n-raised)",
    border: "1px solid var(--n-line)",
    borderRadius: "var(--n-r-sm)",
    outline: "none",
  },
  ".cm-panel.cm-search input.cm-textfield:focus": {
    borderColor: "var(--n-accent)",
  },
  ".cm-panel.cm-search button.cm-button": {
    height: "24px",
    padding: "0 10px",
    fontFamily: "var(--n-font-ui)",
    fontSize: "12px",
    color: "var(--n-fg-dim)",
    background: "var(--n-raised)",
    border: "1px solid var(--n-line)",
    borderRadius: "var(--n-r-sm)",
    cursor: "pointer",
  },
  ".cm-panel.cm-search button.cm-button:hover": {
    background: "var(--n-accent-soft)",
    color: "var(--n-accent)",
    borderColor: "var(--n-accent)",
  },
  ".cm-panel.cm-search label": {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    fontSize: "11.5px",
    color: "var(--n-fg-dim)",
    whiteSpace: "nowrap",
    cursor: "pointer",
  },
  ".cm-panel.cm-search input[type=checkbox]": {
    width: "13px",
    height: "13px",
    margin: "0",
    accentColor: "var(--n-accent)",
  },
  /* 关闭推到最右，不和选项开关挤成一团 */
  ".cm-panel.cm-search button[name=close]": {
    marginLeft: "auto",
    padding: "0 8px",
  },
  /* 兼容旧的通用规则：面板里其余零散控件仍保持同一套观感 */
  ".cm-panel input:not(.cm-textfield), .cm-panel button:not(.cm-button)": {
    fontFamily: "var(--n-font-ui)",
    fontSize: "12.5px",
    background: "var(--n-raised)",
    color: "var(--n-fg)",
    border: "1px solid var(--n-line)",
    borderRadius: "var(--n-r-sm)",
    padding: "2px 6px",
  },
  ".cm-searchMatch": {
    backgroundColor: "var(--n-accent-soft)",
    outline: "1px solid var(--n-accent)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "var(--n-selection)",
  },

  /* ── 补全气泡 ── */
  ".cm-tooltip": {
    backgroundColor: "var(--n-raised)",
    border: "1px solid var(--n-line)",
    borderRadius: "var(--n-r-md)",
    boxShadow: "var(--n-shadow-lg)",
    overflow: "hidden",
    /* 弹层要压过内容里任何自己抬过 z-index 的东西（语言标签是 2）。
       CodeMirror 自己没有给 .cm-tooltip 定层级，靠 DOM 顺序，
       内容里一旦出现定位 + z-index 的元素就会被反过来盖住。 */
    zIndex: "10",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    maxHeight: "15em",
    fontFamily: "var(--n-font-ui)",
    fontSize: "12.5px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    padding: "5px 10px",
    color: "var(--n-fg-dim)",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--n-accent-soft)",
    color: "var(--n-fg)",
  },
  ".cm-completionMatchedText": {
    textDecoration: "none",
    fontWeight: "600",
    color: "var(--n-accent)",
  },
  ".cm-completionDetail": {
    fontStyle: "normal",
    fontSize: "11px",
    color: "var(--n-fg-faint)",
  },

  /* ══════════════════════════════════════════
     表现层：Markdown 语义（由 live-preview.ts 打 class）
     这是「看起来像专业写作软件」的关键所在。
     ══════════════════════════════════════════ */

  /* ── 标题：源码里直接呈现层级 ──
     字号用 em 放大后，行盒会被相邻行挤压，所以显式给足 line-height
     与上下 margin，让大标题"呼吸"得开。 */
  ".cm-md-h1": {
    fontSize: "1.62em",
    fontWeight: "700",
    lineHeight: "1.5",
    letterSpacing: "-0.02em",
    paddingTop: "0.28em",
    paddingBottom: "0.12em",
  },
  ".cm-md-h2": {
    fontSize: "1.34em",
    fontWeight: "700",
    lineHeight: "1.48",
    letterSpacing: "-0.015em",
    paddingTop: "0.26em",
    paddingBottom: "0.08em",
  },
  ".cm-md-h3": {
    fontSize: "1.16em",
    fontWeight: "650",
    lineHeight: "1.46",
    paddingTop: "0.22em",
    paddingBottom: "0.06em",
  },
  ".cm-md-h4": {
    fontSize: "1.04em",
    fontWeight: "650",
    lineHeight: "1.44",
    paddingTop: "0.18em",
  },
  ".cm-md-h5": {
    fontSize: "0.96em",
    fontWeight: "650",
    color: "var(--n-fg-dim)",
  },
  ".cm-md-h6": {
    fontSize: "0.92em",
    fontWeight: "650",
    color: "var(--n-fg-faint)",
  },

  /* 首行标题不需要额外的顶部内边距 */
  ".cm-line:first-child.cm-md-h1, .cm-line:first-child.cm-md-h2, .cm-line:first-child.cm-md-h3": {
    paddingTop: "0",
  },

  /* ── 标记淡化：让符号退成注脚，正文成为主体 ── */
  ".cm-md-marker": {
    color: "var(--n-fg-faint)",
    fontWeight: "400",
    opacity: "0.55",
  },
  ".cm-md-marker-list": {
    color: "var(--n-accent)",
    opacity: "0.8",
  },
  /* 光标所在行，标记恢复清晰——正在编辑时不该"看不清自己写了什么" */
  "&.cm-focused .cm-activeLine .cm-md-marker": {
    color: "var(--n-fg-dim)",
    opacity: "0.85",
  },

  /* ── 行内语义 ── */
  ".cm-md-strong": { fontWeight: "700", color: "var(--n-fg)" },
  ".cm-md-em": { fontStyle: "italic", color: "var(--n-fg)" },
  ".cm-md-strike": {
    textDecoration: "line-through",
    textDecorationColor: "var(--n-fg-faint)",
    color: "var(--n-fg-dim)",
  },
  /* ── 行内代码 ──
     参考项目是一层很薄的底色 + 等宽字体，没有药丸边框：
     行内代码出现频率极高，加边框会让整段文字看起来坑坑洼洼。 */
  ".cm-md-inline-code": {
    fontFamily: "var(--n-font-mono)",
    fontSize: "0.9em",
    color: "color-mix(in oklab, var(--n-fg) 88%, var(--n-fg-dim))",
    backgroundColor: "color-mix(in oklab, var(--n-surface) 88%, transparent)",
    borderRadius: "4px",
    /* 行内标记横向留白只能用「同色 border」当内边距——padding 会被 CM 的行盒裁掉 */
    borderWidth: "1px 4px",
    borderStyle: "solid",
    borderColor: "color-mix(in oklab, var(--n-surface) 88%, transparent)",
    boxDecorationBreak: "clone",
  },
  ".cm-md-link": { color: "var(--n-accent)" },
  ".cm-md-url": {
    color: "var(--n-fg-dim)",
    textDecoration: "underline",
    textDecorationColor: "var(--n-line-strong)",
  },

  /* ── 引用块：整行左侧竖线 + 灰字斜体 ── */
  ".cm-md-quote-line": {
    position: "relative",
    backgroundColor: "var(--n-accent-soft)",
    borderRadius: "0 4px 4px 0",
    color: "var(--n-fg-dim)",
    fontStyle: "italic",
  },
  /* 竖线用伪元素画，才能贴住整行高度，且不被 .cm-line 的 padding 推走 */
  ".cm-md-quote-line::before": {
    content: '""',
    position: "absolute",
    left: "6px",
    top: "0",
    bottom: "0",
    width: "3px",
    borderRadius: "2px",
    backgroundColor: "var(--n-accent)",
    opacity: "0.55",
    pointerEvents: "none",
  },

  /* ── 分隔线：弱化的记号 ── */
  ".cm-md-hr": { color: "var(--n-fg-faint)", letterSpacing: "0.1em" },

  /* ── 任务列表 ── */
  ".cm-md-task-todo": { color: "var(--n-accent)", fontWeight: "600" },
  ".cm-md-task-done": {
    color: "var(--n-fg-faint)",
    textDecoration: "line-through",
    textDecorationColor: "var(--n-fg-faint)",
  },

  /* ── 代码块：一张全宽的圆角卡片 ──
     预览里的代码块就是这么画的（.md-body pre：--n-code-surface + 圆角 + 细边），
     编辑器这里对齐它。早先底色只铺到文本盒（::before 左右各缩进 18px），
     浅色纸上看不出问题，深色下两侧就是两条暗缝；标行的高亮走同一层，
     也跟着缩在中间，看起来「没选满、被卡住」。现在铺满整行，
     代码块从行号右侧开始是一整块，选中、标行都到边。

     底色仍然走 ::before 而不是直接写 background：.cm-activeLine 会把
     background 整个换成高亮混色，活动行一进代码块，底色就丢了；
     ::before（z-index: -1，最近的层叠上下文是 .cm-scroller）垫在行背景
     下面，两层各自成立。 */
  ".cm-md-codeblock": {
    position: "relative",
    fontFamily: "var(--n-font-mono)",
    fontSize: "0.92em",
    lineHeight: "1.6",
  },
  ".cm-md-codeblock::before": {
    content: '""',
    position: "absolute",
    /* 上下各溢出半像素：行高带小数时，相邻两行的底色之间会有发丝缝 */
    inset: "-0.5px 0",
    /* -2 而不是 -1：选区层（.cm-selectionLayer）也在 -1 这一层、但排在
       内容前面 —— 底色若是 -1 就画在选区之后，把代码块里的选中高亮整个
       盖掉（实底下尤其明显）。压到 -2 让它沉到选区下面：底色垫底、
       选区居中、文字最上。 */
    zIndex: "-2",
    backgroundColor: "var(--n-code-surface)",
    pointerEvents: "none",
  },
  /* 圆角只给首末行：中间行的 ::before 上下要跟相邻行接住，不能收边 */
  ".cm-md-codeblock-open::before": { borderRadius: "9px 9px 0 0" },
  ".cm-md-codeblock-close::before": { borderRadius: "0 0 9px 9px" },
  /* 整块只有一行（围栏开合在同一行）时四个角都要圆 */
  ".cm-md-codeblock-open.cm-md-codeblock-close::before": { borderRadius: "9px" },
  /* 首末行补一点纵向留白，整块看起来才是个独立的段落 */
  ".cm-md-codeblock-open": { paddingTop: "7px" },
  ".cm-md-codeblock-close": { paddingBottom: "7px" },

  /* ── 被「标行」标出来的代码行 ──
     和预览里的 `.pv-line.is-hl` 用同一层色（--n-accent-soft），两边看起来
     才是同一个功能；左边再压一道 3px 竖条。

     实现上不能另起一个 ::before 去画：代码块本身已经用 `::before` 铺了底色，
     同一个元素只能有一个 `::before`，两者会打架。所以直接改那层底，
     竖条用 inset box-shadow 压在框内 —— 左边界正好落在卡片左沿。

     竖条也不能用 border-left：border 会挤动行内容，整块代码向右挪 3px。 */
  ".cm-md-codeblock.cm-md-marked::before": {
    /* 比预览的 accent-soft 再重一档：代码块自己的底色（code-surface）垫在下面，
       同样的 16% 混色在块内显得更淡 —— 实测 24% 才和预览里的观感打平。 */
    backgroundColor: "color-mix(in oklab, var(--n-accent) 24%, var(--n-code-surface))",
    boxShadow: "inset 3px 0 0 0 var(--n-accent)",
  },
  /* 兜底：万一某个主题下这行不是代码行（理论上不会），也让它有底色。
     排除代码行：代码行的高亮在上面那条里已经画过一层实底的，
     这里再叠一层半透明会变味。 */
  ".cm-md-marked:not(.cm-md-codeblock)": {
    backgroundColor: "color-mix(in oklab, var(--n-accent) 11%, transparent)",
  },

  /* ── 代码块的「语言 / 行号」标签 ──
     外层零高度，只当定位基准：它不能占文档流，否则会多出一行空白、
     也会把行号和围栏的对应关系顶歪。真正的可见物是里面那一排绝对定位的小按钮，
     浮在代码块右上角——离内容远，不会和正文、行号抢位置。 */
  ".cm-code-lang": {
    height: "0",
    position: "relative",
    /* 必须自己抬一层，否则这枚标签「看得见、点不到」：
       .cm-md-codeblock 为了让底色和选区矩形对齐用了 position: relative，
       于是代码块每一行也成了定位元素，和这个零高度包裹层同处一个层叠层；
       按钮是绝对定位的、在 DOM 里又排在那一行**前面**，按顺序就被整行盖住了。
       （所以症状很怪：颜色、位置都对，鼠标移上去 hover 也亮，就是点不动。）
       只抬到 2：补全弹层是 10，仍在它上面。 */
    zIndex: "2",
  },
  /* 两颗按钮并排：从右往左排「行号 · 语言」，语言那颗贴最右边，
     因为它是原来就有的位置，加一颗不该把它顶走。 */
  ".cm-code-lang-row": {
    position: "absolute",
    top: "5px",
    right: "14px",
    display: "flex",
    alignItems: "center",
    gap: "4px",
    flexDirection: "row-reverse",
  },
  ".cm-code-lang-btn": {
    display: "inline-flex",
    alignItems: "center",
    gap: "2px",
    height: "18px",
    padding: "0 5px",
    borderRadius: "4px",
    border: "1px solid var(--n-line)",
    backgroundColor: "color-mix(in oklab, var(--n-bg) 82%, transparent)",
    fontFamily: "var(--n-font-ui)",
    fontSize: "10.5px",
    lineHeight: "1",
    color: "var(--n-fg-dim)",
    cursor: "pointer",
    /* 默认压到快看不见：它是「想改才去点」的东西，不该常驻抢戏 */
    opacity: "0.45",
    transition: "opacity 120ms var(--n-ease), color 120ms var(--n-ease)",
  },
  ".cm-code-lang-btn svg": {
    flex: "none",
    fill: "none",
    stroke: "currentColor",
  },
  ".cm-code-lang-btn:hover": {
    opacity: "1",
    color: "var(--n-accent)",
    borderColor: "var(--n-accent)",
  },
  /* 已经指定过语言的那块稍微实一点——有信息量才值得看得见 */
  ".cm-code-lang-btn.has-lang": { opacity: "0.7" },
  /* 行号开着时这颗常亮：状态本身就是要看的信息 */
  ".cm-code-lang-btn--gutter": { opacity: "0.4" },
  ".cm-code-lang-btn--gutter.on": {
    opacity: "1",
    color: "var(--n-accent)",
    borderColor: "color-mix(in oklab, var(--n-accent) 45%, var(--n-line))",
    backgroundColor: "color-mix(in oklab, var(--n-accent) 10%, var(--n-bg))",
  },
});

/**
 * Markdown 与代码的语法高亮。
 *
 * 正文用一套克制的单色调，代码块内部才上彩色 token——
 * 这样一篇长文里，注意力始终在结构上，不在颜色上。
 */
export const notaHighlight = HighlightStyle.define([
  // Markdown 结构
  { tag: t.heading1, fontWeight: "700", color: "var(--n-fg)" },
  { tag: t.heading2, fontWeight: "700", color: "var(--n-fg)" },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: "650", color: "var(--n-fg)" },
  { tag: t.strong, fontWeight: "700", color: "var(--n-fg)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--n-fg-dim)" },
  { tag: t.link, color: "var(--n-accent)" },
  { tag: t.url, color: "var(--n-fg-dim)" },
  { tag: [t.monospace, t.special(t.string)], color: "var(--n-code-fg)" },
  { tag: t.quote, color: "var(--n-fg-dim)", fontStyle: "italic" },
  { tag: t.list, color: "var(--n-fg)" },
  { tag: t.contentSeparator, color: "var(--n-line-strong)" },
  { tag: [t.meta, t.processingInstruction], color: "var(--n-fg-faint)" },
  { tag: t.comment, color: "var(--n-code-comment)", fontStyle: "italic" },

  // 代码 token
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: "var(--n-code-keyword)" },
  { tag: [t.string, t.special(t.brace), t.regexp], color: "var(--n-code-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--n-code-number)" },
  { tag: [t.function(t.variableName), t.labelName], color: "var(--n-code-func)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--n-code-type)" },
  { tag: t.definition(t.variableName), color: "var(--n-code-func)" },
  { tag: t.propertyName, color: "var(--n-code-prop)" },
  { tag: t.operator, color: "var(--n-code-keyword)" },
  { tag: [t.punctuation, t.bracket], color: "var(--n-code-punct)" },
  { tag: t.variableName, color: "var(--n-code-punct)" },
  { tag: t.invalid, color: "var(--n-danger)", textDecoration: "underline wavy var(--n-danger)" },
]);

export const notaThemeExtensions = [notaTheme, syntaxHighlighting(notaHighlight)];

/**
 * 同一套配色，但产出 class 而不是内联样式。
 *
 * 预览区是静态 HTML，没法走 HighlightStyle，只能自己拼 class；
 * 用同一张「标签 → 颜色」表生成，编辑区和预览区才不会走色。
 * 颜色值统一在 `.cm-hl-*` 这些 class 里定义，见 styles/tokens.css。
 */
export const notaHighlightClass = tagHighlighter([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], class: "cm-hl-keyword" },
  { tag: [t.string, t.special(t.brace), t.regexp], class: "cm-hl-string" },
  { tag: [t.number, t.bool, t.null, t.atom], class: "cm-hl-number" },
  {
    tag: [t.function(t.variableName), t.labelName, t.definition(t.variableName)],
    class: "cm-hl-func",
  },
  { tag: [t.typeName, t.className, t.namespace], class: "cm-hl-type" },
  { tag: t.propertyName, class: "cm-hl-prop" },
  { tag: t.operator, class: "cm-hl-operator" },
  { tag: [t.punctuation, t.bracket], class: "cm-hl-punct" },
  { tag: t.variableName, class: "cm-hl-var" },
  { tag: t.comment, class: "cm-hl-comment" },
  { tag: t.invalid, class: "cm-hl-invalid" },
]);

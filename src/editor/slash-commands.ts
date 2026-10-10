import type { Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

/**
 * Slash-command CodeMirror extension.
 *
 * Detects the "/" trigger at the start of a line (or after whitespace),
 * tracks the filter text as the user continues typing, and notifies React
 * via callbacks so it can render the menu overlay. Keyboard navigation
 * (ArrowUp / ArrowDown / Enter / Escape) is handled inside the extension.
 */

export type SlashCommandId =
  | "heading1"
  | "heading2"
  | "heading3"
  | "bold"
  | "italic"
  | "strikethrough"
  | "highlight"
  | "inlineCode"
  | "bulletList"
  | "numberedList"
  | "taskList"
  | "quote"
  | "link"
  | "wikiLink"
  | "noteEmbed"
  | "blockReference"
  | "footnote"
  | "image"
  | "tag"
  | "blockId"
  | "frontMatter"
  | "comment"
  | "codeBlock"
  | "advancedCodeBlock"
  | "mermaid"
  | "table"
  | "inlineMath"
  | "mathBlock"
  | "callout"
  | "details"
  | "tabs"
  | "divider"
  | "aiSummarize"
  | "aiOutline"
  | "aiContinue"
  | "aiTranslate";

/** Visible state pushed to React for rendering the menu overlay. */
export type SlashMenuRenderState = {
  open: boolean;
  /** Document position of the "/" character that opened the menu. */
  slashPos: number;
  /** Raw filter text typed between "/" and the cursor. */
  filter: string;
  /** Currently highlighted (zero-based) index across all visible items. */
  selectedIndex: number;
  /** Viewport (client) x of the cursor — used to position the menu. */
  x: number;
  /** Viewport (client) y of the cursor — used to position the menu. */
  y: number;
};

export type SlashCommandGroup = "formatting" | "ai";

export type SlashCommandItem = {
  id: SlashCommandId;
  group: SlashCommandGroup;
  /** i18n message key for the label. */
  labelKey: string;
};

/** All available slash commands, in display order.
 *  分组与顺序跟工具栏保持一致，避免两个入口的认知错位。 */
export const SLASH_COMMANDS: SlashCommandItem[] = [
  // —— 文本 ——
  { id: "heading1", group: "formatting", labelKey: "slash.heading1" },
  { id: "heading2", group: "formatting", labelKey: "slash.heading2" },
  { id: "heading3", group: "formatting", labelKey: "slash.heading3" },
  { id: "bold", group: "formatting", labelKey: "slash.bold" },
  { id: "italic", group: "formatting", labelKey: "slash.italic" },
  { id: "strikethrough", group: "formatting", labelKey: "slash.strikethrough" },
  { id: "highlight", group: "formatting", labelKey: "slash.highlight" },
  { id: "inlineCode", group: "formatting", labelKey: "slash.inlineCode" },
  // —— 列表 ——
  { id: "bulletList", group: "formatting", labelKey: "slash.bulletList" },
  { id: "numberedList", group: "formatting", labelKey: "slash.numberedList" },
  { id: "taskList", group: "formatting", labelKey: "slash.taskList" },
  { id: "quote", group: "formatting", labelKey: "slash.quote" },
  // —— 链接与引用 ——
  { id: "link", group: "formatting", labelKey: "slash.link" },
  { id: "wikiLink", group: "formatting", labelKey: "slash.wikiLink" },
  { id: "noteEmbed", group: "formatting", labelKey: "slash.noteEmbed" },
  { id: "blockReference", group: "formatting", labelKey: "slash.blockReference" },
  { id: "footnote", group: "formatting", labelKey: "slash.footnote" },
  { id: "image", group: "formatting", labelKey: "slash.image" },
  // —— 笔记 ——
  { id: "tag", group: "formatting", labelKey: "slash.tag" },
  { id: "blockId", group: "formatting", labelKey: "slash.blockId" },
  { id: "frontMatter", group: "formatting", labelKey: "slash.frontMatter" },
  { id: "comment", group: "formatting", labelKey: "slash.comment" },
  // —— 代码 / 表格 / 数学 ——
  { id: "codeBlock", group: "formatting", labelKey: "slash.codeBlock" },
  { id: "advancedCodeBlock", group: "formatting", labelKey: "slash.advancedCodeBlock" },
  { id: "mermaid", group: "formatting", labelKey: "slash.mermaid" },
  { id: "table", group: "formatting", labelKey: "slash.table" },
  { id: "inlineMath", group: "formatting", labelKey: "slash.inlineMath" },
  { id: "mathBlock", group: "formatting", labelKey: "slash.mathBlock" },
  // —— 内容块 ——
  { id: "callout", group: "formatting", labelKey: "slash.callout" },
  { id: "details", group: "formatting", labelKey: "slash.details" },
  { id: "tabs", group: "formatting", labelKey: "slash.tabs" },
  { id: "divider", group: "formatting", labelKey: "slash.divider" },
  // —— AI ——
  { id: "aiSummarize", group: "ai", labelKey: "slash.aiSummarize" },
  { id: "aiOutline", group: "ai", labelKey: "slash.aiOutline" },
  { id: "aiContinue", group: "ai", labelKey: "slash.aiContinue" },
  { id: "aiTranslate", group: "ai", labelKey: "slash.aiTranslate" },
];

/** 中文标签 + 拼音首字母别名，用于本地化搜索。
 *  labelKey 只用于 i18n 查找，用户看到和输入的是中文，所以过滤要认中文。 */
export const SLASH_LABELS: Record<SlashCommandId, string> = {
  heading1: "一级标题",
  heading2: "二级标题",
  heading3: "三级标题",
  bold: "加粗",
  italic: "斜体",
  strikethrough: "删除线",
  highlight: "高亮",
  inlineCode: "行内代码",
  bulletList: "无序列表",
  numberedList: "有序列表",
  taskList: "任务列表",
  quote: "引用块",
  link: "链接",
  wikiLink: "双链笔记",
  noteEmbed: "笔记嵌入",
  blockReference: "块引用",
  footnote: "脚注",
  image: "图片",
  tag: "标签",
  blockId: "块 ID",
  frontMatter: "Front Matter",
  comment: "隐藏注释",
  codeBlock: "代码块",
  advancedCodeBlock: "高级代码块",
  mermaid: "Mermaid 图表",
  table: "表格",
  inlineMath: "行内公式",
  mathBlock: "块级公式",
  callout: "Callout 提示块",
  details: "折叠详情块",
  tabs: "分栏标签",
  divider: "分割线",
  aiSummarize: "AI 摘要",
  aiOutline: "AI 大纲",
  aiContinue: "AI 续写",
  aiTranslate: "AI 翻译",
};

/** 供过滤使用的额外别名（英文 / 常见缩写），命中任意一个即可。 */
const SLASH_ALIASES: Partial<Record<SlashCommandId, string[]>> = {
  heading1: ["h1", "title", "bt"],
  heading2: ["h2", "title", "bt"],
  heading3: ["h3", "title", "bt"],
  bold: ["b", "strong", "jiacu"],
  italic: ["i", "em", "xieti"],
  strikethrough: ["del", "s", "shanchuxian"],
  highlight: ["mark", "gaoliang"],
  inlineCode: ["code", "hangnei"],
  bulletList: ["ul", "list", "wuxu"],
  numberedList: ["ol", "list", "youxu"],
  taskList: ["todo", "task", "renwu"],
  quote: ["blockquote", "yinyong"],
  link: ["url", "lianjie"],
  wikiLink: ["wikilink", "shuanglian", "bl"],
  noteEmbed: ["embed", "qianru"],
  blockReference: ["blockref", "kuaiyinyong"],
  footnote: ["jiazhu", "fz"],
  image: ["img", "picture", "tupian"],
  tag: ["biaoqian", "topic"],
  blockId: ["blockid", "kuaiid"],
  frontMatter: ["fm", "yaml", "meta"],
  comment: ["yincang", "zhushi"],
  codeBlock: ["code", "daima", "fence"],
  advancedCodeBlock: ["advanced", "gaoji"],
  mermaid: ["chart", "diagram", "tubiao"],
  table: ["biaoge"],
  inlineMath: ["math", "gongshi", "xingshi"],
  mathBlock: ["math", "formula", "kuaiji"],
  callout: ["notice", "tishi", "ts"],
  details: ["collapse", "zhedie", "zd"],
  tabs: ["tab", "fenlan", "fl"],
  divider: ["hr", "rule", "fenge"],
  aiSummarize: ["ai", "summary", "zhaiyao"],
  aiOutline: ["ai", "outline", "dagang"],
  aiContinue: ["ai", "continue", "xuxie"],
  aiTranslate: ["ai", "translate", "fanyi"],
};

/** Returns the commands matching the filter string (中文标签 / 英文 key / 别名). */
export function filterSlashCommands(filter: string): SlashCommandItem[] {
  const query = filter.trim().toLowerCase();
  if (!query) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((cmd) => {
    const label = SLASH_LABELS[cmd.id].toLowerCase();
    if (label.includes(query)) return true;
    if (cmd.labelKey.toLowerCase().includes(query)) return true;
    return (SLASH_ALIASES[cmd.id] ?? []).some((alias) => alias.includes(query));
  });
}

type InternalState = {
  open: boolean;
  slashPos: number;
  selectedIndex: number;
};

export type SlashCommandCallbacks = {
  /** Called whenever the menu open/filter/selection state changes. */
  onStateChange: (state: SlashMenuRenderState | null) => void;
  /** Execute a formatting command (menu is closed by the caller). */
  onExecuteFormat: (id: SlashCommandId, view: EditorView) => void;
  /** Execute an AI command (menu is closed by the caller). */
  onExecuteAi: (id: SlashCommandId, view: EditorView) => Promise<void>;
};

/**
 * Heuristic: "/" only opens the menu when it's the first non-whitespace
 * character on its line (or the very first character of the document).
 */
function isSlashTriggerPosition(docText: string, slashPos: number): boolean {
  const lineStart = docText.lastIndexOf("\n", slashPos - 1) + 1;
  const between = docText.slice(lineStart, slashPos);
  return between.trim() === "";
}

/** True when the character at `pos` sits inside a fenced code block. */
function isInCodeBlock(view: EditorView, pos: number): boolean {
  // Heuristic: count ``` fences before pos. Inside a fence we don't trigger.
  const doc = view.state.doc.toString();
  const before = doc.slice(0, pos);
  const fenceMatches = before.match(/^```/gm);
  return (fenceMatches?.length ?? 0) % 2 === 1;
}

export function createSlashCommandsExtension(
  callbacks: SlashCommandCallbacks,
): Extension[] {
  const state: InternalState = { open: false, slashPos: 0, selectedIndex: 0 };

  function closeMenu(view: EditorView) {
    state.open = false;
    callbacks.onStateChange(null);
    void view;
  }

  function emitState(view: EditorView) {
    if (!state.open) return;
    const cursor = view.state.selection.main.head;
    const filter = view.state.sliceDoc(state.slashPos + 1, cursor);
    const filtered = filterSlashCommands(filter);
    const coords = view.coordsAtPos(cursor);
    callbacks.onStateChange({
      open: true,
      slashPos: state.slashPos,
      filter,
      selectedIndex: Math.min(state.selectedIndex, Math.max(0, filtered.length - 1)),
      x: coords?.left ?? 0,
      y: coords?.bottom ?? 0,
    });
  }

  function openMenu(view: EditorView, slashPos: number) {
    state.open = true;
    state.slashPos = slashPos;
    state.selectedIndex = 0;
    emitState(view);
  }

  function executeCurrent(view: EditorView) {
    if (!state.open) return;
    const cursor = view.state.selection.main.head;
    const filter = view.state.sliceDoc(state.slashPos + 1, cursor);
    const filtered = filterSlashCommands(filter);
    const item = filtered[state.selectedIndex];
    if (!item) {
      closeMenu(view);
      return;
    }
    // Remove the "/" and filter text first.
    view.dispatch({
      changes: { from: state.slashPos, to: cursor, insert: "" },
      selection: { anchor: state.slashPos },
      userEvent: "input.slash",
    });
    state.open = false;
    callbacks.onStateChange(null);

    if (item.group === "formatting") {
      callbacks.onExecuteFormat(item.id, view);
    } else {
      void callbacks.onExecuteAi(item.id, view);
    }
  }

  return [
    EditorView.updateListener.of((update) => {
      const view = update.view;
      const sel = view.state.selection.main;

      if (state.open) {
        // Menu is open — validate the cursor is still right after "/" + filter.
        if (!sel.empty) {
          closeMenu(view);
          return;
        }
        const between = view.state.sliceDoc(state.slashPos + 1, sel.head);
        // Any whitespace between "/" and cursor closes the menu.
        if (/\s/.test(between) || sel.head <= state.slashPos) {
          closeMenu(view);
          return;
        }
        emitState(view);
        return;
      }

      // Menu is closed — detect a freshly typed "/".
      if (!update.docChanged || !sel.empty) return;
      const cursor = sel.head;
      if (cursor < 1) return;
      const charBefore = view.state.sliceDoc(cursor - 1, cursor);
      if (charBefore !== "/") return;
      if (!isSlashTriggerPosition(view.state.doc.toString(), cursor - 1)) return;
      if (isInCodeBlock(view, cursor - 1)) return;
      openMenu(view, cursor - 1);
    }),
    keymap.of([
      {
        key: "ArrowDown",
        run: (view) => {
          if (!state.open) return false;
          const cursor = view.state.selection.main.head;
          const filter = view.state.sliceDoc(state.slashPos + 1, cursor);
          const filtered = filterSlashCommands(filter);
          state.selectedIndex = (state.selectedIndex + 1) % Math.max(1, filtered.length);
          emitState(view);
          return true;
        },
      },
      {
        key: "ArrowUp",
        run: (view) => {
          if (!state.open) return false;
          const cursor = view.state.selection.main.head;
          const filter = view.state.sliceDoc(state.slashPos + 1, cursor);
          const filtered = filterSlashCommands(filter);
          const count = Math.max(1, filtered.length);
          state.selectedIndex = (state.selectedIndex - 1 + count) % count;
          emitState(view);
          return true;
        },
      },
      {
        key: "Enter",
        run: (view) => {
          if (!state.open) return false;
          executeCurrent(view);
          return true;
        },
      },
      {
        key: "Escape",
        run: (view) => {
          if (!state.open) return false;
          closeMenu(view);
          return true;
        },
      },
    ]),
  ];
}

import type { EditorView } from "@codemirror/view";
import { openSearchPanel } from "@codemirror/search";
import { store } from "@/store";
import {
  insertBlockIdCommand,
  insertCalloutCommand,
  insertCodeBlockCommand,
  insertFootnoteCommand,
  insertFrontMatterCommand,
  insertImageCommand,
  insertLinkCommand,
  insertLineBlockCommand,
  insertTabsCommand,
  insertTagCommand,
  insertTextCommand,
  insertWrappedBlockCommand,
  toggleBlockPrefix,
  toggleHeadingLevel,
  toggleInlineCodeSpan,
  toggleInlineFormat,
  toggleWrap,
  type MarkdownCommandResult,
} from "./markdown-commands";
import {
  ADVANCED_CODE_INFO,
  DETAILS_CLOSE,
  DETAILS_OPEN,
  HORIZONTAL_RULE_CURSOR_OFFSET,
  HORIZONTAL_RULE_SNIPPET,
  MATH_BLOCK_CURSOR_OFFSET,
  MATH_BLOCK_SNIPPET,
  MERMAID_FALLBACK,
} from "./markdown-snippets";

/**
 * View-level toolbar commands bridging markdown-commands.ts to CodeMirror.
 * Every command dispatches exactly one transaction (one undo step) and
 * refocuses the editor afterwards. Behavior parity notes mirror the
 * inkstone reference toolbar: 5 groups + 4 dropdown menus.
 */

/** Cursor offset of the `[]` inside the `::: details []` opener. */
const DETAILS_CURSOR_OFFSET = "::: details [".length;

function dispatchResult(view: EditorView, result: MarkdownCommandResult) {
  view.dispatch({
    changes: result.change,
    selection: result.selection,
    /* 刻意不传 scrollIntoView。
       工具栏就贴在编辑区上方，点一下按钮就整块往下滚一下，非常晃眼——
       用户报的「点链接/图片，编辑区会往下调」就是它引起的。
       不传时 CodeMirror 只在光标真的跑出视口时才滚动，足够。 */
    userEvent: "input.toolbar",
  });
  view.focus();
}

function doc(view: EditorView) {
  return view.state.doc.toString();
}

function selection(view: EditorView) {
  return view.state.selection.main;
}

/** Selection with head preserved (insertLineBlockCommand uses range.head). */
function headSelection(view: EditorView) {
  const range = view.state.selection.main;
  return { from: range.from, to: range.to, head: range.head };
}

export function toolbarInline(
  view: EditorView,
  format: Parameters<typeof toggleInlineFormat>[2],
) {
  dispatchResult(view, toggleInlineFormat(doc(view), selection(view), format));
}

/** Paired wraps beyond the inline marks: `[[ ]]`, `![[ ]]`, `[[#^ ]]`. */
export function toolbarWrap(view: EditorView, open: string, close = open) {
  dispatchResult(view, toggleWrap(doc(view), selection(view), open, close));
}

export function toolbarInlineCode(view: EditorView) {
  dispatchResult(view, toggleInlineCodeSpan(doc(view), selection(view)));
}

export function toolbarBlockPrefix(
  view: EditorView,
  kind: Parameters<typeof toggleBlockPrefix>[2],
) {
  dispatchResult(view, toggleBlockPrefix(doc(view), selection(view), kind));
}

export function toolbarHeading(
  view: EditorView,
  level: Parameters<typeof toggleHeadingLevel>[2],
) {
  dispatchResult(view, toggleHeadingLevel(doc(view), selection(view), level));
}

export function toolbarLink(view: EditorView, url = "") {
  dispatchResult(view, insertLinkCommand(doc(view), selection(view), url));
}

export function toolbarImage(view: EditorView, url = "") {
  dispatchResult(view, insertImageCommand(doc(view), selection(view), url));
}

export function toolbarTag(view: EditorView) {
  dispatchResult(view, insertTagCommand(selection(view)));
}

export function toolbarBlockId(view: EditorView) {
  dispatchResult(view, insertBlockIdCommand(doc(view), selection(view)));
}

export function toolbarFootnote(view: EditorView) {
  dispatchResult(view, insertFootnoteCommand(doc(view), selection(view)));
}

export function toolbarCallout(view: EditorView) {
  dispatchResult(view, insertCalloutCommand(doc(view), selection(view)));
}

export function toolbarDetails(view: EditorView) {
  dispatchResult(
    view,
    insertWrappedBlockCommand(
      doc(view),
      selection(view),
      DETAILS_OPEN,
      DETAILS_CLOSE,
      "",
      DETAILS_CURSOR_OFFSET,
    ),
  );
}

export function toolbarTabs(view: EditorView, firstLabel: string, secondLabel: string) {
  dispatchResult(
    view,
    insertTabsCommand(doc(view), selection(view), firstLabel, secondLabel),
  );
}

export function toolbarMermaid(view: EditorView) {
  dispatchResult(
    view,
    insertWrappedBlockCommand(
      doc(view),
      selection(view),
      "```mermaid",
      "```",
      MERMAID_FALLBACK,
    ),
  );
}

export function toolbarCodeBlock(view: EditorView) {
  dispatchResult(view, insertCodeBlockCommand(doc(view), selection(view)));
}

export function toolbarAdvancedCodeBlock(view: EditorView) {
  dispatchResult(
    view,
    insertCodeBlockCommand(doc(view), selection(view), ADVANCED_CODE_INFO),
  );
}

/**
 * 插入表格。
 *
 * 两种调用方式：
 *  - 传表头字符串（旧式）→ 按 cols 生成 `| 列 1 | 列 2 |` 这样的表头
 *  - 直接传 header / separator / body 三行（九宫格选尺寸用）→ 原样拼装
 *
 * 光标落在第一个表头格里（offset 2 跳过 `| `），方便直接改名。
 */
export function toolbarTable(
  view: EditorView,
  headerRow: string,
  rowsOrSep: number | string = 1,
  cols = 3,
  bodyRows?: string[],
) {
  let template: string;

  if (typeof rowsOrSep === "string") {
    // 九宫格路径：三行都由调用方给好
    const parts = [headerRow, rowsOrSep, ...(bodyRows ?? [])];
    template = [...parts, ""].join("\n");
  } else {
    // 旧式路径：表头按列数生成，数据行留空
    const header = Array.from(
      { length: cols },
      (_, index) => `| ${headerLabel(headerRow, index)}`,
    );
    header.push("|");
    const delimiter = `|${" --- |".repeat(cols)}`;
    const dataRows = Array.from(
      { length: Math.max(1, rowsOrSep - 1) },
      () => `|${"  |".repeat(cols)}`,
    );
    template = [header.join(""), delimiter, ...dataRows, ""].join("\n");
  }

  dispatchResult(view, insertLineBlockCommand(doc(view), headSelection(view), template, 2));
}

/** Indexes per-column labels out of the i18n header row like "| 列 1 | 列 2 |". */
function headerLabel(headerRow: string, index: number): string {
  const cells = headerRow.split("|").map((cell) => cell.trim());
  const label = cells[index + 1];
  return label || `Column ${index + 1}`;
}

export function toolbarHorizontalRule(view: EditorView) {
  dispatchResult(
    view,
    insertLineBlockCommand(
      doc(view),
      headSelection(view),
      HORIZONTAL_RULE_SNIPPET,
      HORIZONTAL_RULE_CURSOR_OFFSET,
    ),
  );
}

export function toolbarMathBlock(view: EditorView) {
  dispatchResult(
    view,
    insertTextCommand(selection(view), MATH_BLOCK_SNIPPET, MATH_BLOCK_CURSOR_OFFSET),
  );
}

export function toolbarFrontMatter(view: EditorView) {
  dispatchResult(view, insertFrontMatterCommand(doc(view)));
}

/** 打开 CodeMirror 内置搜索面板（Ctrl+F 同款）。 */
export function toolbarFind(view: EditorView) {
  openSearchPanel(view);
}

/**
 * 选一个本地图片/视频复制进工作区 attachments/，然后把引用插入光标处。
 *
 * 图片走标准 `![alt](path)`；视频用 `<video src>` 标签——Markdown 没有
 * 原生的视频语法，而 `<video>` 在预览里能直接播，是最小惊讶的选择。
 *
 * 路径统一用相对路径（attachments/xxx），由主进程的 nota-media:// 协议
 * 换算成可加载的 URL，所以写作时不依赖绝对盘符、换机器也不丢。
 *
 * @param kind 选择哪一类文件：image / video / any（不限）
 * @returns 是否真的插入了（用户取消返回 false，便于外层提示）
 */
export async function pickImageAndInsert(
  view: EditorView,
  kind: "image" | "video" | "any" = "image",
): Promise<boolean> {
  const api = (globalThis as { window?: { api?: Window["api"] } }).window?.api;
  if (!api?.pickImage) return false;

  const picked = await api.pickImage(store.state.root ?? "", kind);
  if (!picked) return false;

  const alt = picked.alt || "媒体";
  const isVideo = picked.isVideo || kind === "video";

  if (isVideo) {
    // Markdown 没有原生视频语法，用 <video> 标签，预览里能直接播。
    // 结尾留一个光标位，插完可以紧接着写东西。
    const snippet = `<video src="${picked.rel}" controls></video>`;
    dispatchResult(
      view,
      insertTextCommand(selection(view), snippet, snippet.length),
    );
  } else {
    const snippet = `![${alt}](${picked.rel})`;
    dispatchResult(view, insertTextCommand(selection(view), snippet, snippet.length));
  }
  return true;
}

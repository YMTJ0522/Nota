import { EditorState, Prec, type Extension } from "@codemirror/state";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder as cmPlaceholder,
  rectangularSelection,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
} from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";

import { toolbarKeymap } from "./toolbar-keymap";
import { codeLangCompleteExtensions } from "./code-lang-complete";
import { fencedCodeBlockHighlighter } from "./code-languages";
import { markdownLivePreview } from "./live-preview";

/**
 * 「视图偏好」类扩展：行号与自动换行。
 *
 * 单独拎出来是因为它们要能在运行时开关（设置页的两个开关），
 * 靠 Compartment 重配置比销毁重建编辑器温和得多——不会丢滚动位置与撤销历史。
 *
 * 自动换行默认开：长行（图片、视频、带中文文件名的链接）在窄栏里
 * 会顶出可视区，CodeMirror 为了跟住光标会把内容横向滚走，
 * 于是正文滑到行号底下、两者叠在一起。换行是从根上避免这件事。
 */
export function editorViewPrefs(opts: { lineWrap: boolean; lineNumbers: boolean }): Extension[] {
  const list: Extension[] = [];
  if (opts.lineNumbers) list.push(lineNumbers(), highlightActiveLineGutter());
  if (opts.lineWrap) list.push(EditorView.lineWrapping);
  return list;
}

/**
 * Baseline CodeMirror extension set for the Markdown editor.
 *
 * Everything markdown-specific but design-agnostic lives here; visual
 * theming is layered on top by `theme.ts`.
 */
export function baseExtensions(options: {
  placeholder?: string;
  editable?: boolean;
  onDocChanged?: (doc: string) => void;
  /** Ctrl+F 交给外层自己画的搜索条；不给就退回 CodeMirror 原生面板 */
  onFind?: () => void;
}): Extension[] {
  const { placeholder = "", editable = true, onDocChanged, onFind } = options;

  const extensions: Extension[] = [
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    indentUnit.of("  "),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    // 查找替换面板：显式注册 search 扩展，Ctrl+F 的面板才有一致的结构与样式
    search({ top: true }),
    markdown({
      base: markdownLanguage,
      codeLanguages: languages,
      addKeymap: true,
    }),
    markdownLivePreview,
    fencedCodeBlockHighlighter(),
    codeLangCompleteExtensions(),
    // 自定义搜索条优先于原生面板：Prec.highest 保证 Ctrl+F 不被 searchKeymap 抢走
    ...(onFind
      ? [
          Prec.highest(
            keymap.of([
              { key: "Mod-f", run: () => (onFind(), true), preventDefault: true },
            ]),
          ),
        ]
      : []),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...toolbarKeymap,
      indentWithTab,
    ]),
  ];

  if (placeholder) extensions.push(cmPlaceholder(placeholder));
  if (!editable) extensions.push(EditorState.readOnly.of(true));
  if (onDocChanged) {
    extensions.push(
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onDocChanged(update.state.doc.toString());
      }),
    );
  }

  return extensions;
}

export { EditorView, EditorState };

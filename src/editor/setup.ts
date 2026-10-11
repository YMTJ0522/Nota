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
    lineNumbers(),
    highlightActiveLineGutter(),
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

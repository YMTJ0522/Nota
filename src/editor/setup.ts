import { EditorState, type Extension } from "@codemirror/state";
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
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
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
}): Extension[] {
  const { placeholder = "", editable = true, onDocChanged } = options;

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
    markdown({
      base: markdownLanguage,
      codeLanguages: languages,
      addKeymap: true,
    }),
    fencedCodeBlockHighlighter(),
    codeLangCompleteExtensions(),
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

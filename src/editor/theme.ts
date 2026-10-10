import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/**
 * Nota's CodeMirror theme.
 *
 * All colors read from the app's `--n-*` custom properties, so the editor
 * follows the light/dark switch without a second theme definition.
 */

export const notaTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "transparent",
    color: "var(--n-fg)",
    fontSize: "var(--n-fs-body)",
  },
  ".cm-scroller": {
    fontFamily: "var(--n-font-mono)",
    lineHeight: "var(--n-lh)",
    overflow: "auto",
  },
  ".cm-content": {
    padding: "28px 0 45vh",
    caretColor: "var(--n-accent)",
    maxWidth: "var(--n-measure)",
    margin: "0 auto",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-line": { padding: "0 32px" },

  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--n-fg-faint)",
    border: "none",
    fontSize: "12px",
    paddingLeft: "8px",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 6px 0 4px" },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--n-fg-dim)",
  },
  ".cm-activeLine": { backgroundColor: "var(--n-active-line)" },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--n-accent)",
    borderLeftWidth: "2px",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--n-selection)",
  },
  ".cm-selectionMatch": { backgroundColor: "var(--n-selection)" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "var(--n-selection)",
    outline: "1px solid var(--n-line-strong)",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--n-surface)",
    border: "1px solid var(--n-line)",
    color: "var(--n-fg-dim)",
    borderRadius: "4px",
    padding: "0 6px",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--n-raised)",
    border: "1px solid var(--n-line)",
    borderRadius: "8px",
    boxShadow: "var(--n-shadow)",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--n-accent-soft)",
    color: "var(--n-fg)",
  },
  ".cm-md-codeblock": { backgroundColor: "var(--n-code-bg)" },
  ".cm-panels": {
    backgroundColor: "var(--n-surface)",
    borderColor: "var(--n-line)",
    color: "var(--n-fg)",
  },
});

/**
 * Markdown syntax highlighting. The palette leans on one accent hue with
 * weight/opacity variation, so long documents stay calm to read.
 */
export const notaHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.6em", fontWeight: "700", color: "var(--n-fg)" },
  { tag: t.heading2, fontSize: "1.35em", fontWeight: "700", color: "var(--n-fg)" },
  { tag: t.heading3, fontSize: "1.18em", fontWeight: "600", color: "var(--n-fg)" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "600", color: "var(--n-fg)" },
  { tag: t.strong, fontWeight: "700", color: "var(--n-fg)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--n-fg-dim)" },
  { tag: t.link, color: "var(--n-accent)", textDecoration: "underline" },
  { tag: t.url, color: "var(--n-fg-dim)" },
  { tag: [t.monospace, t.special(t.string)], color: "var(--n-code-fg)" },
  { tag: t.quote, color: "var(--n-fg-dim)", fontStyle: "italic" },
  { tag: t.list, color: "var(--n-accent)" },
  { tag: t.contentSeparator, color: "var(--n-line-strong)" },
  { tag: [t.meta, t.processingInstruction], color: "var(--n-fg-faint)" },
  { tag: t.comment, color: "var(--n-fg-faint)", fontStyle: "italic" },
  { tag: [t.keyword, t.operatorKeyword], color: "var(--n-code-keyword)" },
  { tag: [t.string, t.special(t.brace)], color: "var(--n-code-string)" },
  { tag: [t.number, t.bool, t.null], color: "var(--n-code-number)" },
  { tag: [t.function(t.variableName), t.labelName], color: "var(--n-code-func)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--n-code-type)" },
  { tag: t.propertyName, color: "var(--n-fg)" },
  { tag: t.invalid, color: "var(--n-danger)" },
]);

export const notaThemeExtensions = [notaTheme, syntaxHighlighting(notaHighlight)];

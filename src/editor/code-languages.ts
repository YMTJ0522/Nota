import { LanguageDescription, LanguageSupport, StreamLanguage, syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";

export const fencedCodeLanguages = [
  LanguageDescription.of({
    name: "JavaScript",
    alias: ["js", "javascript", "mjs", "cjs"],
    extensions: ["js", "mjs", "cjs"],
    load: () => import("@codemirror/lang-javascript").then((mod) => mod.javascript()),
  }),
  LanguageDescription.of({
    name: "TypeScript",
    alias: ["ts", "typescript"],
    extensions: ["ts"],
    load: () =>
      import("@codemirror/lang-javascript").then((mod) => mod.javascript({ typescript: true })),
  }),
  LanguageDescription.of({
    name: "JSX",
    alias: ["jsx"],
    extensions: ["jsx"],
    load: () => import("@codemirror/lang-javascript").then((mod) => mod.javascript({ jsx: true })),
  }),
  LanguageDescription.of({
    name: "TSX",
    alias: ["tsx"],
    extensions: ["tsx"],
    load: () =>
      import("@codemirror/lang-javascript").then((mod) =>
        mod.javascript({ jsx: true, typescript: true }),
      ),
  }),
  LanguageDescription.of({
    name: "Python",
    alias: ["py", "python"],
    extensions: ["py"],
    load: () => import("@codemirror/lang-python").then((mod) => mod.python()),
  }),
  LanguageDescription.of({
    name: "JSON",
    alias: ["json"],
    extensions: ["json"],
    load: () => import("@codemirror/lang-json").then((mod) => mod.json()),
  }),
  LanguageDescription.of({
    name: "Rust",
    alias: ["rs", "rust"],
    extensions: ["rs"],
    load: () => import("@codemirror/lang-rust").then((mod) => mod.rust()),
  }),
  LanguageDescription.of({
    name: "Go",
    alias: ["go", "golang"],
    extensions: ["go"],
    load: () => import("@codemirror/lang-go").then((mod) => mod.go()),
  }),
  LanguageDescription.of({
    name: "SQL",
    alias: ["sql"],
    extensions: ["sql"],
    load: () => import("@codemirror/lang-sql").then((mod) => mod.sql()),
  }),
  LanguageDescription.of({
    name: "YAML",
    alias: ["yml", "yaml"],
    extensions: ["yml", "yaml"],
    load: () => import("@codemirror/lang-yaml").then((mod) => mod.yaml()),
  }),
  LanguageDescription.of({
    name: "CSS",
    alias: ["css"],
    extensions: ["css"],
    load: () => import("@codemirror/lang-css").then((mod) => mod.css()),
  }),
  LanguageDescription.of({
    name: "HTML",
    alias: ["html", "htm"],
    extensions: ["html", "htm"],
    load: () => import("@codemirror/lang-html").then((mod) => mod.html()),
  }),
  LanguageDescription.of({
    name: "XML",
    alias: ["xml"],
    extensions: ["xml"],
    load: () => import("@codemirror/lang-xml").then((mod) => mod.xml()),
  }),
  LanguageDescription.of({
    name: "C++",
    alias: ["c", "h", "cc", "cpp", "cxx", "hpp", "c++"],
    extensions: ["c", "h", "cc", "cpp", "cxx", "hpp"],
    load: () => import("@codemirror/lang-cpp").then((mod) => mod.cpp()),
  }),
  LanguageDescription.of({
    name: "Java",
    alias: ["java"],
    extensions: ["java"],
    load: () => import("@codemirror/lang-java").then((mod) => mod.java()),
  }),
  LanguageDescription.of({
    name: "Shell",
    alias: ["bash", "sh", "zsh", "shell"],
    extensions: ["sh", "bash"],
    load: () =>
      import("@codemirror/legacy-modes/mode/shell").then(
        (mod) => new LanguageSupport(StreamLanguage.define(mod.shell)),
      ),
  }),
];

/**
 * 代码块每一行的底色 + 首尾行的圆角。
 *
 * 注意：这里手写 RangeSet 而不是用 RangeSetBuilder。
 * builder 要求按 from 升序 add，而我们是「外层遍历节点、内层遍历行」，
 * 多个代码块时行号会回跳，加进去的顺序就乱了——底色会串行、宽度会错。
 * 所以先收集全部行号，排序去重后再构造，顺序天然正确。
 */
const BLOCK_MID = Decoration.line({ class: "cm-md-codeblock" });
const BLOCK_OPEN = Decoration.line({
  class: "cm-md-codeblock cm-md-codeblock-open",
});
const BLOCK_CLOSE = Decoration.line({
  class: "cm-md-codeblock cm-md-codeblock-close",
});

function decorateCodeBlockLines(view: EditorView) {
  const { doc } = view.state;
  const firsts = new Set<number>();
  const lasts = new Set<number>();
  const middles = new Set<number>();

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        if (node.name !== "FencedCode" && node.name !== "CodeBlock") return;
        const first = doc.lineAt(node.from).number;
        const last = doc.lineAt(Math.max(node.from, node.to - 1)).number;
        for (let n = first; n <= last; n += 1) {
          if (n === first) firsts.add(n);
          else if (n === last) lasts.add(n);
          else middles.add(n);
        }
      },
    });
  }

  /* 单行代码块：首尾同一行，开合都套上 */
  const singleLines = [...firsts].filter((n) => lasts.has(n));
  const ranges: { from: number; decoration: Decoration }[] = [];
  const push = (n: number, decoration: Decoration) => {
    const { from } = doc.line(n);
    ranges.push({ from, decoration });
  };

  for (const n of firsts) {
    if (singleLines.includes(n)) continue;
    push(n, BLOCK_OPEN);
  }
  for (const n of middles) push(n, BLOCK_MID);
  for (const n of lasts) {
    if (singleLines.includes(n)) continue;
    push(n, BLOCK_CLOSE);
  }
  for (const n of singleLines) {
    push(
      n,
      Decoration.line({
        class: "cm-md-codeblock cm-md-codeblock-open cm-md-codeblock-close",
      }),
    );
  }

  ranges.sort((a, b) => a.from - b.from);
  return Decoration.set(
    ranges.map((r) => r.decoration.range(r.from)),
    true,
  );
}

export function fencedCodeBlockHighlighter() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = decorateCodeBlockLines(view);
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state)
        ) {
          this.decorations = decorateCodeBlockLines(update.view);
        }
      }
    },
    { decorations: (value) => value.decorations },
  );
}

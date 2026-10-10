import { syntaxTree } from "@codemirror/language";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import type { Range } from "@codemirror/state";

/**
 * Markdown 实时预览装饰层。
 *
 * CodeMirror 默认只做「语法着色」——源码里的 `##`、`**`、`- ` 全都明晃晃地
 * 显示着，标题也只是加粗，没有真正的层级感，整篇看起来就是一堆符号。
 *
 * 这一层做两件事：
 *  1. 给语义节点打 class（强调 / 标题 / 行内代码 / 链接 / 引用 / 列表标记…），
 *     让 CSS 能按语义渲染，而不是按 token 猜；
 *  2. 把**标记符号本身**标成 `cm-md-marker`，CSS 里把它调淡。这样
 *     `**加粗**` 的重点落在「加粗」上，`##` 退成安静的注脚。
 *
 * 全部基于 `Decoration.mark`（只改表现、不动文档），所以编辑、撤销、
 * 搜索、保存拿到的始终是纯 Markdown 源码。
 */

/** Lezer Markdown 节点名 → 我们的 class。顺序无所谓，命中即打。 */
const NODE_CLASS: Record<string, string> = {
  // 行内
  StrongEmphasis: "cm-md-strong",
  Emphasis: "cm-md-em",
  Strikethrough: "cm-md-strike",
  InlineCode: "cm-md-inline-code",
  Link: "cm-md-link",
  URL: "cm-md-url",
  // 块级（Blockquote 由行级分支单独处理，见下方 enter()）
  HorizontalRule: "cm-md-hr",
};

/** 标题按级别分别给 class，CSS 里逐级设定字号。 */
const HEADING_CLASS: Record<string, string> = {
  ATXHeading1: "cm-md-h1",
  ATXHeading2: "cm-md-h2",
  ATXHeading3: "cm-md-h3",
  ATXHeading4: "cm-md-h4",
  ATXHeading5: "cm-md-h5",
  ATXHeading6: "cm-md-h6",
  SetextHeading1: "cm-md-h1",
  SetextHeading2: "cm-md-h2",
};

/**
 * 需要「调淡」的标记节点。
 *
 * 这些符号不该抢戏：标题的 `#`、强调的 `**`/`*`/`~~`、列表的 `-`/`1.`、
 * 引用的 `>`、代码围栏的 ```` ``` ````、分隔线的 `---`。
 * 淡化之后，正文本身才是视觉主体。
 */
const MARKER_NODES = new Set([
  "HeaderMark",
  "EmphasisMark",
  "CodeMark",
  "QuoteMark",
  "ListMark",
  "StrikethroughMark",
  "LinkMark",
]);

/** 列表标记单独给一层 class，方便用强调色区分 • 与 1. */
const LIST_MARKER_NODES = new Set(["ListMark"]);

/** 任务列表里已经勾选的那一行，整行弱化 + 删除线。 */
const TASK_DONE_LINE = /^\s*[-*+]\s+\[[xX]\]\s/;
/** 任务列表未勾选的行，让 `[ ]` 保持醒目。 */
const TASK_TODO_LINE = /^\s*[-*+]\s+\[\s\]\s/;

function buildDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const seenHeadings = new Set<number>();
  /** 大标题字号超过 1em，行盒会被压扁，需要给 line 补类做垂直留白 */
  const seenCodeBlocks = new Set<number>();
  const seenQuotes = new Set<number>();

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        const name = node.name;

        // 引用块：本身是行级容器（不是行内 mark），必须在通用映射之前拦下，
        // 否则会被 NODE_CLASS 当行内标记处理掉，竖线永远不会出现。
        if (name === "Blockquote") {
          const first = view.state.doc.lineAt(node.from);
          const last = view.state.doc.lineAt(Math.max(node.from, node.to - 1));
          for (let n = first.number; n <= last.number; n += 1) {
            if (seenQuotes.has(n)) continue;
            seenQuotes.add(n);
            const line = view.state.doc.line(n);
            ranges.push(
              Decoration.line({ class: "cm-md-quote-line" }).range(line.from),
            );
          }
          return;
        }

        const cls = HEADING_CLASS[name] ?? NODE_CLASS[name];

        if (cls) {
          // 整行标题：从行首到行尾（含标记），保证字号/间距覆盖完整
          const line = view.state.doc.lineAt(node.from);
          if (cls.startsWith("cm-md-h") && !seenHeadings.has(line.number)) {
            seenHeadings.add(line.number);
            ranges.push(Decoration.line({ class: cls }).range(line.from));
          } else if (!cls.startsWith("cm-md-h")) {
            ranges.push(Decoration.mark({ class: cls }).range(node.from, node.to));
          }
          return;
        }

        if (MARKER_NODES.has(name)) {
          const markerCls = LIST_MARKER_NODES.has(name)
            ? "cm-md-marker cm-md-marker-list"
            : "cm-md-marker";
          ranges.push(Decoration.mark({ class: markerCls }).range(node.from, node.to));
          return;
        }

        // 代码块首尾行：额外加圆角类，让整块看起来是一个"卡片"
        if (name === "FencedCode" || name === "CodeBlock") {
          const first = view.state.doc.lineAt(node.from);
          const last = view.state.doc.lineAt(Math.max(node.from, node.to - 1));
          if (!seenCodeBlocks.has(first.number)) {
            seenCodeBlocks.add(first.number);
            ranges.push(
              Decoration.line({ class: "cm-md-codeblock-open" }).range(first.from),
            );
          }
          if (last.number !== first.number) {
            ranges.push(
              Decoration.line({ class: "cm-md-codeblock-close" }).range(last.from),
            );
          }
        }
      },
    });
  }

  // 任务状态：未勾选的行让 `[ ]` 用强调色，勾选的整行弱化
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      const text = line.text;
      if (TASK_DONE_LINE.test(text)) {
        ranges.push(Decoration.line({ class: "cm-md-task-done" }).range(line.from));
      } else if (TASK_TODO_LINE.test(text)) {
        const markIdx = text.indexOf("[");
        if (markIdx >= 0) {
          ranges.push(
            Decoration.mark({ class: "cm-md-task-todo" }).range(
              line.from + markIdx,
              Math.min(line.from + markIdx + 3, line.to),
            ),
          );
        }
      }
      if (line.to >= to) break;
      pos = line.to + 1;
    }
  }

  return Decoration.set(ranges, true);
}

/**
 * 只在文档或视口变化时重建。语法树迭代本身很便宜，且只跑可见区域，
 * 长文档下开销可控。
 */
export const markdownLivePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  },
);

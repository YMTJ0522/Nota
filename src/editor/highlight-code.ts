/**
 * 预览模式的代码高亮。
 *
 * 编辑区用的是 CodeMirror 的 HighlightStyle，预览区是 marked 生成的静态 HTML——
 * 两边如果各配一套颜色，很快就会出现"同一个代码块在编辑和预览里长得不一样"。
 * 所以这里复用同一套 `--n-code-*` 变量，产出同名的 `cm-hl-*` class，
 * 由 theme.ts 里那份 Highlighter 统一提供颜色。
 *
 * 实现上借道 CodeMirror 自己：把代码片段喂给对应的 Lezer 语言，
 * 走一遍 syntaxTree 拿到 token 类型，再映射成 class。
 * 好处是编辑区和预览区的 token 判定完全同源，不会一个认得出
 * `const` 是关键字、另一个认不出。
 */
import { highlightTree } from "@lezer/highlight";
import { LanguageDescription, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { fencedCodeLanguages } from "./code-languages";
import { notaHighlightClass } from "./theme";

const CACHE_LIMIT = 80;
const cache = new Map<string, string>();

/** 语言名 → 已加载的 LanguageSupport。找不到就退化成纯文本。 */
async function resolveLanguage(name: string) {
  const desc =
    fencedCodeLanguages.find(
      (d) => d.name.toLowerCase() === name.toLowerCase() ||
        d.alias.includes(name.toLowerCase()),
    ) ?? null;
  if (!desc) return null;
  const support = await desc.load();
  return support.language;
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface Segment {
  from: number;
  to: number;
  classes: string;
}

/**
 * 把一段代码渲染成「按行切开」的高亮 HTML。
 *
 * 比朴素做法多做的那一步是行切分：每行包一个 `<span class="pv-line">`，
 * 行号、高亮行、折叠都要靠它——没有行容器，CSS 只能整块着色，
 * 做不到「第几行」这种粒度。
 *
 * 难点在于 token 会跨行（块注释、模板字符串）。处理办法是先收下全部
 * token 区间，再按行边界把跨行的那段切成两半，各自留在自己的行里，
 * 而不是简单地按 \n 把 HTML 字符串劈开——那样会把未闭合的 span 切断。
 *
 * 语言未知或解析失败时原样转义返回，绝不因为高亮失败而丢内容。
 */
export async function highlightCode(
  code: string,
  lang: string,
  opts: { start?: number; highlights?: number[] } = {},
): Promise<string> {
  const start = Math.max(1, opts.start ?? 1);
  const marks = new Set(opts.highlights ?? []);
  const key = `${lang}\u0000${start}\u0000${[...marks].join(",")}\u0000${code}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const fallback = escapeHtml(code);
  let out = fallback;

  try {
    const language = await resolveLanguage(lang);
    if (language) {
      const state = EditorState.create({ doc: code, extensions: [language] });
      const tree = syntaxTree(state);
      const segments: Segment[] = [];
      highlightTree(tree, notaHighlightClass, (from, to, classes) => {
        if (to > from) segments.push({ from, to, classes });
      });
      segments.sort((a, b) => a.from - b.from);
      out = renderLines(code, segments, start, marks);
    } else {
      out = renderLines(code, [], start, marks);
    }
  } catch {
    out = fallback;
  }

  if (cache.size > CACHE_LIMIT) cache.clear();
  cache.set(key, out);
  return out;
}

/** 按行组装。没有 token 信息时也走同一条路，保证结构一致（都有 .pv-line）。 */
function renderLines(
  code: string,
  segments: Segment[],
  /** 行号起始值，`start=10` 时第一行显示 10 */
  firstLine: number,
  marks: Set<number>,
): string {
  const lines = code.split("\n");
  const parts: string[] = [];
  let cursor = 0; // 行首在原文中的位置
  let seg = 0; // 第一个可能还没用完的 token

  for (let i = 0; i < lines.length; i += 1) {
    const start = cursor;
    const end = cursor + lines[i].length;
    cursor = end + 1; // +1 是那个被 split 吃掉的 \n

    // 跨行的 token 要留在指针里，所以只推进「已经彻底走完」的段
    while (seg < segments.length && segments[seg].to <= start) seg += 1;

    const inner: string[] = [];
    let at = start;
    for (let s = seg; s < segments.length && segments[s].from < end; s += 1) {
      const g = segments[s];
      const a = Math.max(g.from, start);
      const b = Math.min(g.to, end);
      if (a > at) inner.push(escapeHtml(code.slice(at, a)));
      if (b > a) {
        inner.push(`<span class="${g.classes}">${escapeHtml(code.slice(a, b))}</span>`);
      }
      at = Math.max(at, b);
    }
    if (at < end) inner.push(escapeHtml(code.slice(at, end)));

    // 高亮行是「文件里的行号」，从 firstLine 起算，所以要加上偏移
    const lineNo = firstLine + i;
    parts.push(
      `<span class="pv-line${marks.has(lineNo) ? " is-hl" : ""}" data-line="${lineNo}">${inner.join("")}</span>`,
    );
  }

  // 行与行之间补回真实换行：空行的 span 内容为空，靠 CSS 的 min-height 撑高度
  return parts.join("\n");
}

/** 从 marked 生成的 `<pre><code class="language-js">` 里取出语言名 */
export function langFromClass(className: string): string {
  const m = /language-([\w+#-]+)/.exec(className);
  return m ? m[1] : "";
}

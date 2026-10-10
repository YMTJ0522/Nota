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

/**
 * 把一段代码渲染成带高亮 class 的 HTML。
 * 语言未知或解析失败时原样转义返回，绝不因为高亮失败而丢内容。
 */
export async function highlightCode(code: string, lang: string): Promise<string> {
  const key = `${lang}\u0000${code}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const fallback = escapeHtml(code);
  let out = fallback;

  try {
    const language = await resolveLanguage(lang);
    if (language) {
      const state = EditorState.create({ doc: code, extensions: [language] });
      const tree = syntaxTree(state);
      let pos = 0;
      const parts: string[] = [];
      highlightTree(tree, notaHighlightClass, (from, to, classes) => {
        if (from > pos) parts.push(escapeHtml(code.slice(pos, from)));
        parts.push(
          `<span class="${classes}">${escapeHtml(code.slice(from, to))}</span>`,
        );
        pos = to;
      });
      if (pos < code.length) parts.push(escapeHtml(code.slice(pos)));
      out = parts.join("");
    }
  } catch {
    out = fallback;
  }

  if (cache.size > CACHE_LIMIT) cache.clear();
  cache.set(key, out);
  return out;
}

/** 从 marked 生成的 `<pre><code class="language-js">` 里取出语言名 */
export function langFromClass(className: string): string {
  const m = /language-([\w+#-]+)/.exec(className);
  return m ? m[1] : "";
}

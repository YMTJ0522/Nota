/**
 * 「标行」——给围栏代码块标出要人看的几行。
 *
 * 这套语法（`line-numbers` + `{2,4-6}`）一直都在，只是写起来得记四条规矩：
 * 语言要写在最前面、行号从 1 数、花括号得用半角、区间用 `-`。写错一条
 * 不报错，只是没效果——所以它等于不存在。这个文件把那一串改写收成一次点击：
 * **想标哪几行，就选中那几行。**
 *
 * 三条设计上的选择：
 *
 *  1. **行号就是编辑器里看到的行号**。不用换算成「代码内第几行」——
 *     看到第 3 行就是 `{3}`，跟预览里数出来的一致；
 *  2. **合并而不是覆盖**。已经标了 2，再标 7-8，得到 `{2,7-8}`。
 *     覆盖的话每点一次都得先把旧的全选中，那还不如手写；
 *  3. **标行必带行号，撤干净就一起撤**。没有行号，「标了第几行」这句话
 *     就没有落点；而如果行号本来就是这一下顺手加的，全撤之后也一并
 *     去掉，块就回到点之前的样子，不留一根多余的空轨。
 */

import { syntaxTree } from "@codemirror/language";
import type { EditorState, Line } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { formatLineSpec, parseLineSpec } from "./code-line-spec";

/** 起始围栏：缩进 + 三个以上反引号或波浪号 */
const OPEN_FENCE = /^([ \t]*)(`{3,}|~{3,})/;

/** `line-numbers` / `lineNumbers` / `line_numbers` 都认，与预览保持一致 */
const NUMBERED_TOKEN = /^line[-_]?numbers$/i;

/**
 * info 串拆出来的四样东西。
 * 顺序无关：`{2} title="x"` 和 `title="x" {2}` 读出来一样，
 * 写回去统一按 `语言 title line-numbers {…}` 排——重排一次没有副作用，
 * 反而让人下次照着写的时候有个固定样子可抄。
 */
export interface FenceInfo {
  lang: string;
  /** `title="…"` 原样保留（引号是原作者的，不替他改） */
  title: string | null;
  numbered: boolean;
  /** 1 起的行号 */
  marks: Set<number>;
  /** 没认出来的记号原样留着，不能因为不认识就把人写的东西吞掉 */
  extra: string[];
}

export interface FenceBlock {
  from: number;
  to: number;
  /** 起始围栏那一行 */
  openLine: Line;
  /** 缩进与围栏记号，都不是空串 */
  indent: string;
  marker: string;
  /** info 串在文档里的范围：围栏记号之后 → 行尾 */
  infoFrom: number;
  infoTo: number;
  info: FenceInfo;
  /** 围栏之间的行，下标 0 就是代码第 1 行 */
  content: Line[];
}

/* ── info 串的解析与回写 ── */

/**
 * 按空白切词，但 `title="两周回顾"` 和 `{2, 4-6}` 里的空格不算边界。
 * 直接 `split(/\s+/)` 会把这两样各切两半，写回去就成了
 * `title="两周` `回顾"` —— 预览那边认不出来，标题凭空消失。
 */
function parseFenceInfo(raw: string): FenceInfo {
  const tokens: string[] = [];
  let buf = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (/\s/.test(ch)) {
      if (buf) {
        tokens.push(buf);
        buf = "";
      }
      continue;
    }
    if (ch === "{" || ch === "\"" || ch === "'") {
      const close = ch === "{" ? "}" : ch;
      const end = raw.indexOf(close, i + 1);
      if (end > i) {
        if (ch === "{") {
          if (buf) {
            tokens.push(buf);
            buf = "";
          }
          tokens.push(raw.slice(i, end + 1));
        } else {
          buf += raw.slice(i, end + 1);
        }
        i = end;
        continue;
      }
    }
    buf += ch;
  }
  if (buf) tokens.push(buf);

  const info: FenceInfo = { lang: "", title: null, numbered: false, marks: new Set(), extra: [] };
  tokens.forEach((token, index) => {
    if (NUMBERED_TOKEN.test(token)) {
      info.numbered = true;
      return;
    }
    if (/^title\s*=/i.test(token)) {
      info.title = token;
      return;
    }
    if (/^\{[\d,\s-]*\}$/.test(token)) {
      for (const n of parseLineSpec(token.slice(1, -1))) info.marks.add(n);
      return;
    }
    // 只有第一段能当语言——预览那边也是这么取的
    if (index === 0) {
      info.lang = token;
      return;
    }
    info.extra.push(token);
  });
  return info;
}

/**
 * 四样东西拼回围栏记号之后的那一段。
 *
 * 没写语言时前面那个空格**不能省**：` ```line-numbers ` 会被所有解析方
 * （围栏右上角那枚语言标签、预览里的语言判定）读成「语言叫 line-numbers」。
 * 留一个空格，它们才知道那是「没有语言」。
 */
function infoText(info: FenceInfo): string {
  const parts: string[] = [];
  if (info.lang) parts.push(info.lang);
  if (info.title) parts.push(info.title);
  if (info.numbered) parts.push("line-numbers");
  if (info.marks.size > 0) parts.push(`{${formatLineSpec(info.marks)}}`);
  parts.push(...info.extra);
  if (parts.length === 0) return "";
  return info.lang ? parts.join(" ") : ` ${parts.join(" ")}`;
}

/* ── 定位围栏块 ── */

/** 光标落在哪个围栏块里。往上找 `FencedCode`，找不到就是不在代码块里 */
function fenceNodeAt(state: EditorState, pos: number) {
  const clamped = Math.max(0, Math.min(pos, state.doc.length));
  const tree = syntaxTree(state);
  const climb = (from: number) => {
    for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(from, -1); node; node = node.parent) {
      if (node.name === "FencedCode") return node;
    }
    return null;
  };
  const left = climb(clamped);
  if (left) return left;
  /* 围栏行首是个边界：`resolveInner(pos, -1)` 在边界上偏向「还没进这个节点」，
     落到上一段的末尾去，于是明明站在 ``` 上却认不出自己在代码块里。
     反方向再找一次——但要确认这个块真的从这儿开始，否则「上一段行尾」
     那种位置会被误判成「下一块的开头」。 */
  const node = tree.resolveInner(clamped, 1);
  for (let p: typeof node | null = node; p; p = p.parent) {
    if (p.name === "FencedCode" && clamped >= p.from && clamped <= p.to) return p;
  }
  return null;
}

/**
 * 这一行是不是收尾围栏。
 *
 * 要求同一个字符、且不短于起始围栏：四个反引号围起来的块里可以合法地
 * 出现一行三个反引号（写 Markdown 教程时的常态），那一行是正文，
 * 不能当成收尾把人家的代码截断。
 */
function isClosingFence(text: string, marker: string): boolean {
  const t = text.trim();
  if (t.length < marker.length) return false;
  for (let i = 0; i < t.length; i += 1) if (t[i] !== marker[0]) return false;
  return true;
}

export function readFence(state: EditorState, node: { from: number; to: number }): FenceBlock | null {
  const doc = state.doc;
  const openLine = doc.lineAt(node.from);
  const m = OPEN_FENCE.exec(openLine.text);
  if (!m) return null;

  const indent = m[1];
  const marker = m[2];
  const infoFrom = openLine.from + indent.length + marker.length;

  const content: Line[] = [];
  for (let n = openLine.number + 1; n <= doc.lines; n += 1) {
    const line = doc.line(n);
    // 围栏没收尾（写到最后一行都还没合上）时 node.to 就是文末
    if (line.from >= node.to) break;
    if (isClosingFence(line.text, marker)) break;
    content.push(line);
  }

  return {
    from: node.from,
    to: node.to,
    openLine,
    indent,
    marker,
    infoFrom,
    infoTo: openLine.to,
    info: parseFenceInfo(doc.sliceString(infoFrom, openLine.to)),
    content,
  };
}

/** 光标在第几条代码行（1 起）；在围栏行上或块外返回 null */
export function fenceLineAt(state: EditorState, pos: number): number | null {
  const node = fenceNodeAt(state, pos);
  if (!node) return null;
  const block = readFence(state, node);
  if (!block) return null;
  const index = state.doc.lineAt(pos).number - block.openLine.number;
  return index >= 1 && index <= block.content.length ? index : null;
}

/** 光标正踩着的那条代码行**当前有没有被标行**。
    工具栏那颗按钮的「亮」靠它：亮 = 这一行已经标了（再点一下是取消），
    不亮 = 还没标。只判断「在不在代码块里」会让按钮一直亮着，
    看不出点下去到底是标还是撤。 */
export function fenceMarkedAt(state: EditorState, pos: number): boolean {
  const node = fenceNodeAt(state, pos);
  if (!node) return false;
  const block = readFence(state, node);
  if (!block) return false;
  const index = state.doc.lineAt(pos).number - block.openLine.number;
  return index >= 1 && index <= block.content.length && block.info.marks.has(index);
}

/** 围栏块里有没有开行号。给右上角那枚 chip 判断自己的状态用 */
export function fenceNumberedAt(state: EditorState, pos: number): boolean {
  const node = fenceNodeAt(state, pos);
  if (!node) return false;
  return readFence(state, node)?.info.numbered ?? false;
}

/* ── 改文档 ── */

/**
 * 只改 info 串那一段，其余一个字不动。
 *
 * 不动选区：用户框住的那几行代码照旧框着，可以接着再点一次取消。
 * CodeMirror 会把选区按位置变化自动映射过去（改动在它们上方）。
 */
function commitInfo(view: EditorView, block: FenceBlock, next: string): boolean {
  const current = view.state.doc.sliceString(block.infoFrom, block.infoTo);
  if (next === current) return false;
  view.dispatch({
    changes: { from: block.infoFrom, to: block.infoTo, insert: next },
    userEvent: "input.lineMarks",
  });
  return true;
}

/**
 * 右上角那枚「行号」chip：开关这一块的行号轨。
 * 与标行无关——标行会顺手开行号，这里可以单独关掉。
 */
export function toggleFenceLineNumbers(view: EditorView, pos: number): void {
  const node = fenceNodeAt(view.state, pos);
  if (!node) return;
  const block = readFence(view.state, node);
  if (!block) return;
  block.info.numbered = !block.info.numbered;
  commitInfo(view, block, infoText(block.info));
}

/* ── 回执文案 ── */

function describeLines(nums: number[]): string {
  const sorted = [...nums].sort((a, b) => a - b);
  if (sorted.length === 1) return `第 ${sorted[0]} 行`;
  const contiguous = sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1);
  if (contiguous) return `第 ${sorted[0]}–${sorted[sorted.length - 1]} 行`;
  if (sorted.length > 3) return `第 ${sorted.slice(0, 3).join("、")} 等 ${sorted.length} 行`;
  return `第 ${sorted.join("、")} 行`;
}

/** 选中/光标覆盖了代码块里的哪几条（1 起）。选区跨出块外也照算落在块内的部分 */
function targetLines(state: EditorState, block: FenceBlock, head: number, from: number, to: number, empty: boolean): number[] {
  if (empty) {
    const index = state.doc.lineAt(head).number - block.openLine.number;
    return index >= 1 && index <= block.content.length ? [index] : [];
  }
  const first = state.doc.lineAt(from).number;
  // 选到行首就结束的那种选法（从第 1 行拖到第 3 行行首）不该算上第 3 行
  const last = state.doc.lineAt(Math.max(from, to - 1)).number;
  const picked: number[] = [];
  block.content.forEach((line, index) => {
    if (line.number >= first && line.number <= last) picked.push(index + 1);
  });
  return picked;
}

/* ── 围栏的创建（不在代码块里时） ── */

/** 选中的内容里最长的一串反引号，围栏要比它长一个，否则提前把块闭合了 */
function longestRun(text: string, ch: string): number {
  let best = 0;
  let run = 0;
  for (const c of text) {
    run = c === ch ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

/** 插一个空壳，光标停在围栏记号之后——直接打 `py` 就成了 ` ```py ` */
function insertShell(view: EditorView, from: number, to: number, body: string, prefix: string) {
  const marker = "`".repeat(Math.max(3, longestRun(body, "`") + 1));
  view.dispatch({
    changes: {
      from,
      to,
      insert: `${prefix}${marker} line-numbers\n${body}\n${marker}\n`,
    },
    selection: { anchor: from + prefix.length + marker.length },
    userEvent: "input.lineMarks",
  });
  view.focus();
}

/** 前后各补一个换行，围栏才会落在独立行上（否则它只是段落中间的一段字） */
function edgeBreak(state: EditorState, from: number, to: number): { lead: string; tail: string } {
  const doc = state.doc;
  const before = from > 0 ? doc.sliceString(from - 1, from) : "\n";
  const after = to < doc.length ? doc.sliceString(to, to + 1) : "\n";
  return { lead: before === "\n" ? "" : "\n", tail: after === "\n" ? "" : "\n" };
}

/* ── 入口 ── */

/**
 * 点一次「标行」。
 *
 * 返回一句回执（给 toast 用），空串表示不用说话。四种情形：
 *   在代码块里、选了几行 → 标上/取消这几行
 *   在代码块里、没选     → 标上/取消光标那一行
 *   选了一段普通文本     → 包成代码块并开行号
 *   空行上、不在代码块里 → 插一个三行的样板块
 */
export function toggleLineMarks(view: EditorView): string {
  const { state } = view;
  const sel = state.selection.main;
  const node = fenceNodeAt(state, sel.head);
  const block = node ? readFence(state, node) : null;

  if (block) {
    const targets = targetLines(state, block, sel.head, sel.from, sel.to, sel.empty);
    if (targets.length === 0) {
      return "选中代码块里的几行，或把光标放到某一行上";
    }
    const wasMarked = targets.every((n) => block.info.marks.has(n));
    for (const n of targets) {
      if (wasMarked) block.info.marks.delete(n);
      else block.info.marks.add(n);
    }
    // 有标行就一定带行号；全撤掉时连行号一起退，块回到点之前的样子
    block.info.numbered = block.info.marks.size > 0;
    commitInfo(view, block, infoText(block.info));
    view.focus();
    const label = describeLines(targets);
    return wasMarked ? `已取消${label}` : `已标${label} · 再点一次取消`;
  }

  /* 不在代码块里。这里做的是「造一个」而不是「标一个」，
     所以回执要说清楚刚才发生的是结构变化，不是上色。 */
  if (!sel.empty) {
    const text = state.doc.sliceString(sel.from, sel.to).replace(/\n$/, "");
    const breaks = edgeBreak(state, sel.from, sel.to);
    insertShell(view, sel.from, sel.to, text, breaks.lead);
    // tail 由 body 末尾那个换行承担，这里只在正文不是整行时补一个
    return "已包成代码块 · 选中其中几行再点一次「标行」就能标出来";
  }

  const line = state.doc.lineAt(sel.head);
  if (line.text.trim() === "") {
    insertShell(
      view,
      line.from,
      line.to,
      ["在这里粘贴或输入代码", "选中其中几行，再点一次「标行」", "标出来的行在预览里有一道边"].join("\n"),
      "",
    );
    return "已插入代码块 · 在围栏后打上语言名（ts、py…）";
  }

  const breaks = edgeBreak(state, line.from, line.to);
  insertShell(view, line.from, line.to, line.text, breaks.lead);
  return "已把这一行包成代码块 · 选中其中几行再点一次「标行」";
}

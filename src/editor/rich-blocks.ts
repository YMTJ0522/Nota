import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import {
  StateEffect,
  StateField,
  type EditorState,
  type Range,
} from "@codemirror/state";

/**
 * 编辑区里的「富块」渲染层。
 *
 * Markdown 里有一类语法光靠加粗/变色表达不出来：
 *   - Callout 提示块   `> [!NOTE]` + 若干 `> ` 行
 *   - 折叠详情块       `<details><summary>标题</summary>…</details>`
 *   - 分栏标签         `:::: tabs` / `::: tab-item 标签` / `:::`
 *   - Mermaid 图表     ```mermaid 代码块
 *
 * 之前的编辑器把它们当普通文本显示——源码摆在那儿，看不出结构。
 * 这一层在块**上方**插一张预览卡（表格/图），或在块首行**打 class**（引用式块），
 * 让写作时一眼能看出这是块特殊内容。
 *
 * ⚠️ 块级 widget（`block: true`）必须由 StateField 提供，写在 ViewPlugin 里会抛
 * `RangeError: Block decorations may not be specified via plugins`。
 * 所以这里和其他富块模块采用同一套结构：
 *   StateField 产出「块级卡片」+ ViewPlugin 产出「行级 class」。
 */

/* ───────────────────────── 块扫描 ───────────────────────── */

type BlockKind = "callout" | "details" | "tabs" | "mermaid" | "table";

interface BlockRange {
  kind: BlockKind;
  /** 整块的起止偏移（含语法标记） */
  from: number;
  to: number;
  /** 块首行（用于挂行级 class / 定位卡片） */
  startLine: number;
  /** 卡片插入点：块末行尾 */
  insertAt: number;
  /** 解析出的元信息 */
  meta: Record<string, string>;
  /** 原始文本，卡片按需自行解析 */
  text: string;
}

const CALLOUT_RE = /^(\s*)>\s*\[!([A-Za-z]+)\]([+-]?)\s*(.*)$/;
const DETAILS_OPEN_RE = /^\s*<details\b[^>]*>\s*$/i;
const DETAILS_CLOSE_RE = /^\s*<\/details>\s*$/i;
/** `:::: tabs` 起，`::::` 止 */
const TABS_OPEN_RE = /^\s*:{4,}\s*tabs\b.*$/i;
const TABS_CLOSE_RE = /^\s*:{4,}\s*$/;
/** `::: tab-item 标签` */
const TAB_ITEM_RE = /^\s*:{3}\s*tab-item\s*(.*)$/i;
const FENCE_RE = /^(\s*)(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/;
/** 表格分隔行：| --- | :---: | */
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

/**
 * 扫描可见范围内所有富块。
 *
 * 只做「块边界识别」，具体内容交给卡片自己解析——
 * 这样新增一种块类型不用动这里。
 */
function scanBlocks(state: EditorState, from: number, to: number): BlockRange[] {
  const out: BlockRange[] = [];
  const doc = state.doc;

  let pos = from;
  let inFence = false;
  let fenceMark = "";
  let fenceLang = "";
  let fenceStart = -1;

  while (pos <= to) {
    const line = doc.lineAt(pos);
    const text = line.text;

    /* ── 代码围栏优先：围栏内部不识别任何其它块 ── */
    const fence = FENCE_RE.exec(text);
    if (fence) {
      const mark = fence[2][0];
      if (!inFence) {
        inFence = true;
        fenceMark = mark;
        fenceLang = (fence[3] || "").toLowerCase();
        fenceStart = line.from;
      } else if (mark === fenceMark) {
        const isMermaid = fenceLang === "mermaid";
        inFence = false;
        if (isMermaid) {
          out.push({
            kind: "mermaid",
            from: fenceStart,
            to: line.to,
            startLine: doc.lineAt(fenceStart).number,
            insertAt: line.to,
            meta: { lang: fenceLang },
            text: doc.sliceString(fenceStart, line.to),
          });
        }
        fenceLang = "";
        fenceStart = -1;
      }
      if (line.to >= to) break;
      pos = line.to + 1;
      continue;
    }
    if (inFence) {
      if (line.to >= to) break;
      pos = line.to + 1;
      continue;
    }

    /* ── Callout：`> [!TYPE] 标题` 起，连续 `>` 行为体 ── */
    const callout = CALLOUT_RE.exec(text);
    if (callout) {
      const start = line.from;
      const type = callout[2].toLowerCase();
      const title = callout[4].trim();
      let last = line;
      let p = line.to + 1;
      while (p <= doc.length) {
        const nl = doc.lineAt(p);
        if (!/^\s*>/.test(nl.text)) break;
        last = nl;
        p = nl.to + 1;
      }
      out.push({
        kind: "callout",
        from: start,
        to: last.to,
        startLine: line.number,
        insertAt: last.to,
        meta: { type, title },
        text: doc.sliceString(start, last.to),
      });
      if (last.to >= to) break;
      pos = last.to + 1;
      continue;
    }

    /* ── 折叠详情块：<details> … </details> ── */
    if (DETAILS_OPEN_RE.test(text)) {
      const start = line.from;
      const summaryM = /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(text);
      let summary = summaryM ? summaryM[1].trim() : "";
      let body = "";
      let last = line;
      let p = line.to + 1;
      let depth = 0;
      while (p <= doc.length) {
        const nl = doc.lineAt(p);
        if (DETAILS_OPEN_RE.test(nl.text)) depth += 1;
        if (DETAILS_CLOSE_RE.test(nl.text)) {
          if (depth === 0) {
            last = nl;
            break;
          }
          depth -= 1;
        }
        // 正文里可能夹着 <summary>（非同一行时）
        const sm = /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(nl.text);
        if (sm && !summary) summary = sm[1].trim();
        else if (!DETAILS_CLOSE_RE.test(nl.text)) {
          body += (body ? "\n" : "") + nl.text;
        }
        last = nl;
        p = nl.to + 1;
      }
      out.push({
        kind: "details",
        from: start,
        to: last.to,
        startLine: line.number,
        insertAt: last.to,
        meta: { summary: summary || "详情" },
        text: body.trim(),
      });
      if (last.to >= to) break;
      pos = last.to + 1;
      continue;
    }

    /* ── 分栏标签：:::: tabs … :::: ── */
    if (TABS_OPEN_RE.test(text)) {
      const start = line.from;
      const tabs: string[] = [];
      let last = line;
      let p = line.to + 1;
      while (p <= doc.length) {
        const nl = doc.lineAt(p);
        const item = TAB_ITEM_RE.exec(nl.text);
        if (item) tabs.push(item[1].trim() || `标签 ${tabs.length + 1}`);
        if (TABS_CLOSE_RE.test(nl.text) && p > line.to) {
          last = nl;
          break;
        }
        last = nl;
        p = nl.to + 1;
      }
      out.push({
        kind: "tabs",
        from: start,
        to: last.to,
        startLine: line.number,
        insertAt: last.to,
        meta: { tabs: tabs.join("\u0000") },
        text: doc.sliceString(start, last.to),
      });
      if (last.to >= to) break;
      pos = last.to + 1;
      continue;
    }

    /* ── 表格：连续 `|` 行，第二行是分隔行 ── */
    if (/^\s*\|/.test(text)) {
      const nextPos = line.to + 1;
      if (nextPos <= doc.length) {
        const nextLine = doc.lineAt(nextPos);
        if (TABLE_SEP_RE.test(nextLine.text)) {
          const start = line.from;
          let last = nextLine;
          let headerCols = splitRow(text);
          let rows = 0;
          let p = nextLine.to + 1;
          while (p <= doc.length) {
            const nl = doc.lineAt(p);
            if (!/^\s*\|/.test(nl.text)) break;
            last = nl;
            rows += 1;
            p = nl.to + 1;
          }
          out.push({
            kind: "table",
            from: start,
            to: last.to,
            startLine: line.number,
            insertAt: last.to,
            meta: { cols: String(headerCols), rows: String(rows) },
            text: doc.sliceString(start, last.to),
          });
          if (last.to >= to) break;
          pos = last.to + 1;
          continue;
        }
      }
    }

    if (line.to >= to) break;
    pos = line.to + 1;
  }

  return out;
}

/** 拆一行表格：去掉首尾竖线后按 `|` 切 */
function splitRow(text: string): number {
  const t = text.trim().replace(/^\|/, "").replace(/\|$/, "");
  return t.split("|").length;
}

/** 表格对齐方式：:`:---` / `:---:` / `---:` */
function parseAlign(sep: string): ("left" | "center" | "right")[] {
  const t = sep.trim().replace(/^\|/, "").replace(/\|$/, "");
  return t.split("|").map((c) => {
    const s = c.trim();
    const l = s.startsWith(":");
    const r = s.endsWith(":");
    if (l && r) return "center";
    if (r) return "right";
    return "left";
  });
}

/* ───────────────────────── 卡片 widget ───────────────────────── */

const CALLOUT_META: Record<string, { label: string; icon: string }> = {
  note: { label: "提示", icon: "ℹ" },
  tip: { label: "技巧", icon: "✦" },
  info: { label: "说明", icon: "ℹ" },
  warning: { label: "警告", icon: "⚠" },
  caution: { label: "注意", icon: "⚠" },
  danger: { label: "危险", icon: "⛔" },
  success: { label: "成功", icon: "✓" },
  important: { label: "重要", icon: "❕" },
  question: { label: "疑问", icon: "?" },
  example: { label: "示例", icon: "❯" },
  quote: { label: "引用", icon: "❝" },
};

class RichBlockWidget extends WidgetType {
  constructor(readonly block: BlockRange) {
    super();
  }

  eq(other: RichBlockWidget) {
    // 同一个块、内容没变就不用重建 DOM
    return (
      other.block.kind === this.block.kind &&
      other.block.text === this.block.text &&
      other.block.from === this.block.from
    );
  }

  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = `cm-rich cm-rich-${this.block.kind}`;

    switch (this.block.kind) {
      case "mermaid":
        this.renderMermaid(wrap);
        break;
      case "table":
        this.renderTable(wrap);
        break;
      case "callout":
        this.renderCallout(wrap);
        break;
      case "details":
        this.renderDetails(wrap);
        break;
      case "tabs":
        this.renderTabs(wrap);
        break;
    }
    return wrap;
  }

  /** Mermaid：先放占位，等渲染器就绪再换成 SVG */
  private renderMermaid(wrap: HTMLElement) {
    const code = this.block.text
      .split("\n")
      .slice(1, -1)
      .join("\n")
      .trim();
    const head = document.createElement("div");
    head.className = "cm-rich-head";
    head.innerHTML = `<span class="cm-rich-badge">Mermaid</span><span class="cm-rich-hint">图表预览</span>`;
    wrap.appendChild(head);

    // ⚠️ 内层别再叫 cm-rich-mermaid：外层 wrap 已经带了这个「块类型」class，
    // 两层同名会让 .cm-rich-mermaid 的 flex / white-space 样式套到外层容器上，
    // 整块布局被撑歪，而且按 class 数块数时会一个数成两个。
    const box = document.createElement("div");
    box.className = "cm-rich-body cm-rich-graph";
    box.textContent = code;
    wrap.appendChild(box);

    renderMermaidInto(box, code).catch(() => {
      /* 渲染失败就保留源码，不报错 */
    });
  }

  private renderTable(wrap: HTMLElement) {
    const lines = this.block.text.split("\n");
    const head = splitCells(lines[0]);
    const aligns = lines[1] ? parseAlign(lines[1]) : [];
    const rows = lines.slice(2).map(splitCells);

    // 同上：内层表格用 cm-rich-grid，避免和外层 wrap 的 cm-rich-table 撞名
    const table = document.createElement("table");
    table.className = "cm-rich-grid";

    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    for (let c = 0; c < head.length; c += 1) {
      const th = document.createElement("th");
      th.textContent = head[c];
      if (aligns[c]) th.style.textAlign = aligns[c];
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const r of rows) {
      const tr = document.createElement("tr");
      for (let c = 0; c < head.length; c += 1) {
        const td = document.createElement("td");
        td.textContent = r[c] ?? "";
        if (aligns[c]) td.style.textAlign = aligns[c];
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  private renderCallout(wrap: HTMLElement) {
    const type = this.block.meta.type || "note";
    const meta = CALLOUT_META[type] ?? { label: type, icon: "ℹ" };
    wrap.dataset.type = type;

    const head = document.createElement("div");
    head.className = "cm-rich-head";
    const icon = document.createElement("span");
    icon.className = "cm-rich-icon";
    icon.textContent = meta.icon;
    const title = document.createElement("span");
    title.className = "cm-rich-title";
    title.textContent = this.block.meta.title || meta.label;
    head.append(icon, title);
    wrap.appendChild(head);

    const body = document.createElement("div");
    body.className = "cm-rich-body";
    body.innerHTML = simpleMd(
      this.block.text
        .split("\n")
        .map((l) => l.replace(/^\s*>\s?/, ""))
        .filter((l, i) => !(i === 0 && CALLOUT_RE.test(l)))
        .join("\n")
        .trim(),
    );
    wrap.appendChild(body);
  }

  private renderDetails(wrap: HTMLElement) {
    const head = document.createElement("div");
    head.className = "cm-rich-head";
    head.innerHTML = `<span class="cm-rich-icon">▸</span>`;
    const title = document.createElement("span");
    title.className = "cm-rich-title";
    title.textContent = this.block.meta.summary || "详情";
    head.appendChild(title);
    const tag = document.createElement("span");
    tag.className = "cm-rich-badge";
    tag.textContent = "已折叠";
    head.appendChild(tag);
    wrap.appendChild(head);

    const body = document.createElement("div");
    body.className = "cm-rich-body cm-rich-collapsed";
    body.innerHTML = simpleMd(this.block.text);
    wrap.appendChild(body);
  }

  private renderTabs(wrap: HTMLElement) {
    const labels = (this.block.meta.tabs || "").split("\u0000").filter(Boolean);
    // 同上：标签条用 cm-rich-tabbar，避免和外层 wrap 的 cm-rich-tabs 撞名
    const bar = document.createElement("div");
    bar.className = "cm-rich-tabbar";
    labels.forEach((l, i) => {
      const b = document.createElement("span");
      b.className = "cm-rich-tab" + (i === 0 ? " on" : "");
      b.textContent = l;
      bar.appendChild(b);
    });
    wrap.appendChild(bar);
  }

  /** 块级卡片不吃事件：点它仍然落到编辑器，光标能正常移动 */
  ignoreEvent() {
    return false;
  }
}

function splitCells(text: string): string[] {
  return text
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** 极简行内 Markdown → HTML（卡片正文用，够用即可） */
function simpleMd(src: string): string {
  return src
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`([^`]+)`/g, '<code class="cm-rich-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\n/g, "<br>");
}

/* ───────────────────────── Mermaid 渲染 ───────────────────────── */

let mermaidMod: { render: Function; initialize: Function } | null = null;
const mermaidCache = new Map<string, string>();

/**
 * 懒加载 mermaid 并把源码渲染成 SVG。
 *
 * 渲染是异步且可能抛错的，失败时静默回退到源码文本——
 * 写错一行图表语法不该让编辑器崩掉。
 */
async function renderMermaidInto(box: HTMLElement, code: string) {
  if (!code) return;
  const cached = mermaidCache.get(code);
  if (cached) {
    box.innerHTML = cached;
    box.classList.add("is-rendered");
    return;
  }
  try {
    if (!mermaidMod) {
      const mod = (await import("mermaid")) as unknown as {
        default: { initialize: Function; render: Function };
      };
      mermaidMod = mod.default;
      mermaidMod.initialize({ startOnLoad: false, securityLevel: "strict" });
    }
    const id = "cm-mmd-" + Math.random().toString(36).slice(2);
    const { svg } = (await mermaidMod!.render(id, code)) as { svg: string };
    mermaidCache.set(code, svg);
    if (!box.isConnected) return;
    box.innerHTML = svg;
    box.classList.add("is-rendered");
  } catch {
    box.classList.add("is-error");
  }
}

/* ───────────────────────── 装饰装配 ───────────────────────── */

/** 行级 class：给块首行加标记，让 CSS 能做出「块从哪里开始」的暗示 */
const LINE_CLASS: Record<BlockKind, string> = {
  callout: "cm-rich-line-callout",
  details: "cm-rich-line-details",
  tabs: "cm-rich-line-tabs",
  mermaid: "cm-rich-line-mermaid",
  table: "cm-rich-line-table",
};

/**
 * 给将来「异步数据就绪」留的唤醒信号。
 *
 * 目前没有触发源：mermaid 渲染完是直接写 DOM 的，不需要重建装饰。
 * 真要用的话必须从 `update()` 之外 dispatch（异步回调 / rAF），
 * 在 update 里同步 dispatch 会让插件崩溃。
 */
const richRefresh = StateEffect.define<void>();

function buildBlocks(state: EditorState, from: number, to: number): Range<Decoration>[] {
  const ranges: Range<Decoration>[] = [];
  for (const b of scanBlocks(state, from, to)) {
    const line = state.doc.line(b.startLine);
    ranges.push(
      Decoration.line({ class: LINE_CLASS[b.kind] }).range(line.from),
    );
    // 卡片插在块末行的下一行行首，block: true 让它独占一整行高度
    const at = Math.min(b.insertAt, state.doc.length);
    ranges.push(
      Decoration.widget({
        widget: new RichBlockWidget(b),
        block: true,
        side: 1,
      }).range(at),
    );
  }
  return ranges;
}

const richBlockField = StateField.define<DecorationSet>({
  create: (state) => Decoration.set(buildBlocks(state, 0, state.doc.length), true),
  update: (decos, tr) => {
    if (tr.docChanged || tr.effects.some((e) => e.is(richRefresh))) {
      return Decoration.set(
        buildBlocks(tr.state, 0, tr.state.doc.length),
        true,
      );
    }
    return decos.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * ⚠️ 这里**刻意没有**「视口变化时重扫」的 ViewPlugin。
 *
 * 两个原因：
 *  1. `richBlockField` 扫的是整篇文档（0..doc.length），产出的 DecorationSet 是全量的。
 *     CodeMirror 自己只把视口内的那部分渲染成 DOM —— 滚动时不需要我们重算。
 *  2. 曾经在这里写过 `update() { view.dispatch(...) }`，直接踩了
 *     "Calls to EditorView.update are not allowed while an update is in progress"，
 *     插件崩溃后装饰没被清干净，同一个块会在页面上重复出现。
 *     在 `update()` 里同步 dispatch 是 CodeMirror 明令禁止的。
 *
 * 真要重扫（比如将来加了异步数据），也必须从 `update()` 之外触发：
 * requestAnimationFrame / 异步回调里 dispatch `richRefresh`。
 */
export const markdownRichBlocks = [richBlockField];

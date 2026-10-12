import { syntaxTree } from "@codemirror/language";
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import { StateField, type EditorState, type Range } from "@codemirror/state";
import { fencedCodeLanguages } from "./code-languages";

/**
 * 代码块右上角那枚「语言」小标签。
 *
 * 之前是打完 ``` 就在光标处弹一张语言补全列表——它和行号、围栏标记挤在同一行，
 * 上下键还会被它抢走，写起来很乱。现在换成：围栏自己不带任何弹层，
 * 代码块画完之后右上角常驻一枚安静的小标签，点它才展开一份下拉。
 *
 * 三个刻意的决定：
 *  1. 标签是**块级 widget**（零高度 + 绝对定位)，不占文档流，也不会被光标撞到，
 *     所以它不影响撤销、查找、行号对齐这些依赖纯源码的东西；
 *  2. 平时 45% 不透明度，鼠标移上去才实心——默认安静，不抢正文注意力；
 *  3. 菜单用全应用那一套 .n-menu（挂到 body，position: fixed），
 *     长相和顶栏导出、工具栏下拉一致，不需要再维护第二套样式。
 */

/**
 * 下拉里的候选。
 *
 * 写进围栏的是语言的**正式名**（`python`、`javascript`、`shell`），不是别名里的
 * 第一个——别名的第一项往往是缩写（`py`、`js`），写出去别的渲染器不一定认，
 * 用户回头看源码也得多想一步。拿不准就用全名，这是最不容易出错的一种表示。
 */
const LANG_OPTIONS: { label: string; token: string }[] = fencedCodeLanguages.map((l) => ({
  label: l.name,
  token: l.name.toLowerCase(),
}));

let openMenu: HTMLElement | null = null;

function onDocDown(event: MouseEvent) {
  const target = event.target as Node | null;
  if (openMenu && target && !openMenu.contains(target)) closeLangMenu();
}

function onDocKey(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  event.stopPropagation();
  closeLangMenu();
}

function closeLangMenu() {
  if (!openMenu) return;
  openMenu.remove();
  openMenu = null;
  document.removeEventListener("mousedown", onDocDown, true);
  document.removeEventListener("keydown", onDocKey, true);
  window.removeEventListener("resize", closeLangMenu);
  window.removeEventListener("scroll", closeLangMenu, true);
}

/** 围栏行上的语言 token。pos 给的是那一行的行首偏移 */
function fenceLangAt(view: EditorView, pos: number) {
  const clamped = Math.max(0, Math.min(pos, view.state.doc.length));
  const line = view.state.doc.lineAt(clamped);
  const m = /^[ \t]*(`{3,}|~{3,})([^\s`]*)/.exec(line.text);
  return m ? { line, fence: m[1], token: m[2] ?? "" } : null;
}

/** 把语言写回围栏行。整行只有语言那一段被动，正文与缩进原样保留 */
function applyLang(view: EditorView, pos: number, token: string) {
  const hit = fenceLangAt(view, pos);
  if (!hit) return;
  const from = hit.line.from + hit.line.text.indexOf(hit.fence) + hit.fence.length;
  const to = from + hit.token.length;
  view.dispatch({
    changes: { from, to, insert: token },
    userEvent: "input.lang",
  });
  view.focus();
}

function menuRow(label: string, tail: string, active: boolean, onPick: () => void) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = `n-menu-item${active ? " on" : ""}`;
  const name = document.createElement("span");
  name.className = "n-menu-name";
  name.textContent = label;
  const end = document.createElement("span");
  end.className = "n-menu-tail";
  end.textContent = tail;
  row.append(name, end);
  row.addEventListener("click", onPick);
  return row;
}

function openLangMenu(view: EditorView, anchor: HTMLElement, pos: number) {
  closeLangMenu();
  const current = fenceLangAt(view, pos)?.token ?? "";

  const menu = document.createElement("div");
  menu.className = "n-menu";

  const head = document.createElement("div");
  head.className = "n-menu-head";
  head.textContent = "代码语言";

  const list = document.createElement("div");
  list.className = "cm-lang-list";
  // 第一项是「纯文本」：把语言去掉，代码块退回无高亮。
  // 放在最上面是因为它最常见——多数代码块本来就没指定语言。
  list.append(
    menuRow("纯文本", "无高亮", current === "", () => {
      applyLang(view, pos, "");
      closeLangMenu();
    }),
  );
  for (const opt of LANG_OPTIONS) {
    list.append(
      menuRow(opt.label, opt.token, current === opt.token, () => {
        applyLang(view, pos, opt.token);
        closeLangMenu();
      }),
    );
  }
  menu.append(head, list);
  document.body.append(menu);

  // 摆位：贴着标签右下角往下开，装不下就往上翻
  const r = anchor.getBoundingClientRect();
  const mh = menu.offsetHeight;
  const mw = menu.offsetWidth;
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 10) top = Math.max(10, r.top - mh - 6);
  const left = Math.max(10, Math.min(r.right - mw, window.innerWidth - mw - 10));
  menu.style.top = `${Math.round(top)}px`;
  menu.style.left = `${Math.round(left)}px`;

  openMenu = menu;
  document.addEventListener("mousedown", onDocDown, true);
  document.addEventListener("keydown", onDocKey, true);
  window.addEventListener("resize", closeLangMenu);
  window.addEventListener("scroll", closeLangMenu, true);
}

const CARET =
  '<svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

class CodeLangChip extends WidgetType {
  constructor(
    readonly pos: number,
    readonly lang: string,
  ) {
    super();
  }

  eq(other: CodeLangChip) {
    return other.pos === this.pos && other.lang === this.lang;
  }

  /** 让 CodeMirror 别把标签里的点击当成编辑器事件（否则会挪走光标） */
  ignoreEvent() {
    return true;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-code-lang";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-code-lang-btn";
    btn.title = "选择代码语言";
    btn.setAttribute("aria-label", "选择代码语言");
    btn.innerHTML = `<span></span>${CARET}`;
    const label = btn.firstElementChild as HTMLElement;
    label.textContent = this.lang || "语言";
    if (this.lang) btn.classList.add("has-lang");

    // mousedown 拦掉：不让这一次按下参与选区计算
    btn.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (openMenu) {
        closeLangMenu();
        return;
      }
      openLangMenu(view, btn, this.pos);
    });

    wrap.append(btn);
    return wrap;
  }
}

/**
 * 逐个围栏收集标签。
 *
 * 这里走的是 **StateField 而不是 ViewPlugin**：CodeMirror 不允许
 * `ViewPlugin.decorations` 里出现块级装饰（会直接抛
 * `RangeError: Block decorations may not be specified via plugins`），
 * 而那种装饰恰恰是不占文档流、能把标签浮到行外的唯一办法。
 * StateField 经由 `EditorView.decorations` facet 提供就没有这个限制。
 */
function buildCodeLangChips(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const seen = new Set<number>();
  const { doc } = state;

  syntaxTree(state).iterate({
    from: 0,
    to: doc.length,
    enter(node) {
      // 只认围栏块：缩进式代码块没有语言可写。
      // 注意这里不能返回 false —— iterate 的第一个节点就是 Document，
      // 返回 false 等于整棵树都不下钻，一个围栏也扫不到。
      if (node.name !== "FencedCode") return;
      const line = doc.lineAt(node.from);
      if (seen.has(line.number)) return;
      seen.add(line.number);
      const token = /^[ \t]*(?:`{3,}|~{3,})([^\s`]*)/.exec(line.text)?.[1] ?? "";
      ranges.push(
        Decoration.widget({
          widget: new CodeLangChip(line.from, token),
          block: true,
          side: -1,
        }).range(line.from),
      );
    },
  });

  return Decoration.set(ranges, true);
}

/**
 * 语言标签的总入口。
 *
 * doc 没变就直接把旧集合 map 过去（位置自动跟着挪），
 * 只有正文真的变了才重扫一遍——省掉每次敲键的一次全树遍历。
 */
const codeLangChipField = StateField.define<DecorationSet>({
  create: (state) => buildCodeLangChips(state),
  update: (deco, tr) => (tr.docChanged ? buildCodeLangChips(tr.state) : deco.map(tr.changes)),
  provide: (field) => EditorView.decorations.from(field),
});

export function codeLangChipExtensions() {
  return [codeLangChipField];
}

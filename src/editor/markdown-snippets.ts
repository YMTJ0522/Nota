/**
 * Toolbar markdown snippets shared by toolbar-commands.ts. Kept separate
 * from markdown-commands.ts (state transforms) so both files stay small.
 */

/**
 * 3-column table template; the header row is i18n text supplied by the
 * caller (toolbarTable). This default matches the English catalog.
 */
export const TABLE_SNIPPET = "| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n|  |  |  |";
export const TABLE_CURSOR_OFFSET = 2;

/** Empty math block; cursor lands between the $$ fences. */
export const MATH_BLOCK_SNIPPET = "$$\n\n$$\n";
export const MATH_BLOCK_CURSOR_OFFSET = 3;

/** Mermaid diagram fallback content for the wrapped block insert. */
export const MERMAID_FALLBACK = "flowchart LR\n  A --> B";

/** Horizontal rule block; cursor lands after the blank line. */
export const HORIZONTAL_RULE_SNIPPET = "---\n\n";
export const HORIZONTAL_RULE_CURSOR_OFFSET = 5;

/** Details block (space syntax); cursor lands between the brackets. */
export const DETAILS_OPEN = "::: details []";
export const DETAILS_CLOSE = ":::";

/** Advanced code fence info string: language + title + line numbers + highlight. */
export const ADVANCED_CODE_INFO = 'text title="" line-numbers {1}'

/* ── 图表模板 ──
   全部走 Mermaid：预览里由 preview-rich.ts 动态拉起 mermaid 渲染成 SVG。
   之所以做成「模板」而不是一个空的 ```mermaid 壳子：空壳得先去背
   Mermaid 语法才写得出来，等于这个功能对用户不存在。

   每一条都按 mermaid 11 的语法写，并且刻意避开中文标识符/带空格的标签——
   解析器对这两样很挑剔，写成模板却在预览里报红是最糟的体验。
   想写中文只需要在插出来之后自己改字，那时语法骨架已经是对的。 */
export interface ChartTemplate {
  /** 下拉里的名字 */
  label: string
  /** 一句话说明，显示在菜单右侧 */
  hint: string
  /** 插进文档的代码（不含 ```mermaid 围栏） */
  code: string
}

export const CHART_TEMPLATES: ChartTemplate[] = [
  {
    label: '折线图',
    hint: '趋势',
    code: [
      'xychart-beta',
      '  title "月度趋势"',
      '  x-axis ["1月", "2月", "3月", "4月", "5月"]',
      '  y-axis "数量" 0 --> 100',
      '  line [28, 46, 39, 72, 88]',
    ].join('\n'),
  },
  {
    label: '柱状图',
    hint: '对比',
    code: [
      'xychart-beta',
      '  title "各月销量"',
      '  x-axis ["1月", "2月", "3月", "4月"]',
      '  y-axis "销量" 0 --> 120',
      '  bar [45, 78, 52, 96]',
    ].join('\n'),
  },
  {
    label: '饼图',
    hint: '占比',
    code: ['pie showData', '  title 时间分配', '  "写作" : 40', '  "阅读" : 30', '  "整理" : 30'].join(
      '\n',
    ),
  },
  {
    label: '流程图',
    hint: '步骤',
    code: [
      'flowchart LR',
      '  A[开始] --> B{条件判断}',
      '  B -- 是 --> C[执行]',
      '  B -- 否 --> D[跳过]',
      '  C --> E[结束]',
      '  D --> E',
    ].join('\n'),
  },
  {
    label: '时序图',
    hint: '交互',
    code: [
      'sequenceDiagram',
      '  participant U as 用户',
      '  participant A as 应用',
      '  U->>A: 打开笔记',
      '  A-->>U: 返回内容',
      '  U->>A: 保存修改',
      '  A-->>U: 已保存',
    ].join('\n'),
  },
  {
    label: '类图',
    hint: '结构',
    code: [
      'classDiagram',
      '  class Note {',
      '    +String title',
      '    +String body',
      '    +save()',
      '  }',
      '  class Folder {',
      '    +List~Note~ notes',
      '  }',
      '  Folder "1" --> "*" Note',
    ].join('\n'),
  },
  {
    label: '状态图',
    hint: '流转',
    code: [
      'stateDiagram-v2',
      '  [*] --> Draft',
      '  Draft --> Review : 提交',
      '  Review --> Draft : 打回',
      '  Review --> [*] : 通过',
    ].join('\n'),
  },
  {
    label: '甘特图',
    hint: '排期',
    code: [
      'gantt',
      '  title 项目排期',
      '  dateFormat YYYY-MM-DD',
      '  section 设计',
      '  原型   :a1, 2026-01-01, 7d',
      '  评审   :a2, after a1, 2d',
      '  section 开发',
      '  编码   :a3, after a2, 14d',
      '  联调   :a4, after a3, 5d',
    ].join('\n'),
  },
  {
    label: '思维导图',
    hint: '发散',
    code: [
      'mindmap',
      '  root((笔记))',
      '    写作',
      '      大纲',
      '      草稿',
      '    整理',
      '      标签',
      '      收藏',
      '    回顾',
      '      历史版本',
    ].join('\n'),
  },
  {
    label: '实体关系图',
    hint: '数据',
    code: [
      'erDiagram',
      '  NOTE ||--o{ TAG : has',
      '  NOTE {',
      '    string title',
      '    string body',
      '  }',
      '  TAG {',
      '    string name',
      '  }',
    ].join('\n'),
  },
  {
    label: 'Git 提交图',
    hint: '分支',
    code: [
      'gitGraph',
      '  commit id: "init"',
      '  branch feature',
      '  checkout feature',
      '  commit id: "feat"',
      '  checkout main',
      '  merge feature',
    ].join('\n'),
  },
]

/* ── 提示块（Callout）类型 ──
   预览里的配色由 markdown.css 按 data-type 决定，这里的 color 只给
   工具栏下拉画那颗小色点，两边用的是同一组语义色变量，改一处即可。 */
export interface CalloutType {
  /** 写进 `> [!XXX]` 的关键字 */
  key: string
  /** 下拉里显示的名字 */
  label: string
  /** 色点的颜色（CSS 变量引用） */
  color: string
}

export const CALLOUT_TYPES: CalloutType[] = [
  { key: 'NOTE', label: '提示', color: 'var(--n-info)' },
  { key: 'TIP', label: '技巧', color: 'var(--n-ok)' },
  { key: 'IMPORTANT', label: '重要', color: 'var(--n-violet)' },
  { key: 'WARNING', label: '警告', color: 'var(--n-warn)' },
  { key: 'CAUTION', label: '注意', color: 'var(--n-warn)' },
  { key: 'DANGER', label: '危险', color: 'var(--n-danger)' },
  { key: 'SUCCESS', label: '成功', color: 'var(--n-ok)' },
  { key: 'QUESTION', label: '疑问', color: 'var(--n-violet)' },
  { key: 'EXAMPLE', label: '示例', color: 'var(--n-ok)' },
  { key: 'QUOTE', label: '引用', color: 'var(--n-fg-dim)' },
  { key: 'INFO', label: '说明', color: 'var(--n-info)' },
];

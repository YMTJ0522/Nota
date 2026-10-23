/**
 * 验证用的「假工作区 + 假 IPC」。
 *
 * 前面每一轮回归脚本都在自己文件里手写一份 `window.api` 和 `window.__tree`，
 * 加到 2.1 这一轮已经有六份几乎一样的东西——加一个接口要改六处，漏一处就是
 * 一份脚本静默少测一个功能。抽到这里，`makeInject()` 出字符串，直接丢给
 * `Runtime.evaluate` 即可。
 *
 * 假的点（都是故意的）：
 *  - `readNote` 慢 30ms：真实 IPC 是异步的，「还没读到盘就把界面换掉」这类竞态
 *    只有慢下来才会暴露。
 *  - 所有写操作都改内存里的 `__notes` / `__tree`，脚本可以据此断言「界面做完之后
 *    数据真的变了」。
 */

/** 一份够全的目录树：根下几篇 + 两个文件夹 + 一篇被收藏的 */
export function makeTree(now = Date.now()) {
  const file = (name, dir = '', extra = {}) => ({
    type: 'file',
    name,
    path: `${dir ? `/ws/${dir}` : '/ws'}/${name}`,
    tags: [],
    starred: false,
    mtime: now,
    excerpt: '',
    ...extra,
  })
  return [
    file('甲笔记.md', '', { tags: ['示例'], mtime: now - 900_000 }),
    file('乙笔记.md', '', { mtime: now - 600_000 }),
    file('代码示例.md', '', { tags: ['示例', '代码'], mtime: now - 300_000 }),
    file('一周手记.md', '', { starred: true, tags: ['随手记'], mtime: now - 100_000 }),
    {
      type: 'dir',
      name: '新建文件夹',
      path: '/ws/新建文件夹',
      children: [file('空的.md', '新建文件夹', { mtime: now - 50_000 })],
    },
    {
      type: 'dir',
      name: '读书',
      path: '/ws/读书',
      children: [file('书评.md', '读书', { tags: ['读书'], mtime: now - 20_000 })],
    },
  ]
}

export const NOTE_PLAIN = '# 甲笔记\n\n这是甲的内容。\n'
export const NOTE_OTHER = '# 乙笔记\n\n这是乙的内容。\n'
export const NOTE_WEEK = '# 一周手记\n\n## 周一\n\n起了个大早。\n'
export const NOTE_CODE = [
  '# 代码示例',
  '',
  '```python',
  'def hello(name):',
  '    print(f"hi {name}")',
  '```',
  '',
  '后面还有一段正文，用来把代码块推到不是唯一内容的位置。',
  '',
  '```javascript',
  'console.log(1)',
  '```',
].join('\n')
export const NOTE_BOOK = '# 书评\n\n读书笔记。\n'
export const NOTE_IMPORTED = '# 导入进来的\n\n外面收进来的一篇。\n'

/** 每节塞几段废话，把文档撑到真的能滚 —— 大纲跳转的断言需要页面有滚动空间 */
const pad = (tag) =>
  [
    `这是「${tag}」一节的第一段。多写几行，好让这一节自己就比一屏还高，`,
    '这样跳过去的时候才滚得动，动画也才看得出来。',
    '',
    `第二段接着说「${tag}」。段落之间空一行，预览才会渲染成两个 p。`,
    '这里再凑一句长度差不多的句子，保持版面均匀。',
    '',
    `第三段收尾，讲完「${tag}」这件事。`,
  ].join('\n')

/**
 * 大纲跳转专用的结构样本。
 *
 * 里面**故意**埋了两种「源码里看不出来」的标题：
 *   - setext：`还有 setext 标题` 下面跟一行 `====`，只有渲染后才知道它是 h1；
 *   - 引用块里的 `#`：源码那行以 `>` 开头，正则抓不到，预览里却真的会出 h1。
 * 两侧认到的标题集合因此天然对不齐。2.2.2 之前两边都按「第几个」编号
 * （h-0 / h-1 …），差一个就整体错位，表现就是「点第三项跳到第四项」。
 * 这份样本就是拿这两个坑当靶子的。
 */
export const NOTE_STRUCT = [
  '---',
  'tags: []',
  '---',
  '',
  '# 总览',
  '',
  pad('总览'),
  '',
  '## 安装',
  '',
  pad('安装'),
  '',
  '### 依赖',
  '',
  pad('依赖'),
  '',
  '## 配置',
  '',
  pad('配置'),
  '',
  '> # 被引用的标题',
  '>',
  '> 引用块里的标题只存在于渲染后的 HTML 里。',
  '',
  '## 常见问题',
  '',
  pad('常见问题'),
  '',
  '还有 setext 标题',
  '================',
  '',
  pad('尾注'),
].join('\n')

export function makeNotes() {
  return {
    '/ws/甲笔记.md': NOTE_PLAIN,
    '/ws/乙笔记.md': NOTE_OTHER,
    '/ws/一周手记.md': NOTE_WEEK,
    '/ws/代码示例.md': NOTE_CODE,
    '/ws/新建文件夹/空的.md': '',
    '/ws/读书/书评.md': NOTE_BOOK,
  }
}

/**
 * 生成注入脚本。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.maximized] 窗口控制那三颗要不要按「已最大化」渲染
 * @param {string}  [opts.workspace] 工作区根，默认 /ws
 * @param {object}  [opts.notes]     覆盖默认笔记内容
 * @param {Array}   [opts.tree]      覆盖默认目录树
 */
export function makeInject(opts = {}) {
  const notes = opts.notes ?? makeNotes()
  const tree = opts.tree ?? makeTree()
  const ws = opts.workspace ?? '/ws'

  return (
    '(() => {' +
    ` window.__notes = ${JSON.stringify(notes)};` +
    ` window.__tree = ${JSON.stringify(tree)};` +
    ` window.__IMPORTED = ${JSON.stringify(NOTE_IMPORTED)};` +
    ` window.__WS = ${JSON.stringify(ws)};` +
    ' window.__wait = (ms) => new Promise(r => setTimeout(r, ms));' +
    ' window.__hist = {};' + // file -> [{name,path,size,mtime,content}]
    ' window.__attach = [' +
    '  { rel: "attachments/封面.png", name: "封面.png", size: 204800, mtime: Date.now()-86400000, isVideo: false },' +
    '  { rel: "attachments/演示.mp4", name: "演示.mp4", size: 5242880, mtime: Date.now()-2*86400000, isVideo: true },' +
    '  { rel: "attachments/资料包.zip", name: "资料包.zip", size: 1048576, mtime: Date.now()-3*86400000, isVideo: false },' +
    ' ];' +
    ' window.__trash = [' +
    '  { key: "tr-1", rel: "一周手记.md", name: "一周手记.md", deletedAt: Date.now()-86400000, size: 2048 },' +
    '  { key: "tr-2", rel: "读书/书评.md", name: "书评.md", deletedAt: Date.now()-2*86400000, size: 512 },' +
    ' ];' +
    ' window.__imported = [];' +
    ' window.api = {' +
    `  pickWorkspace: async () => ${JSON.stringify(ws)},` +
    /* 首次启动建库。默认返回空 —— 老脚本都在页面加载后才注入，那时
       bootFirstRun 早就因为找不到这个接口安静退出了，行为跟以前一致；
       要测「第一屏就落在欢迎文档上」的，给 vault 传一个回执并前置注入。
       外面这对括号不能省：箭头函数直接写 {...} 会被当成函数体解析，整段注入脚本语法错误。 */
    `  ensureVault: async () => (${JSON.stringify(opts.vault ?? { root: null, file: null, created: false })}),` +
    /* readTree 必须**现算** tags，不能原样返回上面那份静态树：
       真主进程是从 .md 文件里解析 frontmatter 的，所以「写完一篇 → 刷新目录树」
       这一步必然会让新标签出现在侧栏。桩子要是返回一个固定对象，
       凡是依赖「写盘 → 树上重新出现」的断言都只能在假象里通过。 */
    '  readTree: async () => {' +
    '    function tagsOf(doc) {' +
    '      var m = /^---\\r?\\n([\\s\\S]*?)\\r?\\n---/.exec(String(doc || ""));' +
    '      if (!m) return [];' +
    '      var inline = /^(?:tags|tag)[ \\t]*:[ \\t]*\\[(.*)\\]$/m.exec(m[1]);' +
    '      if (inline) return inline[1].split(",").map(function (s) { return s.trim().replace(/^["\x27]|["\x27]$/g, "") }).filter(Boolean);' +
    '      var out = [], lines = m[1].split("\\n"), at = lines.findIndex(function (l) { return /^(?:tags|tag)[ \\t]*:/.test(l) });' +
    '      if (at < 0) return out;' +
    '      for (var i = at + 1; i < lines.length; i++) {' +
    '        var hit = /^[ \\t]*-[ \\t]+(.*)$/.exec(lines[i] || "");' +
    '        if (!hit) break;' +
    '        out.push(hit[1].trim());' +
    '      }' +
    '      return out;' +
    '    }' +
    '    function walk(nodes) {' +
    '      return nodes.map(function (n) {' +
    '        if (n.type === "dir") return Object.assign({}, n, { children: walk(n.children || []) });' +
    '        var t = tagsOf(window.__notes[n.path]);' +
    '        return Object.assign({}, n, { tags: t.length ? t : (n.tags || []) });' +
    '      });' +
    '    }' +
    '    return walk(window.__tree || []);' +
    '  },' +
    '  readNote: async (f) => { await window.__wait(30); return window.__notes[f] ?? "" },' +
    '  writeNote: async (f, c) => { window.__notes[f] = c; return true },' +
    '  createNote: async (d, n) => {' +
    '    let p = d + "/" + n + ".md", i = 1;' +
    '    while (window.__notes[p] !== undefined) { p = d + "/" + n + " " + i + ".md"; i++ }' +
    '    window.__notes[p] = "";' +
    /* 注意：整段注入脚本是拼成**一行**的字符串，里面绝不能出现 // 注释，
       一出现就把这一行剩下的内容全吃掉（上次就是这么炸的）。 */
    '    window.__tree = JSON.parse(JSON.stringify(window.__tree));' +
    '    const find = (ns) => { for (const x of ns) { if (x.path === d) return x; if (x.children) { const hit = find(x.children); if (hit) return hit } } return null };' +
    '    const parent = find(window.__tree);' +
    '    const node = { type: "file", name: p.split("/").pop(), path: p, tags: [], starred: false, mtime: Date.now(), excerpt: "" };' +
    '    if (parent) parent.children = (parent.children || []).concat([node]); else window.__tree.push(node);' +
    '    return p },' +
    '  createFolder: async (p, n) => { let q = p + "/" + n, i = 1; while (JSON.stringify(window.__tree).includes(JSON.stringify(q))) { q = p + "/" + n + " " + i; i++ } window.__tree.push({ type: "dir", name: n, path: q, children: [] }); return q },' +
    '  deleteNote: async (f) => { window.__deleted = (window.__deleted || []).concat(f);' +
    '    window.__tree = JSON.parse(JSON.stringify(window.__tree));' +
    '    const rm = (ns) => { for (let i = ns.length - 1; i >= 0; i -= 1) { const n = ns[i]; if (n.path === f) ns.splice(i, 1); else if (n.children) rm(n.children) } };' +
    '    rm(window.__tree); return true },' +
    '  renameNote: async (f, n) => f,' +
    '  moveNote: async (f, d, n) => { const p = d + "/" + (n ?? f.split("/").pop()); return p },' +
    '  revealNote: async () => { window.__revealed = true },' +
    '  importNotes: async (root, dir) => {' +
    '    const p = (dir || root) + "/导入进来的.md";' +
    '    window.__notes[p] = window.__IMPORTED;' +
    '    window.__tree = JSON.parse(JSON.stringify(window.__tree));' +
    '    window.__tree.push({ type: "file", name: "导入进来的.md", path: p, tags: [], starred: false, mtime: Date.now(), excerpt: "" });' +
    '    window.__imported.push(p);' +
    '    return [{ name: "导入进来的.md", path: p }];' +
    '  },' +
    '  pickImage: async () => null, resolveMedia: async () => null,' +
    /* 导出：把**内容**也存下来。断言要看的是导出的 HTML 里
       图表到底渲染没渲染、公式是不是解析过的 —— 只看「调了哪个导出」不够。 */
    '  exportSave: async (o) => { window.__exported = (window.__exported || []).concat(o.kind); window.__exportedData = (window.__exportedData || {}); window.__exportedData[o.kind] = o.data; return "/out/x." + o.kind },' +
    '  exportPdf: async (o) => { window.__exported = (window.__exported || []).concat("pdf"); window.__exportedData = (window.__exportedData || {}); window.__exportedData.pdf = o.html; return "/out/x.pdf" },' +
    /* 节点图标：存在内存里，写盘的内容能被断言看到 */
    '  iconsRead: async () => window.__icons ?? {},' +
    '  iconsWrite: async (root, map) => { window.__icons = map; return true },' +
    /* 标签的归属图标：同样落在内存里 */
    '  tagIconsRead: async () => window.__tagIcons ?? {},' +
    '  tagIconsWrite: async (root, map) => { window.__tagIcons = map; return true },' +
    /* 粘贴/拖入的图片落盘 */
    '  mediaSave: async (root, item) => {' +
    '    const rel = "attachments/粘贴进来的图.png";' +
    '    window.__mediaSaved = (window.__mediaSaved || []).concat([item.srcPath || "clipboard"]);' +
    '    return { rel, name: "粘贴进来的图.png", isVideo: false } },' +
    /* 联网检索：给两条假结果 */
    '  aiWebSearch: async (q, limit) => {' +
    '    window.__searched = (window.__searched || []).concat(q);' +
    '    return { ok: true, engine: "test", hits: [' +
    '      { title: "检索到的第一篇文章", url: "https://example.com/a", snippet: "这是摘要一。" },' +
    '      { title: "检索到的第二篇文章", url: "https://example.com/b", snippet: "这是摘要二。" },' +
    '    ] } },' +
    '  historySave: async (ws, f, c) => {' +
    '    const l = (window.__hist[f] = window.__hist[f] || []);' +
    '    const stamp = new Date(Date.now() + l.length * 60000).toISOString();' +
    '    const it = { name: stamp + ".md", path: "/ws/.nota-history/" + f + "/" + stamp + ".md", size: c.length, mtime: Date.now() + l.length * 60000, content: c };' +
    '    l.push(it); window.__histSaved = (window.__histSaved || []).concat(f); return it.path },' +
    '  historyList: async (ws, f) => [...(window.__hist[f] || [])].sort((a, b) => b.mtime - a.mtime),' +
    '  historyRead: async (snap) => { for (const f of Object.keys(window.__hist)) { const hit = window.__hist[f].find(i => i.path === snap); if (hit) return hit.content } return null },' +
    '  trashList: async () => window.__trash,' +
    '  trashRestore: async (r, k) => { window.__trash = window.__trash.filter(t => t.key !== k); return k },' +
    '  trashPurge: async (r, k) => { window.__purged = (window.__purged || []).concat(k); window.__trash = window.__trash.filter(t => t.key !== k); return true },' +
    '  trashEmpty: async () => { window.__emptied = true; window.__trash = []; return true },' +
    '  attachList: async () => window.__attach,' +
    '  attachDelete: async (r, rel) => { window.__attach = window.__attach.filter(a => a.rel !== rel); return true },' +
    '  attachImport: async (root, dir) => {' +
    '    const p = "attachments/新导入的资料.zip";' +
    '    window.__attach = window.__attach.concat([{ rel: p, name: "新导入的资料.zip", size: 4096, mtime: Date.now(), isVideo: false }]);' +
    '    return [{ name: "新导入的资料.zip", rel: p }]; },' +
    '  aiTest: async () => ({ ok: true, models: ["llama3.2"] }),' +
    '  onAiDelta: (cb) => { window.__delta = cb },' +
    '  aiChat: async () => {' +
    '    const cb = window.__delta;' +
    '    for (const t of ["## 结果", "\\n\\n写好了。"]) { cb && cb({ text: t }); await window.__wait(80) }' +
    '    return { ok: true, text: "## 结果\\n\\n写好了。" }' +
    '  },' +
    '  appInfo: async () => ({ electron: "33.3.1", chrome: "130.0.6723.191", node: "20.18.0", platform: "win32", arch: "x64" }),' +
    '  minimize: async () => {}, toggleMaximize: async () => false, closeWindow: async () => {},' +
    '  onMaximizeChange: (cb) => { if (window.__maximized) cb(true) },' +
    ' };' +
    ` window.__maximized = ${opts.maximized ? 'true' : 'false'};` +
    ' const css = document.createElement("style");' +
    ' css.textContent = "*{-webkit-app-region:no-drag !important}";' +
    ' document.head.appendChild(css);' +
    '})()'
  )
}

/** 常用选择器助手：在页面里点击某张笔记卡片 */
export const openNoteExpr = (name) =>
  `(() => { const t=[...document.querySelectorAll('.nlist .nl-item')].find(b=>(b.querySelector('.nl-text')?.textContent??'').includes(${JSON.stringify(name)})); t?.click(); return !!t })()`

/** 侧栏导航（所有笔记 / 收藏 / 附件库 / 回收站 / AI 编写 …） */
export const navExpr = (label) =>
  `(() => { const t=[...document.querySelectorAll('.panel .nav-item')].find(b=>(b.querySelector('.nav-label')?.textContent??'').trim()===${JSON.stringify(label)}); t?.click(); return !!t })()`

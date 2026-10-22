/**
 * 官网用的功能特写截图（`site/shots/*.png`）。
 *
 * 跟 `scripts/shots.mjs`（docs/ 那批）是两回事：那边是自查记录，这边是对外放的，
 * 所以每张图只拍**一个角度**，并且刻意把界面填到最好看的状态。
 *
 * 题材上有一条硬要求：**得像真的在写一篇东西**。
 * 早先用的是「把所有语法塞一遍」的演示稿，提示块一口气铺了十一种，
 * 于是六张图里三张的主角都是彩色方框 —— 看着像在展示提示块，不像在展示
 * 一个笔记应用。现在换成一篇真文章（《Linux 命令行入门》），提示块只在
 * 结尾留一个，剩下的篇幅是标题、正文、命令、表格、图表、待办、脚注这些
 * 每天真会写的东西。
 *
 * 一律 2 倍图：网页上要放大看细节（代码高亮、表格、图表的线）。
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes } from './fake-workspace.mjs'

const OUT = 'site/shots'
const PORT = Number(process.env.PORT || 4431)

/* ── 一篇真文章 ──
   提示块刻意只留**一个**，还放在结尾：上一版被吐槽「官网全是提示框」，
   就是因为演示稿把它们铺满了屏。 */
const ARTICLE = [
  '# Linux 命令行入门',
  '',
  '> 命令行的难不在命令多，而在不知道「我现在在哪儿、刚才发生了什么」。',
  '',
  '第一次连上一台服务器，屏幕上只有一个光标在闪。这篇从那个光标开始，',
  '把每天真会用到的东西过一遍：看目录、找文件、看进程，最后写一个自己的脚本。',
  '',
  '## 先回答三个问题',
  '',
  '敲命令之前把这三个答上来，八成的情况就够应付了：',
  '',
  '1. **我在哪个目录** —— `pwd`',
  '2. **这里有什么** —— `ls -lh`',
  '3. **刚才那句为什么报错** —— 看终端回的最后一行，答案多半就在那儿',
  '',
  '## 目录与文件',
  '',
  '| 命令 | 干什么 | 常用写法 |',
  '| :--- | :--- | :--- |',
  '| `pwd` | 打印当前目录 | `pwd` |',
  '| `ls` | 列目录 | `ls -lh` |',
  '| `cd` | 换目录 | `cd /var/log` |',
  '| `cp` | 复制 | `cp -a src/ dst/` |',
  '| `mv` | 移动 / 改名 | `mv a.txt b.txt` |',
  '| `rm` | 删除（没有回收站） | `rm -i old.log` |',
  '',
  '## 找东西',
  '',
  '按名字找和按内容找是两回事：',
  '',
  '```bash title="最近七天改过的日志"',
  'find /var/log -name "*.log" -mtime -7',
  '```',
  '',
  '```bash title="在一堆文件里找那句话"',
  'grep -R "connection refused" /var/log -n',
  '```',
  '',
  '## 看进程',
  '',
  '服务起没起来、占了多少内存，都在这里：',
  '',
  '```bash',
  'ps aux | grep nginx',
  '```',
  '',
  '想知道更细的（哪个进程在吃 CPU、内存还剩多少），另开一篇 [[进程与端口]] 讲。',
  '',
  '## 写第一个脚本',
  '',
  '把每天要做的备份写成脚本，比记命令靠谱：',
  '',
  '```bash title="backup.sh" line-numbers',
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  '',
  'SRC="/srv/data"',
  'DST="/srv/backup"',
  'STAMP="$(date +%F)"',
  '',
  'tar -czf "$DST/data-$STAMP.tar.gz" "$SRC"',
  'echo "备份完成：$DST/data-$STAMP.tar.gz"',
  '```',
  '',
  '写完别忘了 `chmod +x backup.sh`[^1]，不然它会安静地失败。',
  '',
  '## 一条命令是怎么跑完的',
  '',
  '```mermaid',
  'graph LR',
  '  A[敲下回车] --> B{Shell 找得到这个命令吗}',
  '  B -- 找不到 --> C[command not found]',
  '  B -- 找到 --> D[启动进程]',
  '  D --> E{退出码是 0 吗}',
  '  E -- 是 --> F[成了，接着敲下一句]',
  '  E -- 不是 --> G[回头看报错那一行]',
  '```',
  '',
  '## 练习清单',
  '',
  '- [x] 用 ssh 连上一台机器',
  '- [x] 找到 nginx 的日志放在哪儿',
  '- [ ] 写一个每天自动备份的脚本，挂到 cron 上',
  '- [ ] 把 [[Shell 脚本]] 那一篇读完',
  '',
  '## 接着往下读',
  '',
  '- [[进程与端口]] —— `ps`、`ss`、`lsof` 三件套',
  '- [[Shell 脚本]] —— 变量、判断、循环，够用就好',
  '',
  '> [!tip] 记不住参数很正常',
  '> 老手也是 `man` 和 `--help` 来回翻。真正要记住的只有「怎么查」。',
  '',
  '[^1]: `chmod +x` 给的是执行权限，没有它只能写成 `bash backup.sh` 来调。',
].join('\n')

/* 关系图要有枢纽也有孤岛，就靠这几篇互相引 */
const NOTES = {
  '/ws/Linux 命令行入门.md': ARTICLE,
  '/ws/进程与端口.md': [
    '# 进程与端口',
    '',
    '看进程用 `ps aux`，看端口用 `ss -lntp`，查谁占着文件用 `lsof`。',
    '',
    '这一篇接着 [[Linux 命令行入门]] 往下写。',
  ].join('\n'),
  '/ws/Shell 脚本.md': [
    '# Shell 脚本',
    '',
    '变量、判断、循环三样就够用。开头那句 `set -euo pipefail` 别忘了。',
    '',
    '配套示例在 [[Linux 命令行入门]]。',
  ].join('\n'),
  /* 下面几篇是为了让关系图有层次：一篇枢纽、几个中层、两个孤岛。
     只有 4 篇的时候图上就一颗星星孤零零挂在中间，跟文案里那句
     「列表能告诉你有 60 篇，但看不出哪篇是枢纽」对不上。 */
  '/ws/Docker 常用命令.md': [
    '# Docker 常用命令',
    '',
    '`docker ps -a` 看容器，`docker logs -f` 跟日志，`docker exec -it` 进容器。',
    '',
    '排错思路还是照着 [[Linux 命令行入门]] 来。',
  ].join('\n'),
  '/ws/网络排查.md': [
    '# 网络排查',
    '',
    '先看链路（`ping`、`traceroute`），再看端口（`ss -lntp`），最后才怀疑 DNS。',
    '',
    '端口那一段见 [[进程与端口]]。',
  ].join('\n'),
  '/ws/备份与恢复.md': [
    '# 备份与恢复',
    '',
    '每天夜里跑一次增量，每周做一次全量，恢复要真的试过才算有备份。',
    '',
    '脚本写法在 [[Shell 脚本]]，用到的命令见 [[Linux 命令行入门]]。',
  ].join('\n'),
  '/ws/待整理.md': '# 待整理\n\n几段还没归位的东西，谁都没提它。\n',
  '/ws/旧稿.md': '# 旧稿\n\n这一篇谁的都没提，孤零零地放着。\n',
}

function treeOf() {
  const file = (name, tags = []) => ({
    type: 'file',
    name,
    path: `/ws/${name}`,
    tags,
    starred: name === 'Linux 命令行入门.md',
    mtime: Date.now() - 3600_000,
    excerpt: '',
  })
  return [
    {
      type: 'dir',
      name: '运维笔记',
      path: '/ws/运维笔记',
      children: [
        file('Linux 命令行入门.md', ['Linux']),
        file('进程与端口.md', ['Linux']),
        file('Shell 脚本.md', ['Linux']),
        file('Docker 常用命令.md', ['Docker']),
        file('网络排查.md', ['网络']),
        file('备份与恢复.md', ['运维']),
        file('待整理.md'),
        file('旧稿.md'),
      ],
    },
  ]
}

const { send, evaluate, sleep, close, shot } = await launch({
  port: PORT,
  size: [1500, 940],
  scale: 2,
})

const notes = { ...makeNotes(), ...NOTES }
const INJECT = makeInject({ notes, tree: treeOf() })

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1200)
/* 新手引导（2.7.2 加的）第一次打开会自动弹，正好压在左侧栏上 ——
   拍出来的图右下角永远挂着半张卡片。它只在 localStorage 没有
   `nota-tour-seen` 时才弹，所以先标记成看过、再整页重载一次。
   别改成截完再关：这脚本 6 张图之间不回首页，第 1 张就已经被遮住了。 */
await evaluate(`localStorage.setItem('nota-tour-seen', '1')`)
await send('Page.reload', {})
await sleep(1400)
await evaluate(INJECT)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(1200)
await evaluate(INJECT)
await sleep(900)
await evaluate(`
  (() => {
    const r = [...document.querySelectorAll('.nlist .nl-item, .tree .row.file')]
      .find((b) => (b.textContent || '').includes('Linux'));
    r?.click();
    return !!r;
  })()
`)
await sleep(1800)

/* 滚到某个小节的标题 → 让标题正好离预览区顶 28px。
   直接写 scrollTop = 700 的话，落点全看文章内容多长：这次改完笔记集，
   顶上就切出半行表格，看着像渲染坏了。 */
const scrollToHeading = async (text) => {
  await evaluate(`(() => {
    const p = document.querySelector('.preview'); if (!p) return false
    const h = [...p.querySelectorAll('h2')].find((e) => e.textContent.includes(${JSON.stringify(text)}))
    if (!h) return false
    p.scrollTop += Math.round(h.getBoundingClientRect().top - p.getBoundingClientRect().top - 28)
    return true
  })()`)
  await sleep(700)
}

const clickMode = async (label) => {
  await evaluate(
    `(() => { const b = [...document.querySelectorAll('.ph-seg-btn')].find(x => (x.getAttribute('aria-label')||'').includes(${JSON.stringify(label)})); b?.click(); return !!b })()`,
  )
  await sleep(1100)
}

const setTheme = async (label) => {
  await evaluate(`(async () => {
    document.querySelector('.panel .foot .foot-btn[data-tip="设置"]')?.click()
    await new Promise(r => setTimeout(r, 400))
    const ap = [...document.querySelectorAll('.st-nav-item')].find(b => b.textContent.includes('外观'))
    ap?.click()
    await new Promise(r => setTimeout(r, 300))
    const b = [...document.querySelectorAll('.st-seg-btn')].find(x => x.textContent.trim() === ${JSON.stringify(label)})
    b?.click()
    await new Promise(r => setTimeout(r, 300))
    document.querySelector('.st-x')?.click()
    return true
  })()`)
  await sleep(700)
}

/* ① 主视觉：浅色 · 分栏（左边源码、右边渲染），停在文章开头 */
await setTheme('浅色')
await clickMode('分栏')
await sleep(2600)
await evaluate(`document.querySelector('.preview')?.scrollTo(0, 0)`)
await sleep(600)
console.log('  →', await shot(`${OUT}/hero.png`))

/* ② 阅读模式的排版：滚到表格与图表那一屏 —— 看的是排版，不是语法清单 */
await clickMode('阅读')
await sleep(2600)
await scrollToHeading('目录与文件')
console.log('  →', await shot(`${OUT}/article.png`))

/* ③ 大纲：中间那一列的页签 */
await clickMode('分栏')
await evaluate(`
  (() => {
    const b = [...document.querySelectorAll('.col-tab')].find((x) => x.textContent.includes('大纲'))
    b?.click()
    return !!b
  })()
`)
await sleep(1000)
console.log('  →', await shot(`${OUT}/outline.png`))

/* ④ 关系图 */
await evaluate(`
  (() => {
    const b = [...document.querySelectorAll('.nav-item')].find((x) => x.textContent.includes('关系图'))
    b?.click()
    return !!b
  })()
`)
await sleep(3400)
console.log('  →', await shot(`${OUT}/graph.png`))

/* ⑤ 搜索面板：搜「脚本」—— 标题和正文都命中，两段结果都露出来 */
await evaluate(`
  (() => {
    const b = [...document.querySelectorAll('.nav-item')].find((x) => x.textContent.includes('关系图'))
    b?.click()
    return !!b
  })()
`)
await sleep(700)
/* 中间栏上一张切在大纲，这里回到笔记列表 —— 搜索浮层压在一屏正常界面上
   才读得懂，压着大纲会让人以为搜索只能搜标题。 */
await evaluate(`(() => {
  const b = [...document.querySelectorAll('.col-tab')].find((x) => x.textContent.includes('笔记'))
  b?.click()
  return !!b
})()`)
await sleep(500)
/* 退关系图那一下会把左侧栏收成 rail（只剩图标列），图上就少了一整列笔记列表 ——
   看着像坏了。这里点一下 rail 上的展开按钮把列表要回来（本来就展开时
   文档里没有 .rail-btn，什么也不做）。 */
await evaluate(`(() => {
  const b = document.querySelector('.rail-btn')
  if (b) { b.click(); return 're-expanded' }
  return 'already-expanded'
})()`)
await sleep(600)
await evaluate(`
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true, bubbles: true }))
`)
await sleep(400)
await evaluate(`
  (() => {
    const i = document.querySelector('.sp-input')
    i.value = '脚本'
    i.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()
`)
await sleep(1800)
console.log('  →', await shot(`${OUT}/search.png`))

await evaluate(`document.querySelector('.sp-x')?.click()`)
await sleep(400)

/* ⑥ 深色 · 阅读模式：中间栏先回到笔记列表，再滚到脚本与流程图那一屏 */
await setTheme('深色')
await evaluate(`
  (() => {
    const b = [...document.querySelectorAll('.col-tab')].find((x) => x.textContent.includes('笔记'))
    b?.click()
    return !!b
  })()
`)
await sleep(500)
await clickMode('阅读')
await sleep(2400)
await scrollToHeading('写第一个脚本')
console.log('  →', await shot(`${OUT}/dark.png`))

await close()
console.log('done')
process.exit(0)

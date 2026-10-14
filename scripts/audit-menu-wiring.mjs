/**
 * 菜单接线巡检。
 *
 * 背景：右键菜单的每一项都是子组件 `emit` 出来的。只要调用方少绑一个
 * `@mark`，那一项照样画在菜单里，点了却什么也不发生 ——
 * 「笔记卡片上点更换图标没反应」就是这么来的，而且它不报错、不红屏，
 * 类型检查也抓不到（emit 没绑是合法的），只能靠人碰巧点到才发现。
 *
 * 所以这里静态扫一遍：每个菜单组件声明了哪些 emit，每个用到的地方
 * 是不是都接了。漏一个就退出码非 0。
 *
 * 改菜单就要同步改这张表 —— 表过期比没表更糟（它会拿旧名字去卡新代码，
 * 一改菜单就红，红得没道理，人一烦就绕过它）。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const COMP = 'src/components'
const APP = 'src/App.vue'

/** 菜单组件 → 它声明的全部事件（跟各自 defineEmits 保持一致） */
const MENUS = {
  'EditorContextMenu.vue': ['close', 'undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'ai'],
  /* 文件夹只有「更换图标」、没有标签：标签是给笔记打的，
     一个文件夹下所有笔记共享它自己的标签在语义上不成立。
     所以这一处不跟着合并成「标记…」，保持 icon。 */
  'FolderContextMenu.vue': ['close', 'newNote', 'newFolder', 'rename', 'icon', 'copyPath', 'reveal', 'remove'],
  'LibContextMenu.vue': ['close', 'pick'],
  /* 「icon」已并进「mark」：图标和标签是同一件事的两半（一个名字配一个记号），
     拆成两个弹窗时，在标签区打得到、在卡片上打不到；合并后两处都能开。 */
  'NoteContextMenu.vue': ['close', 'open', 'star', 'rename', 'mark', 'move', 'copyPath', 'reveal', 'export', 'remove'],
  'TagContextMenu.vue': ['close', 'filter', 'copy', 'rename', 'remove'],
}

const kebab = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())

let bad = 0
let checked = 0

for (const f of [...readdirSync(COMP).map((n) => path.join(COMP, n)), APP]) {
  if (!existsSync(f) || !f.endsWith('.vue')) continue
  const src = readFileSync(f, 'utf8')
  for (const [file, evs] of Object.entries(MENUS)) {
    if (!src.includes(file)) continue
    const tag = file.replace('.vue', '')
    // 抓这个组件标签的整块（自闭合或成对闭合都算）
    const re = new RegExp(`<${tag}[\\s\\S]*?(?:/>|</${tag}>)`, 'g')
    let blk
    let i = 0
    while ((blk = re.exec(src))) {
      const bound = new Set()
      for (const m of blk[0].matchAll(/@([a-zA-Z-]+)=/g)) bound.add(m[1])
      for (const m of blk[0].matchAll(/\son:([a-zA-Z-]+)=/g)) bound.add(m[1])
      const missing = evs.filter(
        (e) => !bound.has(e) && !bound.has(kebab(e)),
      )
      checked++
      if (missing.length) {
        bad++
        console.log(`❌ ${path.basename(f)} → <${tag}>#${i} 没接：${missing.join(', ')}`)
      }
      i++
    }
  }
}

// 反向核对：巡检脚本里的事件清单得跟组件真实声明对得上，
// 否则往菜单里加了一项、这边忘了补，巡检就变成摆设。
for (const file of Object.keys(MENUS)) {
  const src = readFileSync(path.join(COMP, file), 'utf8')
  // 只取事件名：带载荷的声明是 (e: 'export', kind: X)，不能在引号后就要求右括号
  const decl = [...src.matchAll(/\(e:\s*'([a-zA-Z-]+)'/g)].map((m) => m[1])
  const known = new Set(MENUS[file])
  const stale = MENUS[file].filter((e) => !decl.includes(e))
  const fresh = decl.filter((e) => !known.has(e))
  if (stale.length || fresh.length) {
    bad++
    console.log(
      `❌ ${file} 事件清单过期：脚本多记 [${stale.join(', ') || '无'}]，组件新增 [${fresh.join(', ') || '无'}]`,
    )
  }
}

console.log(
  bad === 0
    ? `✅ 菜单接线巡检通过（${checked} 处调用点，无漏接）`
    : `❌ 菜单接线巡检失败：${bad} 处`,
)
process.exit(bad === 0 ? 0 : 1)

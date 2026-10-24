// 验证便签的存储层（electron/stickies.ts）。
//
// 便签是「想到就记」的最后一环，这里出错的方式都不显眼：index.json 被并发
// 覆盖导致整批便签从列表里消失、半截 json 让恢复后位置全丢、存为笔记时
// 把用户已有的同名笔记顶掉。这些都不会当场报错，所以得逐条断言。
//
//   node scripts/verify-stickies.mjs
import { build } from 'esbuild'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'),
  '..',
)
const OUT = path.join(ROOT, '.tmp-sticky-test.mjs')

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  \x1b[32m✓\x1b[0m ' + name)
  } else {
    fail++
    console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? '  → ' + extra : ''))
  }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(got)}`)
}

await build({
  entryPoints: [path.join(ROOT, 'electron', 'stickies.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: OUT,
  logLevel: 'silent',
})

const S = await import(pathToFileURL(OUT).href + `?t=${Date.now()}`)
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nota-sticky-'))
const dir = path.join(tmp, 'stickies')
const vault = path.join(tmp, 'vault')

try {
  /* ── 空状态 ── */
  ok('目录不存在时列表为空，不抛错', (await S.listStickies(dir)).length === 0)

  /* ── 新建 ── */
  const a = await S.createSticky(dir, { x: 100, y: 200, w: 300, h: 240 })
  ok('新建返回 id', /^s-[0-9a-z]+-[0-9a-z]+$/.test(a.id), a.id)
  ok('新建默认钉在最上层', a.pinned === true)
  eq('新建记住位置', [a.x, a.y, a.w, a.h], [100, 200, 300, 240])
  ok(
    '刚新建还没打字时磁盘上不留空 .md',
    !(await fs.readdir(dir).catch(() => [])).some((n) => n === `${a.id}.md`),
  )

  /* ── 写正文 ── */
  await S.writeSticky(dir, a.id, '# 买牛奶\n顺便看看有没得鸡蛋')
  const onDisk = await fs.readFile(path.join(dir, `${a.id}.md`), 'utf8')
  ok('正文落到 .md 文件', onDisk.includes('买牛奶'))
  const list1 = await S.listStickies(dir)
  eq('列表里只有一张', list1.length, 1)
  eq('标题取首行（去掉 # 号）', list1[0].title, '买牛奶')
  ok('预览取第二行', list1[0].preview === '顺便看看有没得鸡蛋', list1[0].preview)
  ok('字数不计空白', list1[0].chars === 13, String(list1[0].chars))
  ok('写盘不留 .tmp', !(await fs.readdir(dir)).some((n) => n.endsWith('.tmp')))

  /* ── 归档 / 恢复 ── */
  await S.patchSticky(dir, a.id, { closedAt: Date.now() })
  eq('归档后默认仍能列出来（能捞回来）', (await S.listStickies(dir)).length, 1)
  eq('只要开着的便签时被过滤', (await S.listStickies(dir, { includeClosed: false })).length, 0)
  await S.writeSticky(dir, a.id, '# 买牛奶\n顺便看看有没得鸡蛋\n加了')
  eq('动过内容就自动撤销归档', (await S.listStickies(dir, { includeClosed: false })).length, 1)

  /* ── 位置记忆 ── */
  await S.patchSticky(dir, a.id, { x: 11, y: 22, w: 333, h: 444, pinned: false })
  const again = (await S.listStickies(dir)).find((r) => r.id === a.id)
  eq('位置尺寸能持久化', [again.x, again.y, again.w, again.h], [11, 22, 333, 444])
  eq('钉住状态能持久化', again.pinned, false)

  /* ── 并发写 index（收起全部时会同时发生） ── */
  const many = []
  for (let i = 0; i < 8; i++) many.push(await S.createSticky(dir))
  await Promise.all(many.map((m, i) => S.patchSticky(dir, m.id, { closedAt: 1000 + i })))
  const afterConcurrent = (await S.listStickies(dir)).map((r) => r.id)
  ok(
    `并发归档 8 张后一条记录都没丢（实得 ${afterConcurrent.length} 条）`,
    afterConcurrent.length === 9,
    afterConcurrent.join(','),
  )
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8'))
  ok('index.json 依然是完整数组', Array.isArray(raw) && raw.length === 9, String(raw?.length))

  /* ── 手动丢进来的 .md ── */
  await fs.writeFile(path.join(dir, '外部丢进来的.md'), '外面写的便签', 'utf8')
  const withForeign = await S.listStickies(dir)
  ok('用户手动丢进目录的 .md 也能看见', withForeign.some((r) => r.id === '外部丢进来的'))

  /* ── 文件名安全化 ── */
  eq('去掉路径非法字符', S.safeName('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j')
  eq('去掉开头的 # 号', S.safeName('# 标题'), '标题')
  eq('去掉结尾的点和空格', S.safeName('foo...  '), 'foo')
  eq('全空给个兜底名', S.safeName('   '), '空白便签')
  ok('过长截断到 40', S.safeName('长'.repeat(80)).length <= 40, String(S.safeName('长'.repeat(80)).length))

  /* ── 存为笔记 ── */
  const r1 = await S.saveToVault(dir, a.id, vault)
  ok('存为笔记成功', r1.ok === true, r1.error)
  eq('落在 便签/ 子目录，用首行当文件名', r1.rel, '便签/买牛奶.md')
  const savedTxt = await fs.readFile(path.join(vault, '便签', '买牛奶.md'), 'utf8')
  ok('内容原样搬过去', savedTxt.includes('加了'))
  eq('便签记录上记下了去处', (await S.listStickies(dir)).find((r) => r.id === a.id).savedTo, '便签/买牛奶.md')

  // 再存一次 → 加 -2，而不是盖掉刚才那份
  const r2 = await S.saveToVault(dir, a.id, vault)
  eq('同名第二次自动加 -2', r2.rel, '便签/买牛奶-2.md')
  const first = await fs.readFile(path.join(vault, '便签', '买牛奶.md'), 'utf8')
  ok('原有笔记没被覆盖', first.includes('加了') && first === savedTxt)

  // 用户库里本来就有一篇同名的，不能被顶掉
  await fs.mkdir(path.join(vault, '便签'), { recursive: true })
  await fs.writeFile(path.join(vault, '便签', '已经写好的.md'), '用户自己的内容', 'utf8')
  const b = await S.createSticky(dir)
  await S.writeSticky(dir, b.id, '已经写好的')
  const r3 = await S.saveToVault(dir, b.id, vault)
  eq('撞上用户已有笔记时改用 -2', r3.rel, '便签/已经写好的-2.md')
  eq(
    '用户原有笔记一个字没动',
    await fs.readFile(path.join(vault, '便签', '已经写好的.md'), 'utf8'),
    '用户自己的内容',
  )

  const empty = await S.createSticky(dir)
  const r4 = await S.saveToVault(dir, empty.id, vault)
  ok('空便签不往库里写垃圾', r4.ok === false && /空/.test(r4.error ?? ''), r4.error)

  /* ── 启动对账（强杀之后的状态修复） ──
     进程被强杀时开着的便签来不及写 closedAt，下次启动它们看起来「还开着」，
     但桌面上什么都没有。启动那一刻必然一张窗口都没开，所以可以放心全归档。 */
  const c1 = await S.createSticky(dir)
  await S.writeSticky(dir, c1.id, '强杀之前写的一句话')
  const c2 = await S.createSticky(dir)
  const rec = await S.reconcileOnBoot(dir)
  ok('对账把没收尾的便签归档', rec.archived >= 1, JSON.stringify(rec))
  ok('对账把空白便签清掉', rec.dropped >= 1, JSON.stringify(rec))
  eq('对账后没有「看起来还开着」的便签', (await S.listStickies(dir, { includeClosed: false })).length, 0)
  ok('有内容的那张内容没丢', (await S.readSticky(dir, c1.id)).includes('强杀之前写的一句话'))
  ok(
    '被清掉的那张记录也没了',
    !(await S.listStickies(dir)).some((x) => x.id === c2.id),
  )
  ok('对账可以把已归档的留在原处', (await S.listStickies(dir)).length >= 2)

  /* ── 删除 ── */
  const before = (await S.listStickies(dir)).length
  await S.removeSticky(dir, b.id)
  eq('删除后列表少一张', (await S.listStickies(dir)).length, before - 1)
  ok('文件也删掉了', !(await fs.readdir(dir)).includes(`${b.id}.md`))

  /* ── 坏数据 ── */
  await fs.writeFile(path.join(dir, 'index.json'), '{ 这不是 json', 'utf8')
  const survived = await S.listStickies(dir)
  ok('index.json 坏掉时列表仍然按磁盘文件恢复', survived.length > 0, String(survived.length))
  await S.writeSticky(dir, a.id, '还能继续写')
  ok('坏数据后仍能正常写', (await S.readSticky(dir, a.id)).includes('还能继续写'))
} finally {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  await fs.rm(OUT, { force: true }).catch(() => {})
}

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)

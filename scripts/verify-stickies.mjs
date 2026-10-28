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

  /* ── 重命名 / 标记 ──
     重命名就是改正文第一行（便签的标题只有一份，另存一个字段迟早对不上）；
     标签和图标只活在 index.json 里，不碰文件。 */
  const rn = await S.createSticky(dir)
  await S.writeSticky(dir, rn.id, '原来的标题\n第二行内容')
  const rnRes = await S.renameSticky(dir, rn.id, '改过的标题')
  ok('重命名成功', rnRes.ok === true)
  const rnText = await S.readSticky(dir, rn.id)
  ok('重命名改的是第一行', rnText.startsWith('改过的标题'), rnText.split('\n')[0])
  ok('第二行原样保留', rnText.includes('第二行内容'))
  eq(
    '列表标题跟着变',
    (await S.listStickies(dir)).find((x) => x.id === rn.id)?.title,
    '改过的标题',
  )
  ok('空标题被拒', (await S.renameSticky(dir, rn.id, '   ')).ok === false)

  /* 已归档的便签改名后仍然是归档状态。
     走 writeSticky 的话它会顺手撤掉 closedAt（正文动过＝重新开张），
     结果就是「给一张收起来的纸改个名，它自己跳回桌面」。 */
  await S.patchSticky(dir, rn.id, { closedAt: Date.now() })
  await S.renameSticky(dir, rn.id, '收起来以后改的名字')
  ok(
    '归档的便签改名后不会跳回桌面',
    !!(await S.listStickies(dir)).find((x) => x.id === rn.id)?.closedAt,
  )

  const blank = await S.createSticky(dir)
  await S.renameSticky(dir, blank.id, '起个名字')
  eq('空便签改名会落成正文', (await S.readSticky(dir, blank.id)).trim(), '起个名字')

  await S.patchSticky(dir, rn.id, {
    tags: ['docker', '运维'],
    icon: { kind: 'brand', id: 'docker' },
  })
  const tagged = (await S.listStickies(dir)).find((x) => x.id === rn.id)
  eq('标签存住了', tagged.tags, ['docker', '运维'])
  eq('图标存住了', tagged.icon, { kind: 'brand', id: 'docker' })

  /* icon: null = 去掉这枚图标。JSON 存不下 undefined ——
     写 undefined 会被 stringify 吞掉，读回来旧图标又在了。 */
  await S.patchSticky(dir, rn.id, { icon: null })
  const unicon = (await S.listStickies(dir)).find((x) => x.id === rn.id)
  ok('传 null 能把图标去掉', unicon.icon === undefined, JSON.stringify(unicon.icon))
  eq('去图标不影响标签', unicon.tags, ['docker', '运维'])

  /* 标签跟着搬进库：便签上的分类在「存为笔记」这一步不能丢 */
  const saved = await S.saveToVault(dir, rn.id, vault)
  ok('带标签的便签能存进库', saved.ok === true, saved.error)
  const md = await fs.readFile(path.join(vault, saved.rel ?? 'x'), 'utf8')
  ok('标签写成了 frontmatter', md.startsWith('---\ntags: [docker, 运维]\n---'), md.slice(0, 40))
  ok('正文接在 frontmatter 后面', md.includes('收起来以后改的名字'))

  /* 存进库就自己收起来：搬进笔记库等于「这张纸的终点」，
     留在桌面上就是同一份东西的第二份，攒一个月抽屉里全是尸体 */
  const afterSave = (await S.listStickies(dir)).find((x) => x.id === rn.id)
  ok('存为笔记后自动收起', !!afterSave?.closedAt, JSON.stringify(afterSave?.closedAt))
  ok('存为笔记后记下去处', afterSave?.savedTo === saved.rel, afterSave?.savedTo)

  /* ── 批量 ── */
  const m1 = await S.createSticky(dir)
  const m2 = await S.createSticky(dir)
  await S.writeSticky(dir, m1.id, '批量一')
  await S.writeSticky(dir, m2.id, '批量二')

  const nClosed = await S.batchPatch(dir, [m1.id, m2.id], { closedAt: 5000 })
  eq('批量收起返回改动张数', nClosed, 2)
  eq(
    '两张都收起来了',
    (await S.listStickies(dir)).filter((x) => [m1.id, m2.id].includes(x.id) && x.closedAt).length,
    2,
  )

  /* closedAt 传 null 是「删掉这个字段」（重新放回桌面），不是写 null 进去 ——
     写进去的话 isClosed 判断会一直为真，那张纸再也回不到桌面 */
  const nOpen = await S.batchPatch(dir, [m1.id, m2.id], { closedAt: null })
  eq('批量放回桌面返回改动张数', nOpen, 2)
  const reopened = (await S.listStickies(dir)).filter((x) => [m1.id, m2.id].includes(x.id))
  ok(
    '放回桌面后 closedAt 字段消失',
    reopened.every((x) => x.closedAt === undefined),
    JSON.stringify(reopened.map((x) => x.closedAt)),
  )

  await S.batchPatch(dir, [m1.id, m2.id], { tags: ['批量'] })
  ok(
    '两张都有了这个标签',
    (await S.listStickies(dir))
      .filter((x) => [m1.id, m2.id].includes(x.id))
      .every((x) => x.tags?.includes('批量')),
  )

  const nDel = await S.removeStickies(dir, [m1.id, m2.id])
  eq('批量删除返回张数', nDel, 2)
  ok(
    '批量删除后两张都不在列表里',
    !(await S.listStickies(dir)).some((x) => [m1.id, m2.id].includes(x.id)),
  )
  ok(
    '批量删除后文件也清掉了',
    !(await fs.readdir(dir)).some((f) => f.startsWith(m1.id) || f.startsWith(m2.id)),
  )

  /* 用户自己在便签里写了 frontmatter 的话，不能再顶一段上去 ——
     两段 frontmatter 会让解析器只认第一段，用户写的字段当场失效 */
  const own = await S.createSticky(dir)
  await S.writeSticky(dir, own.id, '---\ntitle: 我自己的\ntags: [x]\n---\n正文')
  await S.patchSticky(dir, own.id, { tags: ['别加'] })
  const ownSaved = await S.saveToVault(dir, own.id, vault)
  const ownMd = await fs.readFile(path.join(vault, ownSaved.rel ?? 'x'), 'utf8')
  eq('已经有 frontmatter 就不再顶一段', ownMd.match(/^---/g)?.length, 1)

  /* ── 删除 ── */
  const before = (await S.listStickies(dir)).length
  await S.removeSticky(dir, b.id)
  eq('删除后列表少一张', (await S.listStickies(dir)).length, before - 1)
  ok('文件也删掉了', !(await fs.readdir(dir)).includes(`${b.id}.md`))

  /* ── 回收站 ──
     和笔记那边同一套语义：删掉不是消失，是先挪到一边。这里出错的方式
     都不响：删除把记录一起抹了、恢复回来纸色标签掉回默认、恢复两次冒出
     两条重复记录 —— 用户当时看不到，等想找回某张纸时才发现只剩半张。 */
  const tk1 = await S.createSticky(dir, { x: 40, y: 50, w: 300, h: 220 })
  await S.writeSticky(dir, tk1.id, '要删掉的便签\n第二行内容')
  await S.patchSticky(dir, tk1.id, { color: 'mint', tags: ['临时'] })
  const nBeforeTrash = (await S.listStickies(dir)).length
  ok('删除把便签挪进回收站', (await S.trashSticky(dir, tk1.id)) === true)
  eq('删除后列表里少一张', (await S.listStickies(dir)).length, nBeforeTrash - 1)
  ok('原目录里那张 .md 已经移走', !(await fs.readdir(dir)).includes(`${tk1.id}.md`))

  const trashList = await S.listStickyTrash(dir)
  const tk1Entry = trashList.find((e) => e.key === `sticky:${tk1.id}`)
  ok('回收站里能看到这张', !!tk1Entry, JSON.stringify(trashList.map((e) => e.key)))
  eq('回收站条目名用便签首行', tk1Entry?.name, '要删掉的便签')
  ok('回收站条目带得出大小', (tk1Entry?.size ?? 0) > 0, String(tk1Entry?.size))
  ok('回收站条目标了 isSticky（页面靠它和笔记分流）', tk1Entry?.isSticky === true)
  ok('key 带 sticky: 前缀，和笔记的 base64 key 不会撞', S.isStickyTrashKey(tk1Entry?.key ?? ''))

  /* 没写过字的纸也能删、也能看出来 —— 它有记录但没有 .md */
  const tkBlank = await S.createSticky(dir)
  await S.trashSticky(dir, tkBlank.id)
  const blankEntry = (await S.listStickyTrash(dir)).find((e) => e.key === `sticky:${tkBlank.id}`)
  ok('空便签进回收站也留一条（不会被静默丢弃）', !!blankEntry, JSON.stringify(blankEntry))
  eq('空便签没有大小', blankEntry?.size, 0)
  eq('空便签的显示名兜底', blankEntry?.name, '空白便签')

  /* 恢复：内容、纸色、标签、位置都得回来。只捞 .md 的话就是「恢复了一半」 */
  await S.restoreSticky(dir, `sticky:${tk1.id}`)
  const tk1Back = (await S.listStickies(dir)).find((m) => m.id === tk1.id)
  ok('恢复后回到列表', !!tk1Back, '没回来')
  ok('恢复后正文一个字没丢', (await S.readSticky(dir, tk1.id)).includes('第二行内容'))
  eq('恢复后纸色还在', tk1Back?.color, 'mint')
  eq('恢复后标签还在', tk1Back?.tags, ['临时'])
  eq('恢复后位置尺寸还在', [tk1Back?.x, tk1Back?.y, tk1Back?.w, tk1Back?.h], [40, 50, 300, 220])
  ok(
    '恢复后回收站里那条清掉了',
    !(await S.listStickyTrash(dir)).some((e) => e.key === `sticky:${tk1.id}`),
  )

  /* 连点两下恢复（或者恢复完又点了另一条）不该长出第二张纸 */
  await S.restoreSticky(dir, `sticky:${tk1.id}`)
  eq(
    '重复恢复不会冒出重复记录',
    (await S.listStickies(dir)).filter((m) => m.id === tk1.id).length,
    1,
  )

  const tk2 = await S.createSticky(dir)
  await S.writeSticky(dir, tk2.id, '彻底删掉这张')
  await S.trashSticky(dir, tk2.id)
  await S.purgeStickyTrash(dir, `sticky:${tk2.id}`)
  ok('彻底删除后回收站里没有', !(await S.listStickyTrash(dir)).some((e) => e.key === `sticky:${tk2.id}`))
  ok('彻底删除后列表里也没有', !(await S.listStickies(dir)).some((m) => m.id === tk2.id))
  ok('彻底删除后文件也没了', !(await fs.readdir(dir)).includes(`${tk2.id}.md`))

  const tk3 = await S.createSticky(dir)
  await S.writeSticky(dir, tk3.id, '清空回收站之前')
  await S.trashSticky(dir, tk3.id)
  const aliveBefore = (await S.listStickies(dir)).length
  await S.emptyStickyTrash(dir)
  eq('清空回收站后一条不剩', (await S.listStickyTrash(dir)).length, 0)
  ok('清空把 .trash 目录整个删掉', !(await fs.readdir(dir)).includes('.trash'))
  eq('清空不该动还活着的便签', (await S.listStickies(dir)).length, aliveBefore)

  /* ── 贴进来的图片 ──
     图单独放、不塞正文（正文底下压着一层要逐行对齐的镜像）。
     这里最险的一条是 removeShot 的路径校验：便签 id 和文件名都来自渲染层，
     不校验的话一条 `../../index.json` 就能删到别处去。 */
  const shotter = await S.createSticky(dir)
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const s1 = await S.addShot(dir, shotter.id, PNG, 'png')
  ok('贴图返回文件名', s1.ok === true && /^.+\.png$/.test(s1.name ?? ''), JSON.stringify(s1))
  ok('图落在 media 目录里', await fs.stat(S.shotPath(dir, s1.name)).then(() => true, () => false))
  eq('记录上挂住了这张图', s1.shots, [s1.name])
  ok(
    '图片文件名带便签 id 前缀（回收站靠它清图）',
    (s1.name ?? '').startsWith(`${shotter.id}-`),
    s1.name,
  )

  const s2 = await S.addShot(dir, shotter.id, PNG, 'jpg')
  eq('第二张追加在后面，不覆盖前一张', s2.shots?.length, 2)
  ok('扩展名按传进来的走', (s2.name ?? '').endsWith('.jpg'), s2.name)

  const evil = await S.removeShot(dir, shotter.id, '../../index.json')
  ok(
    '构造出来的路径删不到别处（index.json 还在）',
    await fs.stat(path.join(dir, 'index.json')).then(() => true, () => false),
  )
  eq('非法文件名被拒时原样退回现有列表', evil, s2.shots)

  const afterRemove = await S.removeShot(dir, shotter.id, s1.name)
  eq('删掉指定的那一张', afterRemove, [s2.name])
  ok('文件也真的删了', !(await fs.stat(S.shotPath(dir, s1.name)).then(() => true, () => false)))

  const weird = await S.addShot(dir, shotter.id, PNG, '../../evil')
  ok('扩展名不合法时退回 png（不会拼出古怪路径）', /\.png$/.test(weird.name ?? ''), weird.name)

  /* 存为笔记：图要复制进库里的 attachments/，正文末尾补 Markdown 链接。
     是复制不是搬走 —— 这张纸如果留着继续写，底下那条托盘不该当场裂开 */
  const withImg = await S.saveToVault(dir, shotter.id, vault)
  ok('带图的便签能存进库', withImg.ok === true, withImg.error)
  const imgMdText = await fs.readFile(path.join(vault, withImg.rel ?? 'x'), 'utf8')
  ok('正文末尾补上了图片链接', /!\[\]\(attachments\/.+\.(jpg|png)\)/.test(imgMdText), imgMdText.slice(-60))
  const attFiles = await fs.readdir(path.join(vault, 'attachments')).catch(() => [])
  ok('图复制进了 attachments', attFiles.length >= 1, attFiles.join(','))
  ok('便签自己那份没被搬走', await fs.stat(S.shotPath(dir, weird.name)).then(() => true, () => false))

  /* 只贴了图、一个字没写，也算有内容 —— 以前会被判成空便签存不出去 */
  const onlyShot = await S.createSticky(dir)
  await S.addShot(dir, onlyShot.id, PNG, 'png')
  const onlyShotSaved = await S.saveToVault(dir, onlyShot.id, vault)
  ok('只有图没写字的便签也能存', onlyShotSaved.ok === true, onlyShotSaved.error)

  /* 彻底删掉一张贴过图的纸，图要跟着走（不然删十次攒下几十兆垃圾） */
  const imgTrash = await S.createSticky(dir)
  const gone = await S.addShot(dir, imgTrash.id, PNG, 'png')
  await S.writeSticky(dir, imgTrash.id, '带图的便签')
  await S.trashSticky(dir, imgTrash.id)
  await S.purgeStickyTrash(dir, `sticky:${imgTrash.id}`)
  ok(
    '彻底删除时连它的图一起清掉',
    !(await fs.stat(S.shotPath(dir, gone.name)).then(() => true, () => false)),
  )

  /* 纸色改动能存住。渲染层要靠它，主进程只负责记 */
  await S.patchSticky(dir, tk1.id, { color: 'lilac' })
  eq(
    '纸色改动存得住',
    (await S.listStickies(dir)).find((m) => m.id === tk1.id)?.color,
    'lilac',
  )

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

// 验证首次启动建库的逻辑（electron/vault.ts）。
//
// 这块会往用户的「文档」目录里写文件，所以不能只靠"看起来没问题"：
// 覆盖用户已有内容、或者在别人的库里乱丢文件，比不建库严重得多。
//
//   node scripts/verify-vault.mjs
import { build } from 'esbuild'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..')
const OUT = path.join(ROOT, '.tmp-vault-test.mjs')

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

await build({
  entryPoints: [path.join(ROOT, 'electron', 'vault.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: OUT,
  logLevel: 'silent',
})
const {
  ensureVault,
  ensureVaultAt,
  readVaultPointer,
  writeVaultPointer,
  vaultPointerPath,
  writeFreshFlag,
  takeFreshFlag,
  freshFlagPath,
} = await import(pathToFileURL(OUT).href)

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nota-vault-'))
const WELCOME = '欢迎使用 Nota.md'

try {
  console.log('\n[1] 全新的文档目录')

  const docs = path.join(tmpRoot, 'Documents')
  const r1 = await ensureVault(docs)
  ok('返回了工作区路径', r1.root === path.join(docs, 'Nota'), r1.root)
  ok('标记为新建', r1.created === true)
  ok('返回了欢迎文档路径', !!r1.file && r1.file.endsWith(WELCOME))

  const doc = await fs.readFile(r1.file, 'utf8')
  ok('欢迎文档真的写进去了', doc.length > 1000, doc.length + ' 字符')
  ok('首行是标题', doc.startsWith('# 欢迎使用 Nota'))
  ok('文档里没有留下未替换的占位符', !/\{\{|\$\{|TODO|FIXME/.test(doc))

  console.log('\n[2] 文档内容覆盖了核心功能（防止我写漏）')

  const must = [
    ['快捷键总览', 'Ctrl+P'],
    ['新建', 'Ctrl+N'],
    ['搜索', 'Ctrl+Shift+F'],
    ['关系图', 'Ctrl+Shift+G'],
    ['双链', '[[笔记名]]'],
    ['斜杠命令', '`/`'],
    ['提示块', '[!tip]'],
    ['代码块', '```mermaid'],
    ['公式', '$$'],
    ['任务列表', '- [x]'],
    ['导出', 'PDF'],
    ['Word', 'Word'],
    ['云同步', 'WebDAV'],
    ['AI', 'Ollama'],
    ['回收站', '回收站'],
    ['版本历史', '.nota-history'],
  ]
  for (const [name, needle] of must) {
    ok('提到' + name, doc.includes(needle))
  }

  // 代码围栏必须成对，否则整篇后半段都会被当成代码渲染
  const fences = (doc.match(/```/g) || []).length
  ok('代码围栏成对', fences % 2 === 0, '共 ' + fences + ' 个')

  console.log('\n[3] 目录里已经有笔记时不动它')

  const docs2 = path.join(tmpRoot, 'Documents2', 'Nota')
  await fs.mkdir(docs2, { recursive: true })
  await fs.writeFile(path.join(docs2, '我的笔记.md'), '# 我自己的\n', 'utf8')

  const r2 = await ensureVault(path.join(tmpRoot, 'Documents2'))
  ok('没写欢迎文档', r2.file === null)
  ok('标记为非新建', r2.created === false)
  const after2 = await fs.readdir(docs2)
  ok('目录里还是只有那一篇', after2.length === 1, after2.join(', '))

  console.log('\n[4] 同名文件已存在时绝不覆盖')

  const docs3 = path.join(tmpRoot, 'Documents3', 'Nota')
  await fs.mkdir(docs3, { recursive: true })
  const mine = '# 我自己写的欢迎\n\n别动我\n'
  await fs.writeFile(path.join(docs3, WELCOME), mine, 'utf8')

  await ensureVault(path.join(tmpRoot, 'Documents3'))
  const kept = await fs.readFile(path.join(docs3, WELCOME), 'utf8')
  ok('原文件内容没被覆盖', kept === mine, JSON.stringify(kept.slice(0, 20)))

  console.log('\n[5] 中文与空格的路径')

  const docs4 = path.join(tmpRoot, '我的 文档', '资料 目录')
  const r4 = await ensureVault(docs4)
  ok('中文路径下也能建', r4.root === path.join(docs4, 'Nota') && r4.created === true)
  const d4 = await fs.readFile(r4.file, 'utf8')
  ok('内容完整', d4.startsWith('# 欢迎使用 Nota'))

  console.log('\n[6] 重复调用不会写第二份')

  const r5 = await ensureVault(docs)
  ok('第二次返回同一个目录', r5.root === r1.root)
  ok('第二次不写文件', r5.file === null)
  const entries5 = await fs.readdir(path.join(docs, 'Nota'))
  ok('目录里只有一篇', entries5.length === 1, entries5.join(', '))

  console.log('\n[7] 建不出来时安静返回，不抛异常')

  // 拿一个文件当目录用，mkdir 必然失败
  const badParent = path.join(tmpRoot, 'blocked')
  await fs.writeFile(badParent, 'x', 'utf8')
  const r6 = await ensureVault(badParent)
  ok('返回 root 为 null', r6.root === null)
  ok('带上了错误说明', typeof r6.error === 'string' && r6.error.length > 0)

  console.log('\n[8] 安装时选的目录：直接用它，不再往下套一层 Nota')

  const picked = path.join(tmpRoot, 'D盘', '我的 笔记')
  const r7 = await ensureVaultAt(picked)
  ok('工作区就是它本身', r7.root === picked, r7.root)
  ok('写入了欢迎文档', !!r7.file && r7.file.startsWith(picked))
  const entries7 = await fs.readdir(picked)
  ok('没有多建一层 Nota 目录', !entries7.includes('Nota'), entries7.join(', '))

  // 用户指着一个已经有笔记的目录说「就用这个」——不许往里加东西
  const occupied = path.join(tmpRoot, '已有笔记')
  await fs.mkdir(occupied, { recursive: true })
  await fs.writeFile(path.join(occupied, '旧笔记.md'), '# 旧的\n', 'utf8')
  const r8 = await ensureVaultAt(occupied)
  ok('已有笔记时不动它', r8.created === false && r8.file === null)
  const entries8 = await fs.readdir(occupied)
  ok('还是只有那一篇', entries8.length === 1, entries8.join(', '))

  console.log('\n[9] 指针文件：安装程序写、主程序读')

  // 指针放在它自己的 LocalAppData 下，不碰真实的那份
  const lad = path.join(tmpRoot, 'LocalAppData')
  ok('没写过时读回 null', (await readVaultPointer(lad)) === null)

  await writeVaultPointer(lad, picked)
  ok('写进去能原样读回来', (await readVaultPointer(lad)) === path.resolve(picked))
  const rawPointer = JSON.parse(await fs.readFile(vaultPointerPath(lad), 'utf8'))
  ok('存的是 root 字段', rawPointer.root === picked, JSON.stringify(rawPointer))

  // 坏掉的指针不能让程序首次启动就起不来，必须安静退回默认目录
  await fs.writeFile(vaultPointerPath(lad), '{ 这不是 json', 'utf8')
  ok('坏 json 读回 null', (await readVaultPointer(lad)) === null)
  await fs.writeFile(vaultPointerPath(lad), '{"root":""}', 'utf8')
  ok('空 root 也当没有', (await readVaultPointer(lad)) === null)
  await fs.writeFile(vaultPointerPath(lad), '{"root":123}', 'utf8')
  ok('root 不是字符串也当没有', (await readVaultPointer(lad)) === null)

  console.log('\n[10] 全新安装标记：装完第一次启动要清掉旧状态')

  ok('没装过时没有标记', (await takeFreshFlag(lad)) === null)
  ok('标记文件也没有', !(await fs.stat(freshFlagPath(lad)).then(() => true).catch(() => false)))

  await writeFreshFlag(lad, '2.7.8')
  ok('写完之后文件在', await fs.stat(freshFlagPath(lad)).then(() => true).catch(() => false))
  const flagRaw = JSON.parse(await fs.readFile(freshFlagPath(lad), 'utf8'))
  ok('记了版本号', flagRaw.version === '2.7.8', JSON.stringify(flagRaw))

  const taken = await takeFreshFlag(lad)
  ok('读回来带着版本', taken?.version === '2.7.8', JSON.stringify(taken))
  ok('读完就删掉了（一次性）', (await takeFreshFlag(lad)) === null)

  // 内容坏了也要能消费掉：否则每次启动都当成「刚装完」再清一遍用户配置
  await fs.mkdir(path.dirname(freshFlagPath(lad)), { recursive: true })
  await fs.writeFile(freshFlagPath(lad), 'not json', 'utf8')
  ok('坏内容返回空对象', JSON.stringify(await takeFreshFlag(lad)) === '{}')
  ok('坏内容也照样删掉', (await takeFreshFlag(lad)) === null)

  // 安装目录都被删掉的情况（用户把 LOCALAPPDATA\Nota 清了）
  const gone = path.join(tmpRoot, 'no-such-home')
  ok('目录不存在也不抛', (await takeFreshFlag(gone)) === null)
} finally {
  await fs.rm(tmpRoot, { recursive: true, force: true })
  await fs.rm(OUT, { force: true })
}

console.log(
  '\n' + (fail === 0 ? '\x1b[32m' : '\x1b[31m') + `${pass} 通过 / ${fail} 失败\x1b[0m\n`,
)
process.exit(fail === 0 ? 0 : 1)

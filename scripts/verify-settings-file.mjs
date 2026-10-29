/**
 * 设置文件的来回一趟。
 *
 * 这一版把设置从 localStorage 搬进了 `<库>/.nota/settings.json`，搬的过程里
 * 最容易出的一类错是「写进去的键，读的时候被过滤掉了」—— 表现是某项设置
 * 每次重启都回到默认，不报错、不丢数据，只有用户自己发现。所以这里验的
 * 全是「存了能不能原样拿回来」：
 *
 *  1. 存一项、重新载入、还在；
 *  2. 表里没登记的键也不能丢（漏登记就丢 = 静默失效）；
 *  3. 老版本 localStorage 里的字符串要按类型搬过来（'0' → false，json 串 → 对象）；
 *  4. 迁移只做一次 —— 用户把某项改回默认后，重启不该被老那份顶回去。
 *
 * 不需要 Electron：把 window.api 和 localStorage 换成内存里的假货就行。
 *
 * 用法：node --experimental-strip-types scripts/verify-settings-file.mjs
 */
const files = new Map()
const store = new Map()

globalThis.window = {
  api: {
    async settingsRead(root) {
      const p = root ? `${root}/.nota/settings.json` : '(machine)/settings.json'
      const raw = files.get(p)
      if (!raw) return { data: {}, path: p }
      return { data: JSON.parse(raw), path: p }
    },
    async settingsPatch(root, patch) {
      const p = root ? `${root}/.nota/settings.json` : '(machine)/settings.json'
      const cur = files.get(p) ? JSON.parse(files.get(p)) : {}
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete cur[k]
        else cur[k] = v
      }
      files.set(p, JSON.stringify(cur))
    },
  },
}
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
}

const { loadSettings, remember, setting, flushSettings } = await import('../src/store/settings.ts')

let pass = 0
const fail = []
const ok = (name, cond, detail) => {
  if (cond) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    fail.push(name)
    console.log(`  FAIL  ${name}  ${detail ?? ''}`)
  }
}

const VAULT = 'E:/vault'

console.log('\n── 存了能拿回来 ──')
await loadSettings(VAULT)
remember('nota-theme', 'dark')
remember('nota-w-sidebar', 268)
await flushSettings()
await loadSettings(VAULT)
ok('字符串项存得住', setting('nota-theme', '') === 'dark', setting('nota-theme', ''))
ok('数字项存得住', setting('nota-w-sidebar', 0) === 268, setting('nota-w-sidebar', 0))

console.log('\n── 表里没登记的键也不丢 ──')
remember('nota-last-note', 'E:/vault/周报.md')
await flushSettings()
await loadSettings(VAULT)
ok('没登记过的键原样读回', setting('nota-last-note', '') === 'E:/vault/周报.md', setting('nota-last-note', ''))

console.log('\n── 老版本那批 localStorage 设置 ──')
files.clear()
store.clear()
store.set('nota-sidebar', '0')
store.set('nota-ai', JSON.stringify({ model: 'gpt-4o', temperature: 0.3 }))
store.set('nota-w-column', '420')
await loadSettings(VAULT)
/* 迁移是攒 200ms 一批写的，不是当场落盘 */
await flushSettings()
ok("bool 的 '0' 变成 false", setting('nota-sidebar', true) === false)
ok('json 串解析成对象', setting('nota-ai', null)?.model === 'gpt-4o', JSON.stringify(setting('nota-ai', null)))
ok('数字串转成数字', setting('nota-w-column', 0) === 420)
ok('搬完写进了文件', !!files.get(`${VAULT}/.nota/settings.json`))
ok('localStorage 里那份没被删（降级要用）', store.get('nota-sidebar') === '0')

console.log('\n── 迁移只做一次 ──')
remember('nota-sidebar', true)
await flushSettings()
await loadSettings(VAULT)
ok('改成 true 之后，重启不会被老那份顶回 false', setting('nota-sidebar', false) === true)

console.log('\n── 没有库时走机器级 ──')
remember('nota-theme', 'dark')
await flushSettings()
await loadSettings(null)
remember('nota-theme', 'light')
await flushSettings()
ok('机器级也存了一份', !!files.get('(machine)/settings.json'))
await loadSettings(VAULT)
ok('有库时读的是库那份', setting('nota-theme', '') === 'dark', setting('nota-theme', ''))

console.log(`\n${pass} 通过，${fail.length} 失败`)
if (fail.length) {
  console.log('失败项：\n' + fail.map((f) => '  · ' + f).join('\n'))
  process.exit(1)
}
console.log('ALL PASS')

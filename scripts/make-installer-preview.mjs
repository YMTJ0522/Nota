/**
 * 生成安装界面预览：install/installer.html + mock 主进程 API
 *   → .keep/installer-preview.html
 *
 * 为什么要 mock：installer.html 依赖 window.notaInstall（preload 注入），
 * 直接在浏览器里打开会因为没有 api 白屏。预览版注入一个假 api，
 * 把「开始安装」变成一段定时推进的假进度，其余交互照常 ——
 * 设计评审用它看效果，不参与打包（.keep 不在 extraResources 里）。
 *
 * 用法：node scripts/make-installer-preview.mjs
 * 改了 installer.html 之后重跑一次即可。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(path.join(root, 'install', 'installer.html'), 'utf8')

const mock = `
<script>
  /* ── 预览专用 mock：模拟主进程的 installer:* 通道 ── */
  ;(() => {
    let phaseCb = null
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    let dirIdx = 0
    const DIRS = [
      'C:\\\\Users\\\\ymtj1\\\\AppData\\\\Local\\\\Programs\\\\Nota',
      'D:\\\\Soft\\\\Nota',
      'E:\\\\Apps\\\\Nota',
    ]
    const NOTES = [
      'C:\\\\Users\\\\ymtj1\\\\Documents\\\\Nota',
      'D:\\\\我的笔记',
    ]
    window.notaInstall = {
      async info() {
        return {
          mode: new URLSearchParams(location.search).get('mode') === 'uninstall'
            ? 'uninstall' : 'install',
          version: '3.9.2',
          dir: DIRS[0],
          notes: NOTES[0],
        }
      },
      onPhase(cb) { phaseCb = cb },
      async chooseDir() {
        dirIdx = (dirIdx + 1) % DIRS.length
        return path_join(DIRS[dirIdx])
      },
      async chooseNotes() { return NOTES[1] },
      async start() {
        const steps = [
          ['正在准备', 0, 300],
          ['正在写入文件', 24, 420],
          ['正在写入文件', 58, 460],
          ['正在写入文件', 86, 380],
          ['正在写入文件', 100, 260],
          ['正在创建快捷方式', 100, 320],
          ['正在登记卸载信息', 100, 300],
          ['正在准备笔记目录', 100, 260],
        ]
        for (const [label, percent, ms] of steps) {
          phaseCb?.({ label, percent })
          await wait(ms)
        }
        return {
          ok: true,
          exe: 'C:\\\\Users\\\\ymtj1\\\\AppData\\\\Local\\\\Programs\\\\Nota\\\\Nota.exe',
          dir: 'C:\\\\Users\\\\ymtj1\\\\AppData\\\\Local\\\\Programs\\\\Nota',
          bytes: 81_570_000,
          notes: 'C:\\\\Users\\\\ymtj1\\\\Documents\\\\Nota',
        }
      },
      async usePortable() { alert('（预览）这里会关闭安装窗，直接以免安装方式运行。') },
      async launch() { alert('（预览）这里会启动安装好的 Nota。') },
      async minimize() {},
      async quit() { alert('（预览）这里会退出安装程序。') },
      async openHome() {},
    }
    function path_join(p) { return p + '\\\\Nota' }
  })()
</scr` + `ipt>
`

// 插到正文第一个 <script>（品牌标志那段）之前，保证 mock 先就位；
// 顺带把 ../icon.png 改指 build/ 下的真图标 —— 打包时 install/ 的上级
// 就是 resources 根（icon.png 在那儿），预览时上级是项目根，路径不同。
let out = src.replace('<script>', mock + '\n<script>')
if (out === src) throw new Error('没找到注入点：<script>')
out = out.replaceAll('src="../icon.png"', 'src="../build/icon.png"')
const dst = path.join(root, '.keep', 'installer-preview.html')
writeFileSync(dst, out)
console.log('written:', dst, `(${(out.length / 1024).toFixed(1)} KB)`)

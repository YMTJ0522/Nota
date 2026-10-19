/**
 * 由 site/index.html 生成「自建服务器」那一版页面。
 *
 *   node scripts/make-server-page.mjs
 *
 * 两份页面只差下载那一段：
 *   site/          按钮指向 GitHub Releases，靠 GitHub API 现取直链；
 *   deploy/server/ 按钮指向 /d/setup.exe，由自己的服务器吐文件，
 *                  版本号读同目录的 info.json（不问 api.github.com，
 *                  国内访客问它经常转圈好几秒）。
 *
 * 改完官网记得跑一次这个，否则服务器版还停在旧文案上。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = fs.readFileSync(path.join(root, 'site/index.html'), 'utf8')

let out = src
  /* 下载按钮：指向本机。带 .exe 后缀是故意的 —— 这样任何静态服务器
     （不需要 alias，也不需要 Content-Disposition）都能直接吐文件，
     浏览器存下来也是正常文件名。 */
  .replace(
    /<a class="btn btn-primary" data-dl="setup" href="https:\/\/github\.com\/[^"]*">/,
    '<a class="btn btn-primary" data-dl="setup" href="/d/setup.exe">',
  )
  /* 页脚那个「下载」也别再回 GitHub 发布页 */
  .replace(/<a href="https:\/\/github\.com\/[^"]*\/releases\/latest">下载<\/a>/, '<a href="#download">下载</a>')

const before = out
out = out.replace(
  /;\s*\(function latestRelease\(\) \{[\s\S]*?\}\)\(\)/,
  `;/* 自建服务器版：下载走本机 /d/*，版本号读同目录的 info.json */
;(function localInfo() {
  var mb = function (n) { return n > 0 ? (n / 1048576).toFixed(0) + ' MB' : '' }
  var apply = function (kind, a) {
    if (!a || !a.name) return
    var m = document.querySelector('[data-dl-meta="' + kind + '"]')
    if (!m) return
    var size = mb(a.size || 0)
    m.textContent = size ? a.name + ' · ' + size : a.name
  }
  fetch('/info.json')
    .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('http ' + r.status)) })
    .then(function (d) {
      var as = d.assets || {}
      apply('setup', as.setup)
      if (d.version) {
        var v = document.querySelector('[data-dl-ver]')
        if (v) v.textContent = '当前版本 ' + d.version
        var b = document.querySelector('[data-dl-badge]')
        if (b) { b.textContent = 'v' + d.version + ' · '; b.hidden = false }
      }
    })
    .catch(function () { /* 兜底文字已经在 HTML 里 */ })
})()`,
)

if (out === before) {
  console.error('没替换成功：站点页里找不到取 Release 的那段脚本，结构可能变了')
  process.exit(1)
}

const left = out.match(/releases\/(latest|download)/g)
if (left) {
  console.error(`还有 ${left.length} 处指向 GitHub Releases：${left.join(', ')}`)
  process.exit(1)
}

const dst = path.join(root, 'deploy/server/public/index.html')
fs.mkdirSync(path.dirname(dst), { recursive: true })
fs.writeFileSync(dst, out)
console.log(`已生成 deploy/server/public/index.html（${(out.length / 1024).toFixed(0)} KB）`)
console.log('下载入口：/d/setup.exe')

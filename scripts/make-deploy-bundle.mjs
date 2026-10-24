/**
 * 打一个可离线部署的包：site/ + 安装包 + info.json，压成一个 tar.gz。
 *
 *   node scripts/make-deploy-bundle.mjs
 *
 * 为什么要这个：服务器在境内，能不能连上 api.github.com / codeload 是未知数，
 * 而部署脚本一旦卡在下载这一步就整条路走不通。改成从本机 scp 上去，
 * 服务器只负责解压和起服务，跟外网彻底无关。
 *
 * 产物：release/nota-site-<版本>.tgz
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const VERSION = pkg.version

const STAGE = path.join(root, '.bundle-stage')
const OUT = path.join(root, 'release', `nota-site-${VERSION}.tgz`)

function cpDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const name of fs.readdirSync(from)) {
    const a = path.join(from, name)
    const b = path.join(to, name)
    if (fs.statSync(a).isDirectory()) cpDir(a, b)
    else fs.copyFileSync(a, b)
  }
}

fs.rmSync(STAGE, { recursive: true, force: true })
fs.mkdirSync(STAGE, { recursive: true })

// 站点
cpDir(path.join(root, 'site'), path.join(STAGE, 'site'))

// 静态服务：多线程 + Range，装的时候顺带放到站点目录里
fs.copyFileSync(path.join(root, 'deploy', 'server', 'serve.py'), path.join(STAGE, 'serve.py'))
// 后台（登录 / 下载统计 / 改密）挂在 serve.py 上，跟着一起走
fs.copyFileSync(path.join(root, 'deploy', 'server', 'nota_admin.py'), path.join(STAGE, 'nota_admin.py'))

// 安装包：**只往包里放 Setup 这一份**。
// 便携版跟它是同一个二进制，服务器上由 install-local.sh 建一个硬链接
// （d/portable.exe → setup.exe）：访客照样能下到两个名字的文件，
// 磁盘只占一份，这个包也不用多背 70 MB。网络不好的时候省下的就是几分钟。
const setup = path.join(root, 'release', `Nota-Setup-${VERSION}.exe`)
const portable = path.join(root, 'release', `Nota-Portable-${VERSION}.exe`)
if (!fs.existsSync(setup)) {
  console.error(`缺少 ${path.relative(root, setup)} —— 先 npm run pack`)
  process.exit(1)
}
if (!fs.existsSync(portable)) {
  console.error(`缺少 ${path.relative(root, portable)} —— 先 npm run pack`)
  process.exit(1)
}
fs.mkdirSync(path.join(STAGE, 'd'), { recursive: true })
fs.copyFileSync(setup, path.join(STAGE, 'd', 'setup.exe'))

const size = fs.statSync(setup).size
fs.writeFileSync(
  path.join(STAGE, 'info.json'),
  JSON.stringify(
    {
      version: VERSION,
      assets: {
        setup: { name: `Nota-Setup-${VERSION}.exe`, size },
        // 体积写的是真实字节数（两份完全一样），页面拿它显示「· 68 MB」
        portable: { name: `Nota-Portable-${VERSION}.exe`, size },
      },
    },
    null,
    2,
  ) + '\n',
)
fs.writeFileSync(path.join(STAGE, 'VERSION'), VERSION + '\n')

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.rmSync(OUT, { force: true })
// 在 stage 目录里用**相对路径**调用 tar。
// 绝对路径里的 `C:` 会被 GNU tar 当成「远程主机:路径」，直接报
// "Cannot connect to C: resolve failed"；`--force-local` 只有 GNU tar 认，
// Windows 自带的那份是 bsdtar，不认这个参数。相对路径两边都安全。
execFileSync('tar', ['-czf', '../release/' + path.basename(OUT), '.'], {
  cwd: STAGE,
  stdio: 'pipe',
})
fs.rmSync(STAGE, { recursive: true, force: true })

const mb = (n) => (n / 1048576).toFixed(1) + ' MB'
console.log(`\n包好了：${path.relative(root, OUT)}  ${mb(fs.statSync(OUT).size)}`)
console.log(`  内含 site/（${fs.readdirSync(path.join(root, 'site', 'shots')).length} 张截图）`)
console.log(`       d/setup.exe  ${mb(size)}`)
console.log(`       d/portable.exe  部署时硬链接到上面那份，不额外占空间`)
console.log(`       info.json    版本 ${VERSION}`)

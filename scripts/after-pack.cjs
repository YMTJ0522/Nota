/**
 * 打包瘦身：electron-builder 把整个 Chromium 运行时拷进 win-unpacked 之后、
 * 压成安装包之前，把这台机器上永远用不到的那部分删掉。
 *
 * 时机很重要 —— 必须是 afterPack（已拷贝、未打包）。
 * 打成 .exe 之后再删就来不及了，裁剪的内容早被压进安装包里了。
 *
 * 每个删除动作都做了容错：文件被别的进程占着时 Windows 会拒绝，
 * 那就原样留着，绝不把打包流程带崩。
 * 宁可多占几 MB，也不要因为一个删不掉的文件让整晚的产物报废。
 */
const fs = require('node:fs')
const path = require('node:path')

/** 语言包：只留简体中文。Electron 找不到语言包时会退回 resources.pak 里内置的 en-US。 */
const KEEP_LOCALES = new Set(['zh-CN.pak', 'en-US.pak'])

/**
 * 删得掉的运行时文件。
 *
 * 每一条都写清楚「为什么这台机器上用不到」，因为下次要加回来的时候
 * 靠的就是这句话 —— 没理由的删除清单是不敢动的。
 *
 * · LICENSES.chromium.html（8.8MB）
 *   Chromium 第三方许可证的纯文本清单。内容是合规材料不是程序，删了不影响运行。
 *   LICENSE.electron.txt 留着（4KB），里面指明了去哪儿取这份清单。
 *
 * · vk_swiftshader.dll + vk_swiftshader_icd.json + vulkan-1.dll（6.2MB）
 *   Vulkan 的软件光栅化后备。Windows 上 Electron 走 ANGLE + Direct3D，
 *   这条路根本不会被用到 —— 没有 Vulkan  GPU 时 Chromium 会走 SwiftShader GL，
 *   那个在 libGLESv2.dll 里，不在这一组。
 *
 * · elevate.exe（107KB）
 *   提权安装用的。NSIS 配的是 perMachine:false（只装给当前用户），不需要管理员。
 */
const DEAD_FILES = [
  'LICENSES.chromium.html',
  'vk_swiftshader.dll',
  'vk_swiftshader_icd.json',
  'vulkan-1.dll',
  'elevate.exe',
]

/**
 * 动不得的（留着给下次参考，别误删）：
 * · ffmpeg.dll        —— 附件栏预览视频要用（AttachView.vue 里 <video>）
 * · d3dcompiler_47.dll —— ANGLE 编着色器用。Win10+ 系统自带，理论上可删，
 *                         但删了万一某台机器上缺失就是整屏黑，不值。
 * · libGLESv2 / libEGL —— GPU 合成。用户抱怨过卡，砍这个只会更卡。
 * · resources/icon.png —— electron/main.ts 会去读它
 */

function size(dir) {
  let n = 0
  let walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name))
      else n += fs.statSync(path.join(d, e.name)).size
    }
  }
  walk(dir)
  return n
}

/** 删除失败也继续：被某个进程占着时 Windows 会拒绝，那就原样留着 */
function rip(target) {
  const before = fs.existsSync(target) ? fs.statSync(target).size : 0
  try {
    fs.rmSync(target, { force: true })
  } catch {
    return { saved: 0, failed: true }
  }
  return { saved: before, failed: fs.existsSync(target) }
}

/** @param context electron-builder 的 AfterPackContext */
module.exports = async function afterPack(context) {
  const dir = context.appOutDir
  const t0 = size(dir)

  const notes = []
  let saved = 0
  let failed = 0

  /* 1. 语言包 */
  const locales = path.join(dir, 'locales')
  if (fs.existsSync(locales)) {
    for (const name of fs.readdirSync(locales)) {
      if (KEEP_LOCALES.has(name)) continue
      const r = rip(path.join(locales, name))
      saved += r.saved
      if (r.failed) failed++
    }
    notes.push(`locales 只留 ${[...KEEP_LOCALES].join(' / ')}`)
  }

  /* 2. 运行时死文件 */
  for (const name of DEAD_FILES) {
    const target = path.join(dir, name)
    if (!fs.existsSync(target)) continue
    const r = rip(target)
    saved += r.saved
    if (r.failed) failed++
    else notes.push(name)
  }

  const t1 = size(dir)
  const mb = (n) => (n / 1024 / 1024).toFixed(1)
  console.log(
    `\n  瘦身：${mb(t0)} MB → ${mb(t1)} MB（省 ${mb(saved)} MB）\n` +
      `      ${notes.join('、') || '无可清理项'}` +
      (failed ? `\n      ⚠ ${failed} 个文件被占用没删掉（不影响打包）` : ''),
  )
}

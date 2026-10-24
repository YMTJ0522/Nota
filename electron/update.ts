/**
 * 检查更新。
 *
 * 判据只有一处：官网的 info.json。它由打包脚本在发布时写进去 ——
 * 版本号和安装包字节数都在里面，软件这边不内置「最新是多少」，
 * 否则每发一版都得回来改一处常量，早晚对不上。
 *
 * 三个刻意的取舍：
 *
 *  1. **只报不装。** 安装包没有代码签名，静默下载再执行会被 SmartScreen
 *     拦下来，装进 Program Files 还要管理员权限 —— 半途失败留下的是半个程序，
 *     比「不更新」更麻烦。所以这里只负责说「官网有新版了」，下载交给浏览器。
 *
 *  2. **不读缓存。** 官网刚发版时读到本地缓存，会显示「已是最新」然后让人
 *     接着用旧的 —— 这正是检查更新最容易出的那种错。
 *
 *  3. **失败不抛。** 检查更新失败是常态（断网、DNS、服务器重启），
 *     界面上给一句「检查失败」就够了，不该弹对话框打断人写东西。
 */
import { net } from 'electron'
import { compareVersion } from './version'

export interface UpdateResult {
  /** 本地这版 */
  current: string
  /** 官网上写的那版；取不到时等于 current */
  latest: string
  /** 官网是否真的更新 */
  newer: boolean
  /** 安装包字节数，0 = 官网没写 */
  size: number
  /** 下载页地址 */
  url: string
  /** 取不到时的原因，一句话、给人看，取到了就是 undefined */
  error?: string
  /** 原始报错，界面上挂在 title 里 —— 平时不吓人，要排查时又不会丢 */
  detail?: string
}

/* 地址可以被环境变量顶掉，只为一件事：验证「有新版」那条路径。
   官网自己永远是最新，本地跑起来只会得到「已是最新」，
   而横幅长什么样、点击去不去得了，靠想象是靠不住的。 */
const FEED = process.env.NOTA_UPDATE_FEED?.trim() || 'https://ymtj.hyper99.top/info.json'
const DOWNLOAD_PAGE = 'https://ymtj.hyper99.top/#download'
const TIMEOUT_MS = 8000

/** 取一次官网 info.json，跟本地这版比一比。任何一步失败都退回 `newer: false` + 原因。 */
export async function checkUpdate(current: string): Promise<UpdateResult> {
  const base: UpdateResult = {
    current,
    latest: current,
    newer: false,
    size: 0,
    url: DOWNLOAD_PAGE,
  }

  try {
    const res = await net.fetch(FEED, {
      cache: 'no-store',
      // 有些中间层只认这个头，两个都给上，反正是一次二十字节的请求
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return { ...base, error: `官网返回 HTTP ${res.status}`, detail: `HTTP ${res.status}` }

    const data = (await res.json()) as {
      version?: unknown
      assets?: { setup?: { size?: unknown } }
    }
    const latest = typeof data?.version === 'string' ? data.version.trim() : ''
    if (!latest) return { ...base, error: '官网上的版本号是空的', detail: FEED }

    return {
      current,
      latest,
      newer: compareVersion(latest, current) > 0,
      size: Number(data?.assets?.setup?.size) || 0,
      url: DOWNLOAD_PAGE,
    }
  } catch (e) {
    // 断网、超时、JSON 坏了都会走到这儿。
    // 界面上那行字是「原因，稍后再试」，所以原因必须短、且不能自相矛盾 ——
    // 早先写成「没连上官网（官网返回 HTTP 500）」，明明连上了却说没连上。
    const raw = e instanceof Error ? e.message : String(e)
    const timeout = /timeout|timed out|abort/i.test(raw)
    return {
      ...base,
      error: timeout ? '连接超时' : '连不上官网',
      detail: raw,
    }
  }
}

/**
 * 粘贴 / 拖入图片，自动存进工作区。
 *
 * 之前往笔记里放一张图是三步：先另存到磁盘、记住存哪儿了、再回来写
 * `![](…)` 并手打路径。绝大多数人最后会偷懒写成绝对路径或者干脆不放图。
 * 所以这里把整件事接过来：图进来 → 存进 attachments/ → 把相对引用写在光标处。
 *
 * 走相对路径（而不是绝对路径、也不是内嵌 base64）：
 *  - 绝对路径换台机器就全裂，备份/同步也没法搬；
 *  - base64 会把 md 文件撑成几 MB，用任何编辑器打开都卡，也搜不到内容。
 * 相对路径交给主进程的 nota-media:// 协议换算，预览里照样显示。
 */
import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { store } from '@/store'
import { escapeLinkDestination } from './markdown-commands'
import { tableFromClipboard } from './paste-table'

/** 只接住这两类。拖一个 .zip 进来不该变成一段没人认的 Markdown */
const MEDIA_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|mp4|webm|mov|m4v|ogv|mkv|avi)$/i
const VIDEO_RE = /\.(mp4|webm|mov|m4v|ogv|mkv|avi)$/i

interface Saved {
  rel: string
  name: string
  isVideo: boolean
}

function toast(text: string) {
  window.dispatchEvent(new CustomEvent('nota:toast', { detail: text }))
}

/**
 * 读成 base64。只用于**剪贴板里那张截图**——它在磁盘上没有实体，
 * 拿不到路径，只能把字节送过去。
 * 拖进来的文件走路径复制，不占这条路（几十 MB 的视频转成 base64 会白卡一下）。
 */
function readAsBase64(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const fr = new FileReader()
    fr.onload = () => {
      const s = String(fr.result ?? '')
      const cut = s.indexOf(',')
      resolve(cut >= 0 ? s.slice(cut + 1) : '')
    }
    fr.onerror = () => resolve(null)
    fr.readAsDataURL(file)
  })
}

/**
 * 粘贴进来的截图先压一道再存。
 *
 * 一张 4K 截图 3–5MB 起步。几十张下去，一个纯文本的笔记目录能撑到几百 MB，
 * 备份、同步、用别的编辑器打开都跟着变慢 —— 而这些图在笔记里最多也就显示成
 * 一栏宽，4000px 的原始像素一个也不会被看见。
 *
 * 三条边界，都是为了让这件事只发生在「确实该压」的时候：
 *  · 小于 1MB 不动 —— 压它省不下什么，还多一次有损编码；
 *  · 动图与矢量不动 —— GIF 一动就只剩第一帧，SVG 压了反而变大；
 *  · 压完不比原图小就还用原图 —— 有些 PNG 已经是压到极限的。
 */
const SHRINK_MIN_BYTES = 1024 * 1024
const SHRINK_MAX_EDGE = 1600

async function shrink(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) return file
  // GIF 一动就死，SVG 转位图只会更大，两者都不该碰
  if (/gif|svg/i.test(file.type)) return file
  if (file.size < SHRINK_MIN_BYTES) return file

  let bmp: ImageBitmap
  try {
    bmp = await createImageBitmap(file)
  } catch {
    return file
  }
  const long = Math.max(bmp.width, bmp.height)
  const k = long > SHRINK_MAX_EDGE ? SHRINK_MAX_EDGE / long : 1
  const w = Math.max(1, Math.round(bmp.width * k))
  const h = Math.max(1, Math.round(bmp.height * k))

  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const ctx = cv.getContext('2d')
  if (!ctx) {
    bmp.close()
    return file
  }
  ctx.drawImage(bmp, 0, 0, w, h)
  bmp.close()

  /* 有透明通道的图不能转成 JPEG（透明的地方会变黑），所以先扫一遍 alpha。
     扫的是**缩小后**的画布，代价很小。 */
  let hasAlpha = false
  try {
    const data = ctx.getImageData(0, 0, w, h).data
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 250) {
        hasAlpha = true
        break
      }
    }
  } catch {
    hasAlpha = true
  }

  const type = hasAlpha ? 'image/png' : 'image/jpeg'
  const blob = await new Promise<Blob | null>((resolve) =>
    cv.toBlob(resolve, type, hasAlpha ? undefined : 0.85),
  )
  if (!blob || blob.size >= file.size) return file

  const base = file.name.replace(/\.[^.]+$/, '') || 'image'
  const ext = hasAlpha ? '.png' : '.jpg'
  toast(
    `截图已压缩：${(file.size / 1024 / 1024).toFixed(1)}MB → ${(blob.size / 1024 / 1024).toFixed(1)}MB`,
  )
  return new File([blob], `${base}${ext}`, { type })
}

async function ingest(file: File, srcPath?: string): Promise<Saved | null> {
  const root = store.state.root
  if (!root) {
    toast('先打开一个工作区，图片才知道该存哪儿')
    return null
  }
  const ext = (srcPath ? srcPath.slice(srcPath.lastIndexOf('.')) : '') || extOf(file.name)
  if (srcPath) {
    return window.api.mediaSave(root, { srcPath })
  }
  // 剪贴板里的截图常常连文件名都没有（name 是 "image.png"），
  // 主进程那边会用时间戳另起一个，这里把扩展名给准就行。
  // 走 base64 这条路的就是粘贴进来的图，先压一道（见 shrink 的注释）；
  // 拖进来的文件走上面那条路按原样复制 —— 那是你已有的文件，不该动它。
  const bytes = await readAsBase64(await shrink(file))
  if (!bytes) {
    toast('这张图读不出来')
    return null
  }
  return window.api.mediaSave(root, { bytes, ext })
}

function extOf(name: string) {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i) : '.png'
}

/**
 * 把引用写进文档。
 *
 * 与工具栏「插入图片」用的是同一套补换行规则：图片是块级元素，
 * 光标停在半行中间时直接塞进去会和上一行的字挤在一起，连着放第二张
 * 又会叠在同一行。所以行中间先换行、写完再补一个换行。
 */
function insertMedia(view: EditorView, pos: number, saved: Saved) {
  const alt = saved.name.replace(/\.[^.]+$/, '')
  const snippet = saved.isVideo
    ? `<video src="${saved.rel}" controls></video>`
    : `![${alt}](${escapeLinkDestination(saved.rel)})`
  const line = view.state.doc.lineAt(pos)
  const blank = line.text.trim().length === 0
  const atStart = pos === line.from
  const prefix = blank || atStart ? '' : '\n'
  const text = prefix + snippet + '\n'
  view.dispatch({
    changes: { from: pos, to: pos, insert: text },
    selection: { anchor: pos + prefix.length + snippet.length },
    scrollIntoView: true,
  })
}

/** 拖进来的文件在 Electron 里有真实路径，用它直接复制，省一次 base64 */
function pathOfFile(file: File): string | undefined {
  const w = window as unknown as { pathForFile?: (f: File) => string }
  try {
    const p = w.pathForFile?.(file)
    return p || undefined
  } catch {
    return undefined
  }
}

/** 存一批文件并依次插入。`fromDrop` 决定是否去问真实路径 */
async function absorb(view: EditorView, files: File[], from: number, fromDrop: boolean) {
  let pos = Math.min(from, view.state.doc.length)
  let done = 0
  for (const file of files) {
    const saved = await ingest(file, fromDrop ? pathOfFile(file) : undefined)
    if (!saved) continue
    // 每插一张文档就变长，位置要按当前文档重新取，别用上一轮的偏移
    pos = Math.min(pos, view.state.doc.length)
    insertMedia(view, pos, saved)
    pos = view.state.selection.main.head + 1
    done += 1
  }
  if (done) toast(done > 1 ? `已存入 ${done} 个文件` : '已存入工作区')
}

/**
 * 把一张表写进文档。
 *
 * 表格是块级结构：光标停在半行中间时直接塞进去，第一行的竖线会和上一行的
 * 文字挤在同一段里，marked 就不把它当表格了。所以行中间先换行。
 * 选区有内容时直接替换 —— 粘贴本来就是「用新的盖掉选中的」。
 */
function insertTable(view: EditorView, block: string) {
  const sel = view.state.selection.main
  const line = view.state.doc.lineAt(sel.from)
  const blank = line.text.trim().length === 0
  const atStart = sel.from === line.from
  const prefix = blank || atStart ? '' : '\n'
  const text = prefix + block + '\n'
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: { anchor: sel.from + text.length },
    scrollIntoView: true,
    userEvent: 'input.paste',
  })
}

export function mediaDrop(): Extension {
  return EditorView.domEventHandlers({
    // 不拦 dragover 的话浏览器默认行为是「禁止放下」，drop 根本不会触发
    dragover(event) {
      const dt = (event as DragEvent).dataTransfer
      if (!dt) return false
      const has = Array.from(dt.items).some((it) => it.kind === 'file')
      if (!has) return false
      event.preventDefault()
      dt.dropEffect = 'copy'
      return true
    },

    /* 这两个 handler 必须是同步的：CodeMirror 的 domEventHandlers 不等
       Promise，而「要不要拦下这个事件」必须在事件当下就答。
       所以同步部分只做「判断 + preventDefault」，真正的存盘与插入交给
       下面那个 async 函数去跑。 */
    drop(event, view) {
      const dt = (event as DragEvent).dataTransfer
      const files = dt ? Array.from(dt.files) : []
      const media = files.filter((f) => MEDIA_RE.test(f.name))
      if (media.length === 0) return false
      event.preventDefault()

      // 落在哪儿就从哪儿插：按坐标换算成文档偏移，而不是一律插到光标处
      const de = event as DragEvent
      const at = view.posAtCoords({ x: de.clientX, y: de.clientY })
      void absorb(view, media, at ?? view.state.selection.main.from, true)
      return true
    },

    paste(event, view) {
      const dt = (event as ClipboardEvent).clipboardData
      if (!dt) return false
      const media = Array.from(dt.files).filter(
        (f) => MEDIA_RE.test(f.name) || f.type.startsWith('image/'),
      )
      if (media.length) {
        // 有图就不再走默认粘贴：否则会把图片的文件名当文本插进来
        event.preventDefault()
        void absorb(view, media, view.state.selection.main.from, false)
        return true
      }
      /* 没有文件，那可能是一张从网页或 Excel 复制来的表。
         `tableFromClipboard` 只在「整个剪贴板就是一张表」时才给东西，
         认不出来就返回 false —— 交回浏览器默认粘贴，纯文本照原样进。 */
      const table = tableFromClipboard(dt)
      if (!table) return false
      event.preventDefault()
      insertTable(view, table)
      return true
    },
  })
}

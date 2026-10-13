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
  // 主进程那边会用时间戳另起一个，这里把扩展名给准就行
  const bytes = await readAsBase64(file)
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
      const files = dt ? Array.from(dt.files) : []
      const media = files.filter((f) => MEDIA_RE.test(f.name) || f.type.startsWith('image/'))
      if (media.length === 0) return false
      // 有图就不再走默认粘贴：否则会把图片的文件名当文本插进来
      event.preventDefault()
      void absorb(view, media, view.state.selection.main.from, false)
      return true
    },
  })
}

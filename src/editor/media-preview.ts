import {
  Decoration,
  EditorView,
  WidgetType,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { StateEffect, StateField, type EditorState, type Range } from '@codemirror/state'

/**
 * 编辑区里的「图片 / 视频预览」小部件。
 *
 * 写 `![](attachments/x.png)` 时，源码里只有一行裸标记，看不到图。
 * 这一层在图片所在行的**下方**插一块缩略图，让人边写边看到效果，
 * 而文档本身仍然是纯 Markdown（小部件是 Decoration，不进文档）。
 *
 * 路径换算要走主进程（相对路径 → nota-media://），是异步的，
 * 所以做成「先占位、拿到 URL 后再重画」的两段式：
 *  - 第一遍：URL 未就绪 → 渲染一条安静的占位，同时发起解析
 *  - 解析完成：写进缓存，再用一个 StateEffect 通知视图重建装饰
 * 缓存以「工作区 + 相对路径」为 key，同一张图不会反复问主进程。
 *
 * ⚠️ 一个踩过的坑：整块高度的 widget（`block: true`）**必须**由 StateField 提供。
 * 早先这里写成 ViewPlugin，CodeMirror 直接抛
 * `RangeError: Block decorations may not be specified via plugins`，
 * 插件构造即失败，编辑器视图当场被销毁（后续所有断言都读到 "no view"）。
 * 现在拆成「StateField 提供装饰 + ViewPlugin 只负责在滚动/可视区变化时触发重算」，
 * 后者是官方对「依赖可视区的块级 widget」的标准做法。
 */

/** 单条图片语法：独占一行的 `![alt](url)`（允许前后空白与可选 title） */
const IMAGE_LINE = /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/

/** 以扩展名判断是不是视频 */
const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv)$/i

/** 已解析的 URL 缓存：key = `${base}::${rel}`；null 表示解析失败 */
const urlCache = new Map<string, string | null>()
/** 进行中的解析，避免同一张图并发问多次 */
const inflight = new Map<string, Promise<string | null>>()

/** 「媒体 URL 已就绪，请重画」——带在 transaction 里驱动 field 更新 */
const mediaResolved = StateEffect.define<void>()

/** 当前工作区根目录，由 EditorPane 在挂载/切换时写入 */
let currentBase = ''
/** 登记所有活着的视图，解析完成后统一唤醒 */
const liveViews = new Set<EditorView>()

function requestResolve(view: EditorView, base: string, rel: string) {
  const key = `${base}::${rel}`
  if (urlCache.has(key) || inflight.has(key)) return

  const api = (globalThis as { window?: Window }).window?.api
  if (!api?.resolveMedia) {
    urlCache.set(key, null)
    return
  }

  inflight.set(
    key,
    api
      .resolveMedia(base, rel)
      .then((url) => {
        urlCache.set(key, url ?? null)
        inflight.delete(key)
        // 唤醒所有视图：它们可能都在显示同一张图
        for (const v of liveViews) {
          if (v.dom.isConnected) v.dispatch({ effects: mediaResolved.of() })
        }
        return url ?? null
      })
      .catch(() => {
        urlCache.set(key, null)
        inflight.delete(key)
        return null
      }),
  )
}

/** 图片 / 视频缩略图 */
class MediaWidget extends WidgetType {
  constructor(
    readonly url: string | null,
    readonly alt: string,
    readonly isVideo: boolean,
    readonly rel: string,
  ) {
    super()
  }

  /** 同一张图（url + 类型 + alt）视为等价，避免无谓重绘 */
  eq(other: MediaWidget) {
    return other.url === this.url && other.isVideo === this.isVideo && other.alt === this.alt
  }

  toDOM() {
    const wrap = document.createElement('div')
    wrap.className = 'cm-md-media'

    if (!this.url) {
      // 未解析出来：留一条安静的占位，不显示破图标
      wrap.classList.add('is-pending')
      wrap.textContent = this.rel
      return wrap
    }

    if (this.isVideo) {
      const v = document.createElement('video')
      v.src = this.url
      v.controls = true
      v.preload = 'metadata'
      v.className = 'cm-md-media-el'
      wrap.appendChild(v)
    } else {
      const img = document.createElement('img')
      img.src = this.url
      img.alt = this.alt
      img.loading = 'lazy'
      img.className = 'cm-md-media-el'
      wrap.appendChild(img)
    }
    return wrap
  }

  /** 让小部件不吃事件：点击仍然落到编辑器（可以正常移动光标、选中） */
  ignoreEvent() {
    return false
  }
}

/** 扫描给定行区间，产出块级装饰 */
function buildDecos(state: EditorState, from: number, to: number, base: string): Range<Decoration>[] {
  const ranges: Range<Decoration>[] = []
  let pos = from

  while (pos <= to) {
    const line = state.doc.lineAt(pos)
    const m = IMAGE_LINE.exec(line.text)

    if (m) {
      const rel = m[2]
      const isVideo = VIDEO_EXT.test(rel)
      const key = `${base}::${rel}`
      const cached = urlCache.get(key)
      if (cached === undefined) {
        // 解析是异步的；这里拿不到 view，用 state 就行
        requestResolveByState(base, rel)
      }

      // 插在行尾之后，block 让它独占一行高度
      ranges.push(
        Decoration.widget({
          widget: new MediaWidget(cached ?? null, m[1], isVideo, rel),
          block: true,
          side: 1,
        }).range(line.to),
      )
    }

    if (line.to >= to) break
    pos = line.to + 1
  }

  return ranges
}

/** requestResolve 的变体：StateField 里没有 view，用 state 触发即可 */
function requestResolveByState(base: string, rel: string) {
  const key = `${base}::${rel}`
  if (urlCache.has(key) || inflight.has(key)) return

  const api = (globalThis as { window?: Window }).window?.api
  if (!api?.resolveMedia) {
    urlCache.set(key, null)
    return
  }

  inflight.set(
    key,
    api
      .resolveMedia(base, rel)
      .then((url) => {
        urlCache.set(key, url ?? null)
        inflight.delete(key)
        for (const v of liveViews) {
          if (v.dom.isConnected) v.dispatch({ effects: mediaResolved.of() })
        }
        return url ?? null
      })
      .catch(() => {
        urlCache.set(key, null)
        inflight.delete(key)
        return null
      }),
  )
}

/** 整篇文档 → 装饰集（初始建 + 文档变化时重建） */
function buildAll(state: EditorState, base: string): DecorationSet {
  const ranges = buildDecos(state, 0, state.doc.length, base)
  return Decoration.set(ranges, true)
}

/**
 * 块级 widget 的合法来源。
 * 文档变化 / 解析完成时重建；纯滚动（viewportChanged）不在这里处理，
 * 由下面的 ViewPlugin 用一个空 transaction 触发重算。
 */
const mediaField = StateField.define<DecorationSet>({
  create: (state) => buildAll(state, currentBase),
  update: (decos, tr) => {
    if (tr.docChanged || tr.effects.some((e) => e.is(mediaResolved))) {
      return buildAll(tr.state, currentBase)
    }
    return decos.map(tr.changes)
  },
  provide: (f) => EditorView.decorations.from(f),
})

/** 可视区变了要重扫（块级 widget 只扫可见行，长文档才不至于每帧全量扫描） */
const viewportTrigger = ViewPlugin.fromClass(
  class {
    constructor(private view: EditorView) {
      liveViews.add(view)
    }
    update(update: ViewUpdate) {
      if (update.viewportChanged && !update.docChanged) {
        // 空 transaction 里的 mediaResolved 会让 mediaField 重算
        const ranges = update.view.visibleRanges
        const hasImage = ranges.some(({ from, to }) => {
          let pos = from
          while (pos <= to) {
            const line = update.state.doc.lineAt(pos)
            if (IMAGE_LINE.test(line.text)) return true
            if (line.to >= to) break
            pos = line.to + 1
          }
          return false
        })
        if (hasImage) update.view.dispatch({ effects: mediaResolved.of() })
      }
    }
    destroy() {
      liveViews.delete(this.view)
    }
  },
)

/** 切换工作区时调用：清空失效缓存并重画 */
export function setMediaBase(base: string) {
  if (base === currentBase) return
  currentBase = base
  urlCache.clear()
  for (const v of liveViews) v.dispatch({ effects: mediaResolved.of() })
}

export const markdownMediaPreview = [mediaField, viewportTrigger]

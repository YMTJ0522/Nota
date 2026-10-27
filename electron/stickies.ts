/**
 * 便签的落盘。
 *
 * 便签和笔记库是**两套互不相干的东西**，这是整个功能成立的前提。
 *
 * 按 Alt+N 的那一刻，用户的笔记库可能挂在没插上的移动硬盘里、
 * 可能刚被换成另一个目录、也可能压根还没建过。如果便签也要先找到库
 * 才能落地，那一下就会弹「找不到工作区」——「想到就记」这件事当场碎掉。
 *
 * 所以便签一律存在 %LOCALAPPDATA%\Nota\stickies\ 下面，一个便签一个 .md。
 * 它不依赖库、不参与云同步、卸载重装也不碰。往库里搬是用户主动按
 * 「存为笔记」时才发生的事（saveToVault）。
 *
 * 单独成文件、不 import electron，是为了能脱壳测（scripts/verify-stickies.mjs）。
 */
import path from 'node:path'
import fs from 'node:fs/promises'

/** 便签目录。和 vault.json 一样拼 %LOCALAPPDATA%\Nota\，不走 userData */
export function stickyDir(localAppData: string): string {
  return path.join(localAppData, 'Nota', 'stickies')
}

/** index.json 里一条。位置尺寸只对「开着的便签」有意义，关掉后保留着也没坏处 */
export interface StickyMeta {
  id: string
  x?: number
  y?: number
  w?: number
  h?: number
  /** 钉在最上层 */
  pinned?: boolean
  /** 纸色 key（默认 'amber'） */
  color?: string
  createdAt: number
  updatedAt: number
  /** 归档时间：关掉但没删，能在列表里捞回来 */
  closedAt?: number
  /** 存为笔记后的相对路径，用来把按钮置成「已存入」 */
  savedTo?: string
  /**
   * 手打的标签。只活在这张便签自己的记录里，**不进笔记库的标签表**。
   *
   * 便签刻意和库解耦（见文件头），标签也一样：没有库的时候也得能打标签，
   * 否则「按一下记一句、顺手归个类」这件事就得先建库才能做。
   * 存为笔记时才把这些标签写成 frontmatter，那时候它们才成为库里的标签。
   */
  tags?: string[]
  /** 标记图标（技术栈 / emoji）。列表里一眼认出来，不用读标题 */
  icon?: { kind: 'brand' | 'emoji'; id: string }
  /**
   * 贴进来的图片，存的是便签目录下 `media/` 里的文件名。
   *
   * 不写进正文：正文底下那层镜像靠行高和 textarea 严格对齐，插一张图
   * 之后所有行都错位。所以图片挂在纸底部的一条托盘上，正文里一个字不提；
   * 存为笔记时才转成 Markdown 图片链接。
   */
  shots?: string[]
}

export interface StickyRecord extends StickyMeta {
  /** 首行摘要，列表用 */
  title: string
  /** 首行之后的一小段，免得列表里全是同一句话 */
  preview: string
  chars: number
}

const INDEX = 'index.json'

/**
 * index.json 的读改写全部串行。
 *
 * 多张便签同时关掉（Ctrl+Alt+Shift+N 收起全部）时，每个窗口各发一次
 * 「我关了」，五次读-改-写并发下必然互相覆盖，最后只剩一条记录 ——
 * 其余的便签会「消失」，但文件其实还在，属于最难查的那种错。
 */
let chain: Promise<unknown> = Promise.resolve()
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function readIndex(dir: string): Promise<StickyMeta[]> {
  try {
    const raw = await fs.readFile(path.join(dir, INDEX), 'utf8')
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    // 逐条挑字段：index.json 坏了或者被手改成别的东西，不该让整个列表空掉
    return arr.filter((m): m is StickyMeta => !!m && typeof m.id === 'string')
  } catch {
    return []
  }
}

/**
 * 原子写。直接 writeFile 到目标文件的话，进程正好在写到一半被抓去关机，
 * 留下的就是半截 json —— 下次启动所有便签的位置、归档状态全丢。
 * 先写 .tmp 再 rename，同目录内 rename 是原子的。
 */
async function writeAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, data, 'utf8')
  await fs.rename(tmp, file)
}

async function writeIndex(dir: string, metas: StickyMeta[]): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  await writeAtomic(path.join(dir, INDEX), `${JSON.stringify(metas, null, 2)}\n`)
}

/**
 * 文件名安全化。要拿去当 .md 的名字，Windows 这九个字符是硬禁止的，
 * 另外结尾的点和空格会被系统悄悄吞掉（然后「存了但没找到」）。
 */
export function safeName(raw: string): string {
  let s = raw
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // 去掉开头的 markdown 标题记号与列表符号，文件名里不该出现 "# "
  s = s.replace(/^[#>\-*\s]+/, '')
  s = s.replace(/[.\s]+$/, '')
  if (s.length > 40) s = s.slice(0, 40).trim()
  return s || '空白便签'
}

/**
 * 预览里不该出现 Markdown 记号。
 *
 * 「- [ ] 换成 alpine 基底」直接拼进一句话，读起来是「- 方括号 空 方括号」，
 * 那是源码不是内容。列表和墙上的卡片都靠这一条吃饭，所以在这里一次清干净。
 */
function plainLine(l: string): string {
  return (
    l
      .trim()
      /* 标题记号只认「# 加空格」。`#docker` 里的那个 # 是标签的一部分，
         去掉之后就认不出它是标签行，预览里会把它当成正文再念一遍 */
      .replace(/^#{1,6}\s+/, '')
      .replace(/^(?:[*+\-]|>)\s+/, '')
      .replace(/^\d+[.)]\s+/, '')
      .replace(/^\[[ xX]\]\s*/, '')
      .trim()
  )
}

/** 从正文里抠出列表要显示的两行：标题 + 预览，顺便数一下字数 */
function summarize(text: string): { title: string; preview: string; chars: number } {
  const chars = text.replace(/\s/g, '').length
  const lines = text.split(/\r?\n/)
  let title = ''
  for (const line of lines) {
    const t = line.replace(/^[#>\-*\s]+/, '').trim()
    if (t) {
      title = t.length > 60 ? `${t.slice(0, 60)}…` : t
      break
    }
  }
  const rest = lines
    .slice(Math.max(0, lines.findIndex((l) => l.replace(/^[#>\-*\s]+/, '').trim())))
    .slice(1)
    .map(plainLine)
    /* 一行只由标签组成的（就是正文里写的 `#docker`）跳过：那些标签
       会在条目和卡片下面单独显示一行，预览里再来一遍就是同一句话说两次 */
    .filter((l) => l && !/^(#[^\s#]+\s*)+$/.test(l))
    .join(' ')
  return {
    title: title || '空白便签',
    /* 220 而不是 90：便签墙上的一张卡片要显示到四五行为止。
       列表那一侧只用一行 ellipsis，多一点字数不影响它。 */
    preview: rest.length > 220 ? `${rest.slice(0, 220)}…` : rest,
    chars,
  }
}

function newId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/**
 * 列出全部便签，新的在前。includeClosed 为 false 时跳过已归档的。
 *
 * 「一张便签存在」的判据是 index.json 里有它的记录，不是磁盘上有没有 .md ——
 * 新建完还没打字的那张就是只有记录、没有文件。反过来，用户自己往目录里
 * 丢了个 .md 进来（备份还原、手动建），也要能看见，所以两路都扫。
 */
export async function listStickies(
  dir: string,
  opts: { includeClosed?: boolean } = {},
): Promise<StickyRecord[]> {
  const metas = await readIndex(dir)
  let files: string[] = []
  try {
    files = (await fs.readdir(dir)).filter((n) => n.endsWith('.md'))
  } catch {
    files = [] // 目录还没建
  }

  const known = new Set(metas.map((m) => m.id))
  const ids = [
    ...metas.map((m) => m.id),
    // 没登记过的文件按「刚发现的」排在后面
    ...files.map((n) => n.replace(/\.md$/, '')).filter((id) => !known.has(id)),
  ]
  const byId = new Map(metas.map((m) => [m.id, m]))
  const out: StickyRecord[] = []

  for (const id of ids) {
    const meta = byId.get(id)
    let text = ''
    try {
      text = await fs.readFile(path.join(dir, `${id}.md`), 'utf8')
    } catch {
      /* 新建但还没打字：没有文件是正常的 */
    }
    const s = summarize(text)
    out.push({
      id,
      createdAt: meta?.createdAt ?? 0,
      updatedAt: meta?.updatedAt ?? 0,
      ...(meta ?? {}),
      ...s,
    })
  }

  const filtered = opts.includeClosed === false ? out.filter((r) => !r.closedAt) : out
  filtered.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
  return filtered
}

export async function readSticky(dir: string, id: string): Promise<string> {
  try {
    return await fs.readFile(path.join(dir, `${id}.md`), 'utf8')
  } catch {
    return ''
  }
}

/**
 * 新建一张空便签，返回它的记录。
 * 注意这里**不写 .md** —— 新建了又不打字就关掉，不该在磁盘上留一个空文件。
 * 文件在第一次 writeSticky 时落盘。
 */
export async function createSticky(
  dir: string,
  opts: { x?: number; y?: number; w?: number; h?: number } = {},
): Promise<StickyRecord> {
  const id = newId()
  const now = Date.now()
  const meta: StickyMeta = {
    id,
    createdAt: now,
    updatedAt: now,
    pinned: true,
    color: 'amber',
    ...opts,
  }
  await serialize(async () => {
    const metas = await readIndex(dir)
    metas.push(meta)
    await writeIndex(dir, metas)
  })
  return { ...meta, title: '空白便签', preview: '', chars: 0 }
}

/** 写正文。空内容不落盘（只更新 meta 的时间），免得留下一堆空文件 */
export async function writeSticky(dir: string, id: string, text: string): Promise<boolean> {
  await fs.mkdir(dir, { recursive: true })
  if (text.trim()) {
    await writeAtomic(path.join(dir, `${id}.md`), text)
  }
  await serialize(async () => {
    const metas = await readIndex(dir)
    const i = metas.findIndex((m) => m.id === id)
    if (i >= 0) {
      metas[i].updatedAt = Date.now()
      // 动过内容就算重新开张了，归档标记撤掉
      delete metas[i].closedAt
      await writeIndex(dir, metas)
    } else {
      metas.push({
        id,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        pinned: true,
        color: 'amber',
      })
      await writeIndex(dir, metas)
    }
  })
  return true
}

/**
 * 可改的字段。每个字段都可以给 null —— 那是「删掉它」，见 patchSticky 的注释。
 */
export type StickyPatch = {
  [K in keyof Omit<StickyMeta, 'id' | 'createdAt'>]?:
    | Omit<StickyMeta, 'id' | 'createdAt'>[K]
    | null
}

/**
 * 改位置 / 尺寸 / 钉住 / 颜色 / 标签 / 图标 / 归档。patch 里没给的字段保持不动。
 *
 * **传 null = 删掉这个字段**。JSON 存不下 undefined，所以「把图标去掉」
 * 这件事没法用 undefined 表达——写成 icon: undefined 的话
 * JSON.stringify 会把它整个吞掉，旧图标下次读回来又回来了。
 */
export async function patchSticky(
  dir: string,
  id: string,
  patch: StickyPatch,
): Promise<StickyMeta | null> {
  return serialize(async () => {
    const metas = await readIndex(dir)
    const i = metas.findIndex((m) => m.id === id)
    if (i < 0) return null
    const next = { ...metas[i] } as Record<string, unknown>
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete next[k]
      else if (v !== undefined) next[k] = v
    }
    metas[i] = next as unknown as StickyMeta
    await writeIndex(dir, metas)
    return metas[i]
  })
}

/**
 * 重命名 = 改正文第一行。
 *
 * 便签的标题本来就是「第一行」，另设一个 name 字段会让列表上显示的名字
 * 和打开以后看到的第一行对不上——两个名字，迟早有一个是错的。
 *
 * 这里不走 writeSticky：那个函数动正文时会把 closedAt 撤掉（认为这张纸
 * 重新开张了）。但给一张已经收起来的便签改个名字，不该让它跳回「在桌面」。
 */
export async function renameSticky(
  dir: string,
  id: string,
  title: string,
): Promise<{ ok: boolean; error?: string }> {
  const t = title.replace(/\s+/g, ' ').trim()
  if (!t) return { ok: false, error: '标题不能为空' }

  const text = await readSticky(dir, id)
  const lines = text.split(/\r?\n/)
  const at = lines.findIndex((l) => l.replace(/^[#>\-*\s]+/, '').trim())
  const next = at < 0 ? t : (lines.splice(at, 1, t), lines.join('\n'))

  await fs.mkdir(dir, { recursive: true })
  await writeAtomic(path.join(dir, `${id}.md`), next)
  await serialize(async () => {
    const metas = await readIndex(dir)
    const i = metas.findIndex((m) => m.id === id)
    if (i >= 0) {
      metas[i].updatedAt = Date.now()
      await writeIndex(dir, metas)
    }
  })
  return { ok: true }
}

/**
 * 启动时对账。
 *
 * 进程被强杀、断电、或者用户在任务管理器里「结束任务」，开着的便签都来不及
 * 走关闭那一步（closedAt 是在收尾时写的）。下次启动这些记录看起来还「开着」，
 * 列表里显示成正在用的，可桌面上什么都没有 —— 用户点一下才弹出来，
 * 于是凭空多出一张不知道哪来的纸。
 *
 * 启动那一刻必然一张便签窗口都没有，所以这里可以放心地把它们全部归档。
 * 内容是空的那种（按了快捷键、看一眼、没写）直接删掉，不留痕迹。
 */
export async function reconcileOnBoot(
  dir: string,
): Promise<{ archived: number; dropped: number }> {
  const metas = await readIndex(dir)

  let archived = 0
  let dropped = 0
  const keep: StickyMeta[] = []

  for (const m of metas) {
    if (m.closedAt) {
      keep.push(m)
      continue
    }
    const text = await readSticky(dir, m.id)
    if (!text.trim()) {
      try {
        await fs.unlink(path.join(dir, `${m.id}.md`))
      } catch {
        /* 本来就没写过内容 */
      }
      dropped++
    } else {
      keep.push({ ...m, closedAt: Date.now() })
      archived++
    }
  }

  /* 目录里有、index 里没有的 .md 也要收编。
     备份还原、或者用户自己把一张纸拷进这个目录，都会留下这种孤儿文件 ——
     不登记的话它在列表里永远显示成「开着」，因为「没有 closedAt」被当成开着。 */
  let files: string[] = []
  try {
    files = (await fs.readdir(dir)).filter((n) => n.endsWith('.md'))
  } catch {
    files = []
  }
  const known = new Set(keep.map((m) => m.id))
  for (const f of files) {
    const id = f.replace(/\.md$/, '')
    if (known.has(id)) continue
    const text = await readSticky(dir, id)
    if (!text.trim()) {
      try {
        await fs.unlink(path.join(dir, f))
      } catch {
        /* 空文件，删不掉也不影响 */
      }
      dropped++
      continue
    }
    const now = Date.now()
    keep.push({
      id,
      createdAt: now,
      updatedAt: now,
      closedAt: now,
      pinned: true,
      color: 'amber',
    })
    archived++
  }

  if (archived || dropped) await writeIndex(dir, keep)
  return { archived, dropped }
}

/** 真删：文件 + 记录一起没 */
export async function removeSticky(dir: string, id: string): Promise<boolean> {
  let fileGone = true
  try {
    await fs.unlink(path.join(dir, `${id}.md`))
  } catch {
    fileGone = false // 本来就没写过内容
  }
  await serialize(async () => {
    const metas = await readIndex(dir)
    await writeIndex(
      dir,
      metas.filter((m) => m.id !== id),
    )
  })
  return fileGone
}

/**
 * 一批便签改同一个字段（多选之后「收起」「加标签」都走这里）。
 *
 * 不用循环调 patchSticky：那是「读 index → 改一条 → 写回」乘 N 遍，
 * 选十张纸就是十次读十次写，中途任一次抛错还会留下改了一半的状态。
 * 这里一次读、一次改、一次写。
 *
 * 字段语义和 patchSticky 完全一致：null 是删字段，undefined 是跳过。
 */
export async function batchPatch(
  dir: string,
  ids: string[],
  patch: StickyPatch,
): Promise<number> {
  const want = new Set(ids)
  if (!want.size) return 0
  return serialize(async () => {
    const metas = await readIndex(dir)
    let n = 0
    for (let i = 0; i < metas.length; i++) {
      if (!want.has(metas[i].id)) continue
      const next = { ...metas[i] } as Record<string, unknown>
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete next[k]
        else if (v !== undefined) next[k] = v
      }
      metas[i] = next as unknown as StickyMeta
      n++
    }
    if (n) await writeIndex(dir, metas)
    return n
  })
}

/** 一批便签真删。文件一个一个清（可能本来就没落过盘），索引只写一次 */
export async function removeStickies(dir: string, ids: string[]): Promise<number> {
  const want = new Set(ids)
  if (!want.size) return 0
  for (const id of want) {
    try {
      await fs.unlink(path.join(dir, `${id}.md`))
    } catch {
      /* 新建了没打字的，磁盘上本来就没有文件 */
    }
  }
  await serialize(async () => {
    const metas = await readIndex(dir)
    await writeIndex(
      dir,
      metas.filter((m) => !want.has(m.id)),
    )
  })
  return want.size
}

/* ── 删除：进回收站 ──
   和笔记那一边保持同一套语义：删掉不是消失，是「先挪到一边」。
   便签和库是解耦的（见文件头），所以垃圾桶也放在便签目录自己下面，
   不塞进某个工作区的 .nota/trash —— 换库、没建库都不该影响便签的生死。
   回收站页面把它和笔记的条目并在一起显示，恢复时再按 kind 分流。 */

const TRASH = '.trash'
const trashDir = (dir: string) => path.join(dir, TRASH)

/** 回收站能在页面上认出来的一行。key 带 `sticky:` 前缀，和笔记的 base64 key 区分 */
export interface StickyTrashEntry {
  key: string
  name: string
  deletedAt: number
  size: number
  isSticky: true
}

/**
 * 挪进垃圾桶：文件、记录、元信息一起留着。
 *
 * 记录（tags / color / icon / 尺寸）也要存一份 —— 只留 .md 的话，恢复回来
 * 纸色和标签全掉回默认，等于「恢复了一半」。没写过字的便签没有文件，
 * 但记录还得留着，不然它连一条空纸都不算。
 */
export async function trashSticky(dir: string, id: string): Promise<boolean> {
  const metas = await readIndex(dir)
  const meta = metas.find((m) => m.id === id)
  const text = await readSticky(dir, id)
  const td = trashDir(dir)
  await fs.mkdir(td, { recursive: true })
  try {
    await fs.rename(path.join(dir, `${id}.md`), path.join(td, `${id}.md`))
  } catch {
    /* 没写过内容：磁盘上本来就没有文件 */
  }
  const title = summarize(text).title
  await writeAtomic(
    path.join(td, `${id}.json`),
    `${JSON.stringify({ id, name: title, deletedAt: Date.now(), meta: meta ?? null }, null, 2)}\n`,
  )
  await serialize(async () => {
    const now = await readIndex(dir)
    await writeIndex(
      dir,
      now.filter((m) => m.id !== id),
    )
  })
  return true
}

export async function listStickyTrash(dir: string): Promise<StickyTrashEntry[]> {
  let files: string[] = []
  try {
    files = (await fs.readdir(trashDir(dir))).filter((n) => n.endsWith('.json'))
  } catch {
    return []
  }
  const out: StickyTrashEntry[] = []
  for (const f of files) {
    const id = f.slice(0, -5)
    try {
      const j = JSON.parse(await fs.readFile(path.join(trashDir(dir), f), 'utf8'))
      const size = await fs
        .stat(path.join(trashDir(dir), `${id}.md`))
        .then((s) => s.size, () => 0)
      out.push({
        key: `sticky:${id}`,
        name: typeof j?.name === 'string' && j.name ? j.name : '空白便签',
        deletedAt: Number(j?.deletedAt) || 0,
        size,
        isSticky: true,
      })
    } catch {
      /* 元信息坏了就跳过这一条 */
    }
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt)
}

/**
 * 从垃圾桶捞回来。
 *
 * 恢复的这张纸按「已收起」放回列表：它被删的时候多半是收起的，而直接
 * 摊到桌面上会让用户以为删掉的东西自己弹出来了。想接着写就点一下。
 */
export async function restoreSticky(dir: string, key: string): Promise<boolean> {
  const id = key.replace(/^sticky:/, '')
  const td = trashDir(dir)
  let meta: StickyMeta | null = null
  try {
    const j = JSON.parse(await fs.readFile(path.join(td, `${id}.json`), 'utf8'))
    meta = (j?.meta ?? null) as StickyMeta | null
  } catch {
    /* 没有元信息也能把文件捞回来 */
  }
  await fs.mkdir(dir, { recursive: true })
  try {
    await fs.rename(path.join(td, `${id}.md`), path.join(dir, `${id}.md`))
  } catch {
    /* 本来就没有文件 */
  }
  await serialize(async () => {
    const metas = await readIndex(dir)
    if (metas.some((m) => m.id === id)) return
    const now = Date.now()
    metas.push(meta ?? { id, createdAt: now, updatedAt: now, pinned: true, color: 'amber' })
    await writeIndex(dir, metas)
  })
  await fs.rm(path.join(td, `${id}.json`), { force: true })
  return true
}

/** 彻底删掉一条（顺带清掉它的图片；不然贴过图的纸删十次就攒下几十兆垃圾） */
export async function purgeStickyTrash(dir: string, key: string): Promise<boolean> {
  const id = key.replace(/^sticky:/, '')
  const td = trashDir(dir)
  await fs.rm(path.join(td, `${id}.md`), { force: true })
  await fs.rm(path.join(td, `${id}.json`), { force: true })
  await removeShotFiles(dir, id)
  return true
}

export async function emptyStickyTrash(dir: string): Promise<boolean> {
  const td = trashDir(dir)
  let files: string[] = []
  try {
    files = await fs.readdir(td)
  } catch {
    return true
  }
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    await removeShotFiles(dir, f.slice(0, -5))
  }
  await fs.rm(td, { recursive: true, force: true })
  return true
}

/* ── 贴进来的图片 ──
   正文是纯文本、底下还压着一层必须逐行对齐的镜像（见 StickyNote.vue）。
   图片要是插进正文，那层的行高就再也对不上了 —— 所以图单独放，
   挂在纸的底部一条托盘里，正文里只字不提。存为笔记时再转成 Markdown。 */

const MEDIA = 'media'

export function shotPath(dir: string, name: string): string {
  return path.join(dir, MEDIA, name)
}

async function removeShotFiles(dir: string, id: string): Promise<void> {
  const mdir = path.join(dir, MEDIA)
  let files: string[] = []
  try {
    files = await fs.readdir(mdir)
  } catch {
    return
  }
  for (const f of files) {
    if (!f.startsWith(`${id}-`)) continue
    await fs.rm(path.join(mdir, f), { force: true })
  }
}

export async function addShot(
  dir: string,
  id: string,
  data: Uint8Array,
  ext: string,
): Promise<{ ok: boolean; name?: string; shots?: string[]; error?: string }> {
  const safeExt = /^[a-z0-9]{2,5}$/i.test(ext) ? ext.toLowerCase() : 'png'
  const mdir = path.join(dir, MEDIA)
  await fs.mkdir(mdir, { recursive: true })
  const name = `${id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}.${safeExt}`
  await fs.writeFile(path.join(mdir, name), data)
  const cur = (await readIndex(dir)).find((m) => m.id === id)
  const shots = [...(cur?.shots ?? []), name]
  const r = await patchSticky(dir, id, { shots })
  if (!r) return { ok: false, error: '这张便签已经不在了' }
  return { ok: true, name, shots }
}

export async function removeShot(dir: string, id: string, name: string): Promise<string[]> {
  // 只认这张纸自己目录下的文件名，别让一条构造出来的路径删到别处去
  if (!name.startsWith(`${id}-`) || name.includes('/') || name.includes('\\')) {
    return (await readIndex(dir)).find((m) => m.id === id)?.shots ?? []
  }
  await fs.rm(shotPath(dir, name), { force: true })
  const cur = (await readIndex(dir)).find((m) => m.id === id)
  const shots = (cur?.shots ?? []).filter((n) => n !== name)
  await patchSticky(dir, id, { shots })
  return shots
}

/** 回收站里的便签在页面上要能看出是便签；恢复后列表也要立刻反映 */
export function isStickyTrashKey(key: string): boolean {
  return key.startsWith('sticky:')
}

/**
 * 把标签写成 frontmatter 顶到正文前面。用户自己已经写了 frontmatter
 * （便签里手打 `---` 块）就不碰它——两段 frontmatter 会让解析器只认第一段，
 * 用户写的那些字段当场失效。`\---` 也算分隔符，跟导出/预览那边同一个判据。
 */
function withTags(text: string, tags: string[]): string {
  if (!tags.length) return text
  if (/^(---|\\---)\r?\n/.test(text)) return text
  return `---\ntags: [${tags.join(', ')}]\n---\n\n${text}`
}

/**
 * 把一张便签搬进笔记库。
 *
 * 写进 <库>/便签/ 子目录，不散在库根上 —— 便签是速记的产物，
 * 混进用户自己整理好的目录结构里会很难看。同名自动加 -2 -3。
 *
 * **存完默认把这张纸收起来。** 以前只补一个 savedTo 就完事，纸还留在
 * 桌面上；用上一个月，列表里堆的全是「已经进了库、却还赖着不走」的尸体，
 * 而「已收起」「已存入」两枚状态又叠在一起，越看越乱。搬进库本来就是
 * 这张纸的终点，终点之后就该收起来。想留着继续写，调用方传 archive: false
 * （或者存完立刻「撤销」）。
 *
 * 返回相对库根的路径（"便签/xxx.md"），界面拿它显示「已存入」。
 */
export async function saveToVault(
  dir: string,
  id: string,
  vaultRoot: string,
  opts: { archive?: boolean } = {},
): Promise<{ ok: boolean; rel?: string; error?: string; archived?: boolean }> {
  const text = await readSticky(dir, id)
  const meta = (await readIndex(dir)).find((m) => m.id === id)
  const shots = meta?.shots ?? []
  // 只贴了图、一个字没写，也是一张有内容的纸
  if (!text.trim() && !shots.length) return { ok: false, error: '这张便签还是空的' }

  /* 便签自己打的标签跟着搬进库里。便签是速记的纸，笔记才是长期存放的地方；
     标记在搬家这一步丢掉的话，用户在列表里做的那点分类就白做了。 */
  const tags = meta?.tags ?? []

  const targetDir = path.join(vaultRoot, '便签')
  try {
    await fs.mkdir(targetDir, { recursive: true })
  } catch (e) {
    return { ok: false, error: `建不了「便签」目录：${String(e)}` }
  }

  const firstLine = text.split(/\r?\n/).find((l) => l.trim()) ?? '便签'
  const base = safeName(firstLine)

  /* 图片跟着搬进库的 attachments/。
     便签目录里的那份图笔记引用不了（不在库里、路径也不算相对），所以复制一份；
     是复制不是搬走 —— 这张纸如果留着继续写，底下那条托盘不该当场裂掉。 */
  let imgMd = ''
  if (shots.length) {
    const adir = path.join(vaultRoot, 'attachments')
    try {
      await fs.mkdir(adir, { recursive: true })
    } catch (e) {
      return { ok: false, error: `建不了 attachments 目录：${String(e)}` }
    }
    const lines: string[] = []
    for (let i = 0; i < shots.length; i++) {
      const src = shotPath(dir, shots[i])
      const ext = (path.extname(shots[i]) || '.png').toLowerCase()
      let dstName = `${base}-图${i + 1}${ext}`
      for (let n = 2; n < 100; n++) {
        try {
          await fs.copyFile(src, path.join(adir, dstName), fs.constants.COPYFILE_EXCL)
          break
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code
          if (code !== 'EEXIST') {
            /* 图没了（用户手动清过 media 目录）就跳过它，别让整次存为笔记失败 */
            dstName = ''
            break
          }
          dstName = `${base}-图${i + 1}-${n}${ext}`
        }
      }
      if (dstName) lines.push(`![](attachments/${dstName})`)
    }
    if (lines.length) imgMd = `\n\n${lines.join('\n')}`
  }

  const body = withTags(text, tags) + imgMd
  let name = `${base}.md`
  for (let n = 2; n < 100; n++) {
    try {
      // wx：同名就换下一个，绝不覆盖用户已有的笔记
      await fs.writeFile(path.join(targetDir, name), body, { encoding: 'utf8', flag: 'wx' })
      const rel = `便签/${name}`
      const archive = opts.archive !== false
      const patch: StickyPatch = { savedTo: rel }
      if (archive) patch.closedAt = Date.now()
      await patchSticky(dir, id, patch)
      return { ok: true, rel, archived: archive }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') return { ok: false, error: String(e) }
      name = `${base}-${n}.md`
    }
  }
  return { ok: false, error: '同名的笔记太多了，换个开头再存' }
}

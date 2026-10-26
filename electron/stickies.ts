/**
 * 便签的落盘。
 *
 * 便签和笔记库是**两套互不相干的东西**，这是整个功能成立的前提。
 *
 * 按 Ctrl+Alt+N 的那一刻，用户的笔记库可能挂在没插上的移动硬盘里、
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
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
  return {
    title: title || '空白便签',
    preview: rest.length > 90 ? `${rest.slice(0, 90)}…` : rest,
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
 * 返回相对库根的路径（"便签/xxx.md"），界面拿它显示「已存入」。
 */
export async function saveToVault(
  dir: string,
  id: string,
  vaultRoot: string,
): Promise<{ ok: boolean; rel?: string; error?: string }> {
  const text = await readSticky(dir, id)
  if (!text.trim()) return { ok: false, error: '这张便签还是空的' }

  /* 便签自己打的标签跟着搬进库里。便签是速记的纸，笔记才是长期存放的地方；
     标记在搬家这一步丢掉的话，用户在列表里做的那点分类就白做了。 */
  const tags = (await readIndex(dir)).find((m) => m.id === id)?.tags ?? []
  const body = withTags(text, tags)

  const targetDir = path.join(vaultRoot, '便签')
  try {
    await fs.mkdir(targetDir, { recursive: true })
  } catch (e) {
    return { ok: false, error: `建不了「便签」目录：${String(e)}` }
  }

  const firstLine = text.split(/\r?\n/).find((l) => l.trim()) ?? '便签'
  const base = safeName(firstLine)
  let name = `${base}.md`
  for (let n = 2; n < 100; n++) {
    try {
      // wx：同名就换下一个，绝不覆盖用户已有的笔记
      await fs.writeFile(path.join(targetDir, name), body, { encoding: 'utf8', flag: 'wx' })
      const rel = `便签/${name}`
      await patchSticky(dir, id, { savedTo: rel })
      return { ok: true, rel }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') return { ok: false, error: String(e) }
      name = `${base}-${n}.md`
    }
  }
  return { ok: false, error: '同名的笔记太多了，换个开头再存' }
}

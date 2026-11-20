/**
 * AI SDK 引擎：用 Vercel AI SDK 的 streamText + tools 跑 agent 循环。
 *
 * 为什么要重做这一层。原来那套循环是手写的：渲染进程发一次请求，主进程
 * 只做 SSE 转发，回来自己在 store 里解析 tool_calls、逐个执行、拼回对话再
 * 发下一次。手写的好处是能迁就各种不标准的网关，坏处是每个环节都要自己
 * 兜底——刚才那种「模型把工具申请打成半截 JSON」「一轮申请多个工具、结果
 * 顺序对不上」「到步数上限怎么收尾」，全靠补丁堆着，越堆越难改。
 *
 * 现在交给 SDK：它负责把工具定义编进请求、流式解析 tool_call 碎片、按
 * 顺序执行、把结果作为 tool 消息喂回去、直到模型不再申请工具。我们只管
 * 三件事——工具干什么、事件怎么报给界面、出错怎么翻译成人话。
 *
 * 这个模块不 import electron，也不碰 fs：宿主能力全部由 host 注进来。
 * 这样 scripts/verify-agent-sdk.mjs 可以拿假 host 直接跑，不必开窗口。
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { jsonSchema, stepCountIs, streamText, tool } from 'ai'
import { localKeywords, mergeHits, rankHits, type WebHitLike } from '../src/store/webPipeline'

export interface SdkAgentConfig {
  baseUrl: string
  model: string
  apiKey: string
  /** 全局指令 + 本轮注入的笔记与联网资料 */
  system: string
  temperature: number
  /** 单步输出上限。不给就用服务端默认 */
  maxOutputTokens?: number
}

export interface SearchHit {
  path: string
  name: string
  count: number
  snippets: string[]
}

/**
 * 宿主能力。全部由主进程注入——
 * 这个文件只描述「要什么」，不关心「从哪来」。
 */
export interface AgentHost {
  /** 工作区根目录；没有工作区时笔记类工具直接拒绝 */
  root: string | null
  /** 用户当前打开的笔记（绝对路径） */
  activePath: string | null
  /** 读文件正文 */
  readFile(p: string): Promise<string>
  /** 写文件正文（自动建父目录） */
  writeFile(p: string, content: string): Promise<void>
  /** 新建笔记，返回绝对路径 */
  createNote(dir: string, name: string): Promise<string>
  /** 工作区里的全部笔记（绝对路径） */
  listNotes(): Promise<string[]>
  /** 工作区全文检索 */
  searchNotes(root: string, q: string): Promise<SearchHit[]>
  /** 一次网页检索（主进程的搜索引擎） */
  webSearch(q: string): Promise<{ ok: boolean; hits?: WebHitLike[]; error?: string }>
  /** 当前编辑器的未保存正文 */
  getDraft(): string
  /** 改当前编辑器的正文（工具改完之后界面要跟着变） */
  setDraft(text: string): void
}

/** 推给界面的事件。字段名压到最短——每一条都要走一次 IPC */
export type AgentEvent =
  /** 阶段提示（面板顶部那行小字） */
  | { t: 'stage'; text: string }
  | { t: 'text'; text: string }
  | { t: 'reasoning'; text: string }
  /** 某一步开始。id 用工具调用 id，和 end 配对 */
  | { t: 'tool-start'; id: string; name: string; detail: string }
  | { t: 'tool-end'; id: string; ok: boolean; detail: string }
  /** 联网命中的来源，界面拿去渲染脚注 */
  | { t: 'sources'; hits: { title: string; url: string }[] }
  /** 当前笔记被工具改过，正文整段换新 */
  | { t: 'draft'; text: string }

export interface SdkAgentResult {
  ok: boolean
  text: string
  reasoning: string
  sources: { title: string; url: string }[]
  toolUses: number
  error?: string
}

/** 工具名 → 面板上的中文标签 */
const LABELS: Record<string, string> = {
  list_notes: '列出笔记',
  read_note: '读取笔记',
  search_notes: '搜索笔记',
  create_note: '新建笔记',
  edit_note: '修改笔记',
  web_search: '联网检索',
}

/** 单篇笔记喂给模型的字数上限。再长也不是「读一篇笔记」而是「喂一本书」 */
const READ_LIMIT = 12000

export function relOf(root: string | null, p: string): string {
  if (!root) return p
  const r = root.replace(/[\\/]+$/, '')
  return p.replace(/\\/g, '/').startsWith(r.replace(/\\/g, '/') + '/')
    ? p.replace(/\\/g, '/').slice(r.replace(/\\/g, '/').length + 1)
    : p
}

/**
 * 把模型给的路径落实成绝对路径。跑到工作区外面的一律拒绝——
 * agent 的手不能伸到库外面去。
 */
function resolveIn(root: string | null, raw: string): string | null {
  if (!root) return null
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const r = root.replace(/[\\/]+$/, '')
  let p = String(raw ?? '').trim()
  if (!p) return null
  if (!/^([a-zA-Z]:|\\\\|\/)/.test(p)) p = `${r}/${p.replace(/^[\\/]+/, '')}`
  const np = norm(p)
  const nr = norm(r)
  return np === nr || np.startsWith(nr + '/') ? p.replace(/\\/g, '/') : null
}

/** 工具参数里最有信息量的几个值，摆在面板的步骤旁边 */
export function toolDetail(name: string, input: unknown): string {
  const a = (input ?? {}) as Record<string, unknown>
  const parts: string[] = []
  for (const k of ['query', 'path', 'filter', 'name', 'dir', 'find']) {
    const v = a[k]
    if (typeof v === 'string' && v) {
      parts.push(v.length > 30 ? `${v.slice(0, 30)}…` : v)
      if (parts.length >= 2) break
    }
  }
  if (!parts.length && name === 'web_search') return ''
  return parts.join(' · ')
}

/**
 * 自定义 fetch：套一层「localhost ↔ 127.0.0.1 互换重试」。
 *
 * Windows 上 localhost 会先解析到 IPv6 的 ::1，而 Ollama / LM Studio 只
 * 监听 IPv4，表现就是同一个地址时而能连时而不能。只对「连不上」重试，
 * 服务器已经回话（哪怕 4xx）就不再换地址，否则同一次提问会被送两遍。
 */
type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

/** provider 的 fetch 入参可能是 URL / Request，统一收敛成字符串再交出去 */
function stringFetch(f: FetchImpl): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    return f(url, init)
  }) as typeof fetch
}

function swapHostOf(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.hostname === 'localhost') u.hostname = '127.0.0.1'
    else if (u.hostname === '127.0.0.1') u.hostname = 'localhost'
    else return null
    return u.toString()
  } catch {
    return null
  }
}

function resilientFetch(base: FetchImpl): FetchImpl {
  return async (url, init) => {
    try {
      return await base(url, init)
    } catch (e) {
      const alt = swapHostOf(url)
      if (!alt) throw e
      return await base(alt, init)
    }
  }
}

/** 接口地址归一化：削掉末尾斜杠和误粘进来的 /chat/completions */
export function normalizeBase(baseUrl: string): string {
  return String(baseUrl ?? '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/+$/, '')
}

/** 模型那边胡说的工具名，返回一句能让它自己纠正的话 */
function unknownTool(name: string): string {
  return `未知工具：${name}。可用的工具：${Object.keys(LABELS).join('、')}`
}

/**
 * 造工具集。
 *
 * 每个 execute 都**不抛异常**：失败原因当普通文本返回，模型看到才知道该
 * 怎么纠正，面板上也能看到这一步是红的。真抛出去整轮就断了。
 */
function makeTools(host: AgentHost, emit: (e: AgentEvent) => void, webHits: WebHitLike[]) {
  return {
    list_notes: tool({
      description: '列出当前工作区里的笔记（名称与相对路径）。需要找笔记、了解库里有什么时用。',
      inputSchema: jsonSchema<{ filter?: string }>({
        type: 'object',
        properties: { filter: { type: 'string', description: '可选，按名称过滤的关键词' } },
      }),
      execute: async ({ filter }) => {
        if (!host.root) return '没有打开的工作区，列不了笔记'
        const all = await host.listNotes()
        const f = String(filter ?? '').trim().toLowerCase()
        const picked = f ? all.filter((p) => relOf(host.root, p).toLowerCase().includes(f)) : all
        if (!picked.length) return f ? `没有名称包含「${f}」的笔记` : '工作区里还没有笔记'
        const cap = 80
        const lines = picked.slice(0, cap).map((p) => `- ${relOf(host.root, p)}`)
        return `共 ${picked.length} 篇${picked.length > cap ? `，只列出前 ${cap} 篇` : ''}：\n${lines.join('\n')}`
      },
    }),

    read_note: tool({
      description: '读一篇笔记的正文。不传 path 读的是用户当前打开的笔记。',
      inputSchema: jsonSchema<{ path?: string }>({
        type: 'object',
        properties: { path: { type: 'string', description: '笔记的相对路径；省略则读当前笔记' } },
      }),
      execute: async ({ path: raw }) => {
        const p = String(raw ?? '').trim()
        const useCurrent = !p || (host.activePath && p.replace(/\\/g, '/') === host.activePath.replace(/\\/g, '/'))
        let abs: string
        let text: string
        if (useCurrent) {
          if (!host.activePath) return '当前没有打开任何笔记，也没给 path。先用 list_notes 找到目标'
          abs = host.activePath
          text = host.getDraft()
        } else {
          const resolved = resolveIn(host.root, p)
          if (!resolved) return `路径不在工作区里：${p}`
          abs = resolved
          text = await host.readFile(resolved)
        }
        const trimmed = (text ?? '').trim()
        if (!trimmed) return `「${relOf(host.root, abs)}」是空的`
        if (text.length > READ_LIMIT)
          return `「${relOf(host.root, abs)}」正文太长，以下是前 ${READ_LIMIT} 字：\n${text.slice(0, READ_LIMIT)}\n（后文被截断；需要的话我可以按更小的段落给你）`
        return `「${relOf(host.root, abs)}」：\n${text}`
      },
    }),

    search_notes: tool({
      description: '按关键词全文检索工作区里的所有笔记，返回命中文件与片段。',
      inputSchema: jsonSchema<{ query: string }>({
        type: 'object',
        properties: { query: { type: 'string', description: '检索词' } },
        required: ['query'],
      }),
      execute: async ({ query }) => {
        const q = String(query ?? '').trim()
        if (!q) return '检索词是空的'
        if (!host.root) return '没有打开的工作区，搜不了笔记'
        const hits = await host.searchNotes(host.root, q)
        if (!hits.length) return `没有笔记包含「${q}」`
        return hits
          .map((h) => `- ${relOf(host.root, h.path)}（命中 ${h.count} 次）\n    ${h.snippets.join('\n    ')}`)
          .join('\n')
      },
    }),

    create_note: tool({
      description: '在工作区里新建一篇笔记并写入 Markdown 内容。',
      inputSchema: jsonSchema<{ name: string; content?: string; dir?: string }>({
        type: 'object',
        properties: {
          name: { type: 'string', description: '笔记名（不带 .md）' },
          content: { type: 'string', description: '笔记的 Markdown 正文' },
          dir: { type: 'string', description: '可选，目标文件夹的相对路径，默认工作区根目录' },
        },
        required: ['name'],
      }),
      execute: async ({ name, content, dir }) => {
        const noteName = String(name ?? '').trim()
        if (!noteName) return '没有给笔记名'
        if (!host.root) return '没有打开的工作区，建不了笔记'
        let target = host.root
        const rawDir = String(dir ?? '').trim()
        if (rawDir) {
          const resolved = resolveIn(host.root, rawDir)
          if (!resolved) return `目标文件夹不在工作区里：${rawDir}`
          target = resolved
        }
        const created = await host.createNote(target, noteName)
        const body = String(content ?? '')
        if (body) await host.writeFile(created, body)
        return `已创建「${relOf(host.root, created)}」${body ? `，写入了 ${body.length} 字` : '（空笔记）'}`
      },
    }),

    edit_note: tool({
      description:
        '修改一篇笔记：把正文中的一段原文替换成另一段。改动前应先用 read_note 核对原文。不传 path 修改的是当前笔记。',
      inputSchema: jsonSchema<{
        path?: string
        find: string
        replace: string
        replace_all?: boolean
      }>({
        type: 'object',
        properties: {
          path: { type: 'string', description: '笔记的相对路径；省略则改当前笔记' },
          find: { type: 'string', description: '要被替换的原文，必须与正文完全一致（含空格换行）' },
          replace: { type: 'string', description: '替换成的内容，空串表示删除' },
          replace_all: { type: 'boolean', description: '原文出现多次时是否全部替换；默认只允许命中一处' },
        },
        required: ['find', 'replace'],
      }),
      execute: async ({ path: raw, find, replace, replace_all }) => {
        const needle = String(find ?? '')
        const repl = String(replace ?? '')
        if (!needle) return '没有给要替换的原文（find）'
        const p = String(raw ?? '').trim()
        const useCurrent = !p || (host.activePath && p.replace(/\\/g, '/') === host.activePath.replace(/\\/g, '/'))
        let abs: string
        let text: string
        if (useCurrent) {
          if (!host.activePath) return '当前没有打开任何笔记，也没给 path，改不了'
          abs = host.activePath
          text = host.getDraft()
        } else {
          const resolved = resolveIn(host.root, p)
          if (!resolved) return `路径不在工作区里：${p}`
          abs = resolved
          text = await host.readFile(resolved)
        }
        const total = text.split(needle).length - 1
        if (total === 0)
          return `原文里没有找到这段文字（开头 60 字：${needle.slice(0, 60)}）。先用 read_note 核对原文——find 必须与正文完全一致，含空格和换行。`
        if (total > 1 && replace_all !== true)
          return `这段文字出现了 ${total} 次。请把 find 扩得更长（保证只命中一处），或者把 replace_all 设为 true。`
        const next = text.split(needle).join(repl)
        if (useCurrent) {
          /* 当前这篇走宿主的草稿：编辑器盯的是它，改完立刻能看见。
             写盘交给界面那边（它有自己的脏标记与自动保存节奏）。 */
          host.setDraft(next)
          emit({ t: 'draft', text: next })
        } else {
          await host.writeFile(abs, next)
        }
        return `已替换 ${total} 处（「${relOf(host.root, abs)}」）`
      },
    }),

    web_search: tool({
      description: '联网检索资料。需要更细的网页资料、或系统给的资料没覆盖到时用，一次够用就别反复搜。',
      inputSchema: jsonSchema<{ query: string }>({
        type: 'object',
        properties: { query: { type: 'string', description: '检索词，用最短的关键词' } },
        required: ['query'],
      }),
      execute: async ({ query }) => {
        const q = String(query ?? '').trim()
        if (!q) return '检索词是空的'
        /* 模型给的词常常要么太窄（整句口语）要么太宽（一个词），单跑一路
           召回很差。和渲染层那套一样：本地规则再拆两路，三路并发、去重、
           按相关性排序，只把最相关的几条交给它读。 */
        /* 本地拆的词可能和原词撞（本身就是关键词时），先去重再并发，
           否则同一个词会被搜两遍、白多一次请求 */
        const terms = [...new Set([q, ...localKeywords(q)].map((t) => t.trim()).filter(Boolean))].slice(0, 3)
        const lists = await Promise.all(
          terms.map((t) => host.webSearch(t).then((r) => r.hits ?? []).catch(() => [])),
        )
        const ranked = rankHits(mergeHits(lists), terms).slice(0, 6)
        if (!ranked.length) return '没检索到结果。请依据已有知识回答，并说明没有联网资料。'
        for (const h of ranked) if (!webHits.some((x) => x.url === h.url)) webHits.push(h)
        emit({ t: 'sources', hits: ranked.map((h) => ({ title: h.title, url: h.url })) })
        return ranked
          .map((h, i) => `[${i + 1}] ${h.title}\n${h.url}\n${h.snippet}`)
          .join('\n\n')
      },
    }),
  }
}

/** 从 SDK 的错误对象里捞出所有可读的原文。连续失败会被包成 RetryError，
    真正的原因压在内层，判断「服务是不是不认 tools」得往里看 */
function errorText(e: unknown): string {
  const o = e as
    | { message?: string; lastError?: { message?: string }; responseBody?: string }
    | null
  return [o?.message, o?.lastError?.message, o?.responseBody].filter(Boolean).join(' ')
}

/**
 * 跑一轮完整的 agent 对话。
 *
 * 和手写循环最大的不同：这里只有一次 streamText 调用。中间那些「等模型
 * 申请工具 → 跑 → 把结果喂回去 → 再问一步」全在 SDK 内部完成，我们通过
 * fullStream 一个事件一个事件地往外报。
 */
export async function runAgent(
  cfg: SdkAgentConfig,
  opts: {
    messages: { role: 'user' | 'assistant'; content: string }[]
    host: AgentHost
    emit: (e: AgentEvent) => void
    maxSteps?: number
    fetchImpl: FetchImpl
    signal?: AbortSignal
    /** 错误翻译。主进程注入它才能复用「密钥没填 / 填成模型名 / 被拒」那套精细文案 */
    describeError?: (e: unknown) => string
  },
): Promise<SdkAgentResult> {
  const { host, emit, messages } = opts
  const describe = opts.describeError ?? ((e: unknown) => humanize(e))
  const webHits: WebHitLike[] = []
  const maxSteps = Math.max(1, opts.maxSteps ?? 6)

  const provider = createOpenAICompatible({
    name: 'nota',
    baseURL: normalizeBase(cfg.baseUrl),
    apiKey: cfg.apiKey.trim() || undefined,
    fetch: stringFetch(resilientFetch(opts.fetchImpl)),
  })

  let text = ''
  let reasoning = ''
  let toolUses = 0
  /** 流里报的错误。留原始对象，最后统一翻成人话 */
  let errObj: unknown = null

  /** 跑一次流。带不带工具由入参决定，回退普通对话时复用同一个函数 */
  const attempt = async (withTools: boolean) => {
    const res = streamText({
      model: provider.chatModel(cfg.model),
      system: cfg.system,
      messages,
      ...(withTools
        ? { tools: makeTools(host, emit, webHits), stopWhen: stepCountIs(maxSteps) }
        : {}),
      temperature: cfg.temperature,
      ...(cfg.maxOutputTokens ? { maxOutputTokens: cfg.maxOutputTokens } : {}),
      abortSignal: opts.signal,
      // 网关偶发 5xx 让它自己重试一次；重试不出来的错误再翻成人话
      maxRetries: 1,
    })

    for await (const part of res.fullStream) {
      switch (part.type) {
        case 'text-delta':
          if (part.text) {
            text += part.text
            emit({ t: 'text', text: part.text })
          }
          break
        case 'reasoning-delta':
          if (part.text) {
            reasoning += part.text
            emit({ t: 'reasoning', text: part.text })
          }
          break
        case 'tool-call': {
          toolUses += 1
          const label = LABELS[part.toolName] ?? `工具 ${part.toolName}`
          emit({ t: 'stage', text: `正在${label}…` })
          emit({ t: 'tool-start', id: part.toolCallId, name: part.toolName, detail: toolDetail(part.toolName, part.input) })
          break
        }
        case 'tool-result': {
          /* 结果可能很长（一篇笔记全文），面板上只摆个开头 */
          const out = typeof part.output === 'string' ? part.output : JSON.stringify(part.output ?? '')
          emit({
            t: 'tool-end',
            id: part.toolCallId,
            ok: true,
            detail: out.length > 90 ? `${out.slice(0, 90)}…` : out,
          })
          emit({ t: 'stage', text: '正在等模型…' })
          break
        }
        case 'tool-error': {
          const msg = part.error instanceof Error ? part.error.message : String(part.error ?? '工具执行出错')
          emit({ t: 'tool-end', id: part.toolCallId, ok: false, detail: msg })
          emit({ t: 'stage', text: '正在等模型…' })
          break
        }
        case 'finish':
          break
        case 'error': {
          errObj = part.error
          break
        }
        default:
          break
      }
    }
  }

  try {
    await attempt(true)

    /* 服务不认 tools 参数（旧版本地模型常见）：退回普通对话再跑一次。
       以前那套手写循环有这个降级，换引擎不能把它丢了——否则老 Ollama
       上直接一句「400 bad request」什么也答不出来。 */
    if (errObj && /tool|function/i.test(errorText(errObj))) {
      emit({ t: 'stage', text: '这个模型不支持工具调用，改用普通对话' })
      errObj = null
      toolUses = 0
      text = ''
      reasoning = ''
      await attempt(false)
    }

    /* 收尾补一次。两种情形会走到这：
       ① 步数到顶，模型手里有工具结果却没写正文；
       ② 全程只在思考里说「我要搜一下」，一次工具都没发、正文也空——思考型
          模型的老毛病，不能把思考当答案交给用户。
       补的方式一样：把已有上下文原样再问一次，不带工具，逼它出正文。 */
    const needFinal = !text.trim() && !errObj
    if (needFinal) {
      emit({ t: 'stage', text: '正在整理回答…' })
      const tail = toolUses
        ? '你查到了资料，但最后没有输出正文。现在请直接回答最初的问题：用和提问相同的语言写正文，把结论讲清楚，不要再描述你打算怎么查、也不要复述思考过程。'
        : '请直接回答上面的问题，用和提问相同的语言写正文。不要只描述你打算做什么，也不要复述思考过程。'
      try {
        const again = streamText({
          model: provider.chatModel(cfg.model),
          system: cfg.system,
          messages: [
            ...messages,
            ...(text.trim() ? [{ role: 'assistant' as const, content: text }] : []),
            { role: 'user' as const, content: tail },
          ],
          temperature: cfg.temperature,
          ...(cfg.maxOutputTokens ? { maxOutputTokens: cfg.maxOutputTokens } : {}),
          abortSignal: opts.signal,
          maxRetries: 1,
        })
        for await (const part of again.fullStream) {
          if (part.type === 'text-delta' && part.text) {
            text += part.text
            emit({ t: 'text', text: part.text })
          } else if (part.type === 'reasoning-delta' && part.text && !reasoning) {
            reasoning += part.text
            emit({ t: 'reasoning', text: part.text })
          } else if (part.type === 'error') {
            errObj = errObj ?? part.error
          }
        }
      } catch (e) {
        errObj = errObj ?? e
      }
    }

    if (!text.trim()) {
      return {
        ok: false,
        text: '',
        reasoning,
        sources: webHits.map((h) => ({ title: h.title, url: h.url })),
        toolUses,
        error: (errObj ? describe(errObj) : '') || '模型没有返回正文',
      }
    }
    return {
      ok: true,
      text,
      reasoning,
      sources: webHits.map((h) => ({ title: h.title, url: h.url })),
      toolUses,
    }
  } catch (e) {
    return {
      ok: false,
      text,
      reasoning,
      sources: webHits.map((h) => ({ title: h.title, url: h.url })),
      toolUses,
      error: describe(e),
    }
  }
}

/**
 * SDK 的报错翻成人话。
 *
 * 最要紧的是 401/403：绝大多数「用不了」都是密钥填错或没填，而 SDK 只会
 * 说一句 "Unauthorized"。具体区分（没填 / 填成了模型名 / 被拒）在主进程
 * 那层做——那边能同时看到 body 和配置，这边只兜住通用情形，免得把英文
 * 原文甩给用户。
 */
function humanize(e: unknown): string {
  /* SDK 会把连续失败包成 RetryError，外面那句只是「重试了 2 次」，
     真正的原因压在内层的 lastError 上。往里走一层再翻译。 */
  const outer = e as { message?: string; statusCode?: number; responseBody?: string; lastError?: unknown } | null
  const inner = (outer?.lastError ?? outer) as
    | { message?: string; statusCode?: number; responseBody?: string; cause?: unknown }
    | null
  const status = Number(inner?.statusCode ?? outer?.statusCode ?? 0)
  const body = String(inner?.responseBody ?? outer?.responseBody ?? '')
  const cause = (inner?.cause ?? null) as { message?: string; code?: string } | null
  const s = [String(inner?.message ?? outer?.message ?? e ?? ''), body, String(cause?.code ?? ''), String(cause?.message ?? '')]
    .filter(Boolean)
    .join(' ')

  if (status === 401 || /\b401\b|unauthori[sz]ed|invalid[ _-]?api[ _-]?key/i.test(s))
    return '密钥被服务拒绝了（401）。到设置里核对 API Key。'
  if (status === 403 || /\b403\b|forbidden/i.test(s))
    return '服务拒绝了这次请求（403）。可能是密钥权限不够或额度用完了。'
  if (status === 404 || /404|not[\s_-]?found/i.test(s))
    return '接口或模型名不存在（404）。检查地址末尾是不是 /v1，以及模型名是否写对。'
  if (/ECONNREFUSED|ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED|cannot connect|connection error|fetch failed/i.test(s))
    return '连不上目标地址。确认服务已启动、地址和端口没写错（本地模型用 127.0.0.1 更稳）。'
  if (/abort|timeout|timed out|ETIMEDOUT/i.test(s)) return '请求超时，模型那边一直没回话。'
  if (!s.trim()) return ''
  return s.trim()
}

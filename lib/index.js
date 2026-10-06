// dsh-user-style 宿主半边。
//
// 职责：保存「用户工作风格」档案，并在每次提示词组装时，把当前生效的那一份注入系统提示词。
//
// 注入点：ctx.systemPrompt.section({ name, order, text })。
// 官方文档明确写了「不存在终端用户提示词编辑 API」，所以这里由插件自己注册一个全局段，
// text 用函数形式（system-prompt 的组装会在每个模型步骤求值），因此按工作区/会话切换是即时的。
//
// 已知代价：段文本变化会让该位置起的前缀 KV cache 失效。所以本插件只在用户真的改了档案时
// 才改变文本，不做「每轮注入新内容」。
import { appendFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateToolParameters } from './tool-schema.js'
import { listWorkspaces } from './workspaces.js'
import {
  DATA_DIR,
  LAST_RENDER_FILE,
  TRACE_FILE,
  PRESETS,
  PRESET_REVISION,
  emptyStore,
  loadStore,
  migratePresets,
  mutateStore,
  normalizeStore,
  renderProfile,
  resolveEffectiveProfile,
  saveStore,
} from './store.js'

/** Cordis 插件名。 */
export const name = 'user-style'
/** 只依赖提示词注册表；工具与 HTTP 能力按需 inject，缺席时插件仍能工作。 */
export const inject = ['systemPrompt']

// 刻意不导出 Config，也刻意不 import 任何 @deepseek-ai/* 包。
//
// 原因：本插件以 link（junction）方式装在 profile 里，Node 会把模块解析成 workspace 的真实路径，
// 于是 @deepseek-ai/* 会从 workspace 往上找而找不到——官方第三方插件都是装成真目录才躲过这一条。
// 零外部依赖后，插件无论被链接到哪里都能加载。
//
// 代价是不做配置校验；cordis 的 resolveConfig 在插件没有 Config 导出时会把 patch 层里的
// config 原样透传（见 @deepseek-ai/cordis 的 resolveConfig：`if (!runtime.Config) return config`），
// 所以下面 apply() 自己按默认值容错读取。
const DEFAULTS = {
  order: 100,
  sectionName: 'user-style',
  enableTool: true,
  trace: true,
}

const ROUTE_PREFIX = '/_dsh/dsh-user-style'
const TRACE_LIMIT = 40

/** 最近一次组装看到的工作区/会话，供界面「绑定到当前工作区」使用。 */
let lastSeen = { cwd: '', sessionId: '', at: 0 }
let traceState = { count: 0, lastText: null }

// ---------------------------------------------------------------- 诊断留痕（可关）

function trace(event) {
  if (traceState.count >= TRACE_LIMIT) return
  traceState.count += 1
  try {
    appendFileSync(TRACE_FILE, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, 'utf8')
  } catch {
    /* 诊断写不进去不影响功能 */
  }
}

function traceReset(meta) {
  try {
    writeFileSync(TRACE_FILE, `${JSON.stringify({ ts: new Date().toISOString(), event: 'plugin-loaded', ...meta })}\n`, 'utf8')
  } catch {
    /* 忽略 */
  }
}

// ------------------------------------------------------------ 组装上下文的事实读取

// 会话头（落盘的 session.v4.jsonl 第一行）真实形状：
//   { type, version, id, createdAt, cwd, isSeeded, delegationDepth, agentPreset }
// 官方 system-prompt 文档给的取法也是 agent.session.header.cwd。
//
// 之前的写法在 context.agent 上就直接读到了 agent.id（等于会话 id），于是提前 return，
// cwd 永远是空的——「按工作区绑定」因此静默失效。现在按显式路径逐个探测，cwd 与 id 独立收集。
const CWD_FIELDS = ['cwd', 'workspacePath', 'workspace', 'workdir', 'directory', 'dir', 'root', 'projectDir', 'baseDir']
const ID_FIELDS = ['id', 'sessionId']

function readContextFacts(context) {
  const facts = { cwd: '', sessionId: '', cwdVia: '', idVia: '', headerKeys: [] }
  if (!context || typeof context !== 'object') return facts

  const agent = context.agent && typeof context.agent === 'object' ? context.agent : null
  const session = context.session && typeof context.session === 'object' ? context.session : null
  const scope = context.scope && typeof context.scope === 'object' ? context.scope : null

  // 顺序即优先级：文档给出的路径排在最前，裸对象排在最后（避免又被 agent.id 抢先）。
  const candidates = [
    ['agent.session.header', agent && agent.session && agent.session.header],
    ['agent.session', agent && agent.session],
    ['session.header', session && session.header],
    ['session', session],
    ['context.session.header', context.session && context.session.header],
    ['agent.header', agent && agent.header],
    ['scope.agent.session.header', scope && scope.agent && scope.agent.session && scope.agent.session.header],
    ['scope.session.header', scope && scope.session && scope.session.header],
    ['agent', agent],
    ['scope', scope],
    ['context', context],
  ]

  for (const [label, node] of candidates) {
    if (!node || typeof node !== 'object') continue
    if (!facts.cwd) {
      for (const field of CWD_FIELDS) {
        const value = node[field]
        if (typeof value === 'string' && value) {
          facts.cwd = value
          facts.cwdVia = `${label}.${field}`
          break
        }
      }
    }
    if (!facts.sessionId) {
      for (const field of ID_FIELDS) {
        const value = node[field]
        if (typeof value === 'string' && value.startsWith('session')) {
          facts.sessionId = value
          facts.idVia = `${label}.${field}`
          break
        }
      }
    }
    if (facts.cwd && facts.sessionId) break
  }

  // 万一 cwd 还是没找到，把会话头的字段名记下来，下次留痕就能直接定位。
  const header = agent && agent.session && agent.session.header
  if (header && typeof header === 'object') facts.headerKeys = Object.keys(header).slice(0, 30)
  return facts
}

/**
 * 计算这次组装该注入什么文本。任何异常都在这里兜住：抛出去会让整个提示词组装失败。
 */
function renderForAssembly(context) {
  try {
    const facts = readContextFacts(context)
    if (facts.cwd || facts.sessionId) {
      lastSeen = { cwd: facts.cwd || lastSeen.cwd, sessionId: facts.sessionId || lastSeen.sessionId, at: Date.now() }
    }
    const store = loadStore()
    const effective = resolveEffectiveProfile(store, facts)
    const text = renderProfile(effective.profile)
    const summary = {
      profileId: effective.profile ? effective.profile.id : '',
      source: effective.source,
      cwd: facts.cwd,
      sessionId: facts.sessionId,
      cwdVia: facts.cwdVia,
      idVia: facts.idVia,
      chars: text.length,
    }
    if (traceState.count < TRACE_LIMIT) {
      trace({
        event: 'assemble',
        ...summary,
        // cwd 缺席时把会话头字段名列出来，便于直接定位（而不是靠猜）。
        ...(facts.cwd ? {} : { headerKeys: facts.headerKeys }),
        contextKeys: context && typeof context === 'object' ? Object.keys(context).slice(0, 20) : [],
      })
    }
    if (text !== traceState.lastText) {
      traceState.lastText = text
      try {
        writeFileSync(
          LAST_RENDER_FILE,
          `${JSON.stringify({ ts: new Date().toISOString(), ...summary }, null, 2)}\n---\n${text}\n`,
          'utf8',
        )
      } catch {
        /* 忽略 */
      }
    }
    return text
  } catch {
    return ''
  }
}

// ------------------------------------------------------------------------ RPC 实现

function respond(res, status, payload) {
  const body = JSON.stringify(payload === undefined ? null : payload)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 把存储 + 生效解析 + 预览 + 已知工作区打包给界面。 */
function buildState(extra = {}) {
  const store = loadStore({ force: true })
  const cwd = extra.cwd || lastSeen.cwd || process.cwd()
  const sessionId = extra.sessionId || lastSeen.sessionId || ''
  const effective = resolveEffectiveProfile(store, { cwd, sessionId })
  const known = listWorkspaces(cwd)
  return {
    dataDir: DATA_DIR,
    cwd,
    sessionId,
    lastSeenAt: lastSeen.at,
    presets: PRESETS,
    store,
    // 工作区列表来自 DSH 的工作区存储；读不到时会只剩当前工作区，界面据此降级。
    workspaces: known.workspaces.map((entry) => ({
      ...entry,
      boundProfileId: store.workspaceBindings[entry.path] || '',
    })),
    workspacesReadError: known.readError,
    effective: {
      profileId: effective.profile ? effective.profile.id : '',
      source: effective.source,
      sourceKey: effective.sourceKey,
    },
    preview: renderProfile(effective.profile),
  }
}

function upsertProfileFrom(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const id = String(raw.id || '').trim() || `style-${Date.now().toString(36)}`
  const items = Array.isArray(raw.items)
    ? raw.items.map((item) => String(item || '').trim()).filter(Boolean)
    : String(raw.itemsText || '')
        .split('\n')
        .map((line) => line.replace(/^\s*[-*]\s*/, '').trim())
        .filter(Boolean)
  return {
    id,
    name: String(raw.name || id).trim() || id,
    summary: String(raw.summary || '').trim(),
    items,
    notes: String(raw.notes || '').trim(),
  }
}

const ROUTES = {
  getState(input) {
    return buildState(input)
  },
  upsertProfile(input) {
    const profile = upsertProfileFrom(input)
    mutateStore((draft) => {
      const index = draft.profiles.findIndex((entry) => entry.id === profile.id)
      if (index >= 0) draft.profiles[index] = profile
      else draft.profiles.push(profile)
    })
    return buildState({ cwd: input && input.cwd, sessionId: input && input.sessionId })
  },
  deleteProfile(input) {
    const id = String((input && input.id) || '').trim()
    mutateStore((draft) => {
      draft.profiles = draft.profiles.filter((entry) => entry.id !== id)
      if (draft.defaultProfileId === id) draft.defaultProfileId = ''
      for (const [key, value] of Object.entries(draft.workspaceBindings)) {
        if (value === id) delete draft.workspaceBindings[key]
      }
      for (const [key, value] of Object.entries(draft.sessionOverrides)) {
        if (value === id) delete draft.sessionOverrides[key]
      }
    })
    return buildState({ cwd: input && input.cwd, sessionId: input && input.sessionId })
  },
  setDefault(input) {
    const id = String((input && input.id) || '').trim()
    mutateStore((draft) => {
      draft.defaultProfileId = id
    })
    return buildState({ cwd: input && input.cwd, sessionId: input && input.sessionId })
  },
  bindWorkspace(input) {
    const cwd = String((input && input.cwd) || lastSeen.cwd || process.cwd()).trim()
    const id = String((input && input.id) || '').trim()
    mutateStore((draft) => {
      if (id) draft.workspaceBindings[cwd] = id
      else delete draft.workspaceBindings[cwd]
    })
    return buildState({ cwd, sessionId: input && input.sessionId })
  },
  setSessionOverride(input) {
    const sessionId = String((input && input.sessionId) || lastSeen.sessionId || '').trim()
    const id = String((input && input.id) || '').trim()
    if (!sessionId) return { ...buildState(input), warning: '当前会话 id 尚未观测到，无法设置会话级覆盖' }
    mutateStore((draft) => {
      if (id) draft.sessionOverrides[sessionId] = id
      else delete draft.sessionOverrides[sessionId]
    })
    return buildState({ cwd: input && input.cwd, sessionId })
  },
  reset() {
    mutateStore((draft) => {
      const fresh = emptyStore()
      draft.profiles = fresh.profiles
      draft.defaultProfileId = ''
      draft.workspaceBindings = {}
      draft.sessionOverrides = {}
    })
    return buildState()
  },
  preview(input) {
    const store = loadStore({ force: true })
    const id = String((input && input.id) || '').trim()
    if (id) {
      const profile = store.profiles.find((entry) => entry.id === id) || null
      return { profileId: id, text: renderProfile(profile) }
    }
    return { profileId: '', text: buildState(input).preview }
  },
}

/** 界面会改写存储的方法，必须走 POST。 */
const MUTATING = new Set([
  'upsertProfile',
  'deleteProfile',
  'setDefault',
  'bindWorkspace',
  'setSessionOverride',
  'reset',
])

// --------------------------------------------------------------------- 模型侧工具

const TOOL_DESCRIPTION = [
  '读取与保存「用户工作风格」档案（user style profile）——即用户希望 AI 用什么方式工作',
  '（例如：先给结论、分点作答、少问确认、严谨标注不确定）。这份档案会在每次对话开始时',
  '自动注入系统提示词，因此写入前必须得到用户的明确同意。',
  '',
  'action 取值：',
  "- get：读取当前生效的档案、它来自哪一层（session/workspace/default）以及实际注入的文本。",
  "- save：新建或覆盖一个档案。只有在用户明确确认（例如回答「可以」「就这样」）之后才能调用；",
  '  用户的原始要求还没被确认时，先用提问工具向他确认，确认后再调用。',
  "- set_default：把某个档案设为全局默认。",
  "- bind_workspace：把某个档案绑定到当前工作区。",
  "- set_session：只在当前会话临时使用某个档案（不写入全局默认）。",
].join('\n')

// 参数是**标准 JSON Schema**：required 必须是字符串数组，且写在对象层级上。
// 不要改成属性级 `required: true`——那是 defineTool 那条路的 spec，会被原样发给服务商，
// 导致每一次请求都报 `true is not of type "array"`。注册前由 validateToolParameters 兜住。
const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['get', 'save', 'set_default', 'bind_workspace', 'set_session'],
      description: '要执行的操作；只读用 get。',
    },
    id: { type: 'string', description: '档案 id（save 时省略则新建）。' },
    name: { type: 'string', description: '档案名称，如「严谨审慎」。' },
    summary: { type: 'string', description: '一句话说明这份风格。' },
    items: {
      type: 'array',
      items: { type: 'string' },
      description: '风格条目，每条一句可执行的要求。',
    },
    notes: { type: 'string', description: '补充说明（自由文本）。' },
    cwd: { type: 'string', description: 'bind_workspace 用；省略则用最近一次对话的工作区。' },
    sessionId: { type: 'string', description: 'set_session 用；省略则用当前会话。' },
  },
  required: ['action'],
  additionalProperties: false,
}

function toolGet() {
  return JSON.stringify(buildState(), null, 2)
}

function toolExecute(args) {
  const action = String((args && args.action) || 'get').trim()
  const id = String((args && args.id) || '').trim()
  const cwd = String((args && args.cwd) || lastSeen.cwd || process.cwd()).trim()
  const sessionId = String((args && args.sessionId) || lastSeen.sessionId || '').trim()
  switch (action) {
    case 'get':
      return toolGet()
    case 'save': {
      const profile = upsertProfileFrom({
        id,
        name: args && args.name,
        summary: args && args.summary,
        items: args && args.items,
        notes: args && args.notes,
      })
      mutateStore((draft) => {
        const index = draft.profiles.findIndex((entry) => entry.id === profile.id)
        if (index >= 0) draft.profiles[index] = profile
        else draft.profiles.push(profile)
      })
      return `已保存风格档案「${profile.name}」(id: ${profile.id})，共 ${profile.items.length} 条。\n\n当前生效解析：\n${toolGet()}`
    }
    case 'set_default':
      if (!id) return 'set_default 需要 id。可用档案见 get 的结果。'
      mutateStore((draft) => {
        draft.defaultProfileId = id
      })
      return `已把全局默认风格设为 ${id}。`
    case 'bind_workspace':
      mutateStore((draft) => {
        if (id) draft.workspaceBindings[cwd] = id
        else delete draft.workspaceBindings[cwd]
      })
      return id ? `已把工作区 ${cwd} 绑定到风格 ${id}。` : `已解除工作区 ${cwd} 的风格绑定。`
    case 'set_session':
      if (!sessionId) return 'set_session 需要会话 id，但当前尚未观测到，请改用界面设置。'
      mutateStore((draft) => {
        if (id) draft.sessionOverrides[sessionId] = id
        else delete draft.sessionOverrides[sessionId]
      })
      return id ? `本会话已临时切换到风格 ${id}（仅本次会话）。` : '已清除本会话的临时风格。'
    default:
      return `未知 action: ${action}`
  }
}

// -------------------------------------------------------------------------- 装配

/**
 * @param ctx - 宿主 Cordis 上下文。
 * @param config - 部署配置（order / sectionName / enableTool / trace）。
 */
export function apply(ctx, config = {}) {
  // 没有 Config schema，配置由 patch 层原样透传；这里按默认值容错读取。
  const source = config && typeof config === 'object' ? config : {}
  const order = typeof source.order === 'number' ? source.order : DEFAULTS.order
  const sectionName = typeof source.sectionName === 'string' && source.sectionName ? source.sectionName : DEFAULTS.sectionName
  const enableTool = source.enableTool !== false
  const traceEnabled = source.trace !== false

  if (traceEnabled) traceReset({ order, sectionName, dataDir: DATA_DIR, pid: process.pid })

  // —— 核心：把当前生效的风格档作为全局提示词段注册。interpolate:false 保证用户文本里的
  //    {{ }} 不会被当成模板变量（风格是自由文本，必须原样保留）。
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: sectionName,
        order,
        interpolate: false,
        text: (context) => renderForAssembly(context),
      }),
    'user-style: section',
  )

  // —— 界面用的 HTTP 接口（仅本机回环 / 桌面端可达，走宿主认证边界）。
  ctx.inject(['connection', 'webServer'], (webCtx) => {
    webCtx.effect(
      () => {
        const dispose = webCtx.webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: async (req, res) => {
            let method = ''
            try {
              if (webCtx.connection && typeof webCtx.connection.requestRejection === 'function') {
                const rejection = webCtx.connection.requestRejection(req)
                if (rejection !== undefined) {
                  respond(res, rejection, { error: 'request rejected' })
                  return
                }
              }
              const url = new URL(req.url || '/', 'http://localhost')
              const path = url.pathname
              if (!path.startsWith(`${ROUTE_PREFIX}/`)) {
                respond(res, 404, { error: 'not found' })
                return
              }
              method = decodeURIComponent(path.slice(ROUTE_PREFIX.length + 1))
              const fn = Object.hasOwn(ROUTES, method) ? ROUTES[method] : null
              if (typeof fn !== 'function') {
                respond(res, 404, { error: `unknown method: ${method}` })
                return
              }
              if (MUTATING.has(method) && req.method !== 'POST') {
                respond(res, 405, { error: 'mutating methods require POST' })
                return
              }
              let args = {}
              if (req.method === 'POST' || req.method === 'PUT') {
                const raw = await readBody(req, 256 * 1024)
                if (raw.length > 0) {
                  try {
                    args = JSON.parse(raw)
                  } catch {
                    respond(res, 400, { error: 'invalid JSON body' })
                    return
                  }
                }
              }
              respond(res, 200, await fn(args))
            } catch (err) {
              const status = (err && err.status) || 500
              if (status === 500) {
                console.warn(`[dsh-user-style] RPC ${method || 'unknown'} failed: ${String((err && err.stack) || err)}`)
              }
              respond(res, status, { error: status === 500 ? 'internal error' : String((err && err.message) || err) })
            }
          },
        })
        return () => dispose()
      },
      'user-style: rpc route',
    )
  })

  // —— 模型侧工具：让 AI 能读当前风格，并在用户确认后写入新偏好。
  //
  // 这里是上一次事故的现场：参数曾被写成属性级 `required: true`（defineTool spec 的写法），
  // 它会原样发给服务商并让**每一次请求**都失败。现在注册前先自检，不通过就宁可不注册这个工具。
  if (enableTool) {
    const check = validateToolParameters(TOOL_PARAMETERS)
    if (!check.ok) {
      // 只留诊断，绝不注册非法 schema。
      trace({ event: 'tool-schema-rejected', problems: check.problems })
      console.warn(`[dsh-user-style] user_style 工具 schema 自检未通过，已跳过注册：${check.problems.join('; ')}`)
    } else {
      ctx.inject(['tools'], (toolCtx) => {
        toolCtx.effect(
          () =>
            toolCtx.tools.register({
              name: 'user_style',
              description: TOOL_DESCRIPTION,
              parameters: TOOL_PARAMETERS,
              output: {
                schema: { type: 'string' },
                render: (_args, value) => [{ type: 'text', text: String(value) }],
              },
              execute(args) {
                try {
                  return toolExecute(args)
                } catch (err) {
                  return `user_style 执行失败：${String((err && err.message) || err)}`
                }
              },
            }),
          'user-style: tool',
        )
      })
    }
  }

  // 首次运行就把数据目录与预设落盘，用户打开界面时立刻有东西可选；
  // 已有存档则跑一次内置预设迁移（只刷新用户没改过的那几套）。
  try {
    if (!existsSync(join(DATA_DIR, 'store.json'))) {
      loadStore({ force: true })
    } else {
      const current = loadStore({ force: true })
      const result = migratePresets(current)
      if (result.changed) {
        saveStore(current)
        if (result.updated.length > 0) trace({ event: 'presets-migrated', revision: PRESET_REVISION, updated: result.updated })
      }
    }
  } catch {
    /* 迁移失败不影响注入本身 */
  }
}

/** 供测试/诊断使用：数据目录与存储文件是否存在。 */
export function diagnostics() {
  return {
    dataDir: DATA_DIR,
    storeFile: join(DATA_DIR, 'store.json'),
    storeExists: existsSync(join(DATA_DIR, 'store.json')),
    traceFile: TRACE_FILE,
    traceExists: existsSync(TRACE_FILE),
    traceBytes: existsSync(TRACE_FILE) ? statSync(TRACE_FILE).size : 0,
    lastRenderFile: LAST_RENDER_FILE,
    lastSeen,
    store: normalizeStore(loadStore({ force: true })),
  }
}

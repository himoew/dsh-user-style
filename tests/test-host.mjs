// 用假的 Cordis 上下文驱动**真实的**宿主插件代码。
//
// 目的：把三条装配路径（提示词段注册、HTTP RPC、模型工具）在离线状态全部走一遍，
// 并确认模块导入解析正常。插件已装进 profile 时，额外验证 junction 路径也能加载。
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 位置无关：由本文件位置推出包根，clone 到任何路径都能跑（发布到 GitHub 的前提）。
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// 先记下真实的 DSH 主目录，下面会把它覆盖成沙箱。
const REAL_DSH_HOME =
  typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')

const sandbox = mkdtempSync(join(tmpdir(), 'user-style-host-'))
process.env.DSH_USER_STYLE_DATA_DIR = sandbox
// 把 DSH_HOME 指向沙箱：工作区列表会读沙箱里并不存在的 storages/workspace.json，
// 从而走「只剩当前工作区」的降级路径——测试结果不依赖你真实的 ~/.dsh 内容。
process.env.DSH_HOME = sandbox

// 始终测本机源码（与是否已安装无关）。
const LOCAL_ENTRY = pathToFileURL(join(ROOT, 'lib', 'index.js')).href
// 若本机已把它装进 profile，顺便验证宿主真正加载的那条路径（junction）也通；没装就跳过。
const PROFILE_ENTRY = join(REAL_DSH_HOME, 'profiles', 'desktop', 'node_modules', 'dsh-user-style', 'lib', 'index.js')

const { validateToolParameters } = await import('../lib/tool-schema.js')

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(actual)}`}`)
}

let plugin
try {
  plugin = await import(LOCAL_ENTRY)
  console.log('PASS  本机源码模块导入（宿主机半侧零外部依赖）')
} catch (err) {
  console.log(`FAIL  本机源码模块导入失败：${String((err && err.message) || err)}`)
  process.exit(1)
}

if (existsSync(PROFILE_ENTRY)) {
  try {
    await import(pathToFileURL(PROFILE_ENTRY).href)
    console.log('PASS  profile junction 路径也可加载')
  } catch (err) {
    console.log(`FAIL  profile junction 路径加载失败：${String((err && err.message) || err)}`)
    failures += 1
  }
} else {
  console.log('SKIP  profile junction 不存在（插件当前未安装），跳过该项')
}

check('导出 name', plugin.name, 'user-style')
check('导出 inject', plugin.inject, ['systemPrompt'])
check('导出 apply 为函数', typeof plugin.apply, 'function')

// 回归护栏：宿主机半侧绝不能 import 任何 @deepseek-ai/* ——
// 插件以 link 方式装进 profile 时 Node 会解析成 workspace 真实路径，那些包在 workspace 里找不到。
// （这正是第一次离线测试抓到的真实故障。）
const hostFiles = ['index.js', 'store.js'].map((f) => join(ROOT, 'lib', f))
let externalRefs = 0
for (const file of hostFiles) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(/(?:from|require\()\s*['"](@deepseek-ai\/[^'"]+)['"]/g)) {
    externalRefs += 1
    console.log(`      发现外部依赖：${match[1]} (${file})`)
  }
}
check('宿主机半侧零 @deepseek-ai 依赖', externalRefs, 0)
check('刻意不导出 Config（cordis 会原样透传配置）', plugin.Config, undefined)

// ---------------------------------------------------------------- 假上下文装配
const captured = { sections: [], routes: [], tools: [], effects: [] }

function makeChild() {
  return {
    effect(fn, label) {
      captured.effects.push(label)
      return fn()
    },
    webServer: {
      register(def) {
        captured.routes.push(def)
        return () => {}
      },
    },
    connection: { requestRejection: () => undefined },
    tools: {
      register(def) {
        captured.tools.push(def)
        return () => {}
      },
    },
  }
}

const rootCtx = {
  effect(fn, label) {
    captured.effects.push(label)
    return fn()
  },
  inject(services, cb) {
    return cb(makeChild())
  },
  systemPrompt: {
    section(def) {
      captured.sections.push(def)
      return () => {}
    },
  },
  get: () => undefined,
}

plugin.apply(rootCtx, {})

check('注册了 1 个提示词段', captured.sections.length, 1)
const section = captured.sections[0]
check('段名', section.name, 'user-style')
check('段顺序', section.order, 100)
check('禁止插值（风格是自由文本）', section.interpolate, false)
check('text 是函数（每次组装求值）', typeof section.text, 'function')
check('注册了 RPC 路由', captured.routes.length, 1)
check('路由为前缀匹配', captured.routes[0].kind, 'prefix')
check('路由路径', captured.routes[0].path, '/_dsh/dsh-user-style')
check('注册了模型工具', captured.tools.length, 1)
check('工具名', captured.tools[0].name, 'user_style')

// ------------------------------------------------------------ 段文本：未启用时为空
const ctxFacts = { agent: { session: { header: { cwd: 'D:\\demo', id: 'session-1' } } } }
check('未启用任何档案时注入空串', section.text(ctxFacts), '')

// ------------------------------------------------------------------- RPC 端到端
const handler = captured.routes[0].handler

function fakeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function fakeRes() {
  const res = { status: 0, body: '', headers: null }
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = headers
  }
  res.end = (payload) => {
    res.body = payload
  }
  return res
}

async function rpc(method, body, httpMethod = 'POST') {
  const res = fakeRes()
  await handler(fakeReq(httpMethod, `/_dsh/dsh-user-style/${method}`, body), res)
  let parsed = null
  try {
    parsed = JSON.parse(res.body)
  } catch {
    parsed = res.body
  }
  return { status: res.status, json: parsed }
}

const state0 = await rpc('getState')
check('getState 返回 200', state0.status, 200)
check('getState 带出内置预设', state0.json.store.profiles.length, 4)
check('初始生效来源为 none', state0.json.effective.source, 'none')
check('初始预览为空', state0.json.preview, '')

// 保存一份自定义档案
const saved = await rpc('upsertProfile', {
  id: 'mine',
  name: '我的风格',
  summary: '测试用',
  itemsText: '- 先给结论\n- 分点作答\n\n- 不要反问确认',
  notes: '补充：中文回答',
})
check('upsertProfile 返回 200', saved.status, 200)
const mine = saved.json.store.profiles.find((p) => p.id === 'mine')
check('条目按行解析且忽略空行', mine.items.length, 3)
check('条目剥离了前缀符号', mine.items[0], '先给结论')
check('补充说明被保留', mine.notes, '补充：中文回答')

// 设为全局默认 → 段文本应立即非空
const asDefault = await rpc('setDefault', { id: 'mine' })
check('setDefault 生效来源', asDefault.json.effective.source, 'default')
const injected = section.text(ctxFacts)
check('注入文本含标题', injected.includes('## 用户工作风格'), true)
check('注入文本逐条列出', injected.split('\n').filter((l) => l.startsWith('- ')).length, 3)
check('注入文本含补充说明', injected.includes('中文回答'), true)

// 工作区绑定覆盖默认
await rpc('bindWorkspace', { cwd: 'D:\\demo', id: 'bullets' })
check('工作区绑定后来源', (await rpc('getState', { cwd: 'D:\\demo' })).json.effective.source, 'workspace')
check('工作区绑定的档案生效', (await rpc('getState', { cwd: 'D:\\demo' })).json.effective.profileId, 'bullets')

// ------------------------------------------- 工作区列表（界面据此让用户挑选，而不是只认「当前」）
const wsState = await rpc('getState', { cwd: 'D:\\somewhere' })
check('getState 带出工作区列表', Array.isArray(wsState.json.workspaces), true)
check('无台账时降级为只剩当前工作区', wsState.json.workspaces.length, 1)
check('降级项被标记为当前', wsState.json.workspaces[0].isCurrent, true)
check('工作区项带 boundProfileId 字段', Object.hasOwn(wsState.json.workspaces[0], 'boundProfileId'), true)
check('未绑定时 boundProfileId 为空', wsState.json.workspaces[0].boundProfileId, '')
await rpc('bindWorkspace', { cwd: 'D:\\somewhere', id: 'bullets' })
const boundWs = await rpc('getState', { cwd: 'D:\\somewhere' })
check(
  '绑定后工作区项反映出来',
  boundWs.json.workspaces.filter((w) => w.isCurrent)[0].boundProfileId,
  'bullets',
)

// 会话覆盖优先级最高
await rpc('setSessionOverride', { sessionId: 'session-1', id: 'teacher' })
const sessionState = await rpc('getState', { cwd: 'D:\\demo', sessionId: 'session-1' })
check('会话覆盖优先级最高', sessionState.json.effective.profileId, 'teacher')
check('会话覆盖来源标记', sessionState.json.effective.source, 'session')

// 写方法必须拒绝 GET（防被 <img> 之类误触发）
check('写方法拒绝 GET', (await rpc('setDefault', { id: 'fast' }, 'GET')).status, 405)
check('只读方法允许 GET', (await rpc('getState', undefined, 'GET')).status, 200)
check('未知方法返回 404', (await rpc('nope')).status, 404)

// 删除档案要连带清理引用
await rpc('deleteProfile', { id: 'teacher' })
const afterDelete = await rpc('getState', { cwd: 'D:\\demo', sessionId: 'session-1' })
check('删除后会话覆盖被清理', afterDelete.json.store.sessionOverrides['session-1'], undefined)
check('删除后回落到工作区绑定', afterDelete.json.effective.profileId, 'bullets')

// --------------------------------------------------------------------- 模型工具
const tool = captured.tools[0]
check('工具 action 枚举完整', tool.parameters.properties.action.enum.length, 5)
check('工具输出可渲染', typeof tool.output.render, 'function')
const got = tool.execute({ action: 'get' })
check('工具 get 返回 JSON', got.includes('"effective"'), true)
const savedByTool = tool.execute({ action: 'save', name: 'AI 写的', items: ['一条要求'] })
check('工具 save 成功', savedByTool.includes('已保存风格档案'), true)
check('工具 save 后档案存在', (await rpc('getState')).json.store.profiles.some((p) => p.name === 'AI 写的'), true)
check('工具未知 action 有提示', tool.execute({ action: 'zzz' }).includes('未知 action'), true)
check('工具 set_session 无会话 id 时给出提示', tool.execute({ action: 'set_session', id: 'fast', sessionId: '' }).length > 0, true)

// -------------------------------------------------- 回归 1：工具 schema 必须是标准 JSON Schema
// 事故现场：属性级 `required: true` 被原样发给服务商，报
// `Invalid schema for function 'user_style': true is not of type "array"`，让每一次请求都失败。
const params = tool.parameters
check('required 是字符串数组', Array.isArray(params.required), true)
check('required 只点名 action', params.required, ['action'])
check('属性上没有 required（defineTool spec 的写法）', Object.values(params.properties).some((p) => Object.hasOwn(p, 'required')), false)
check('自检通过注册中的参数', validateToolParameters(params).ok, true)

// 自检必须真的能抓出这些错误形状，否则它只是摆设
check('自检抓出属性级 required: true', validateToolParameters({
  type: 'object',
  properties: { action: { type: 'string', required: true } },
}).ok, false)
check('自检抓出对象级 required: true', validateToolParameters({
  type: 'object',
  properties: { action: { type: 'string' } },
  required: true,
}).ok, false)
check('自检抓出 array 缺 items', validateToolParameters({
  type: 'object',
  properties: { items: { type: 'array' } },
}).ok, false)
check('自检抓出 required 点名不存在的属性', validateToolParameters({
  type: 'object',
  properties: { action: { type: 'string' } },
  required: ['nope'],
}).ok, false)
check('自检抓出 enum 非数组', validateToolParameters({
  type: 'object',
  properties: { action: { type: 'string', enum: 'get' } },
}).ok, false)

// ------------------------------------------------------ 回归 2：cwd 必须能从会话头读到
// 事故现场：在 context.agent 上就读到 agent.id（等于会话 id）后提前 return，cwd 永远是空，
// 「按工作区绑定」静默失效。会话头落盘的真实形状见下方 realHeader。
const realHeader = {
  type: 'session',
  version: 4,
  id: 'session-real',
  createdAt: 1791259590652,
  cwd: 'D:\\real-workspace',
  isSeeded: false,
  delegationDepth: 0,
  agentPreset: 'standard',
}
// 关键：agent 自己也带一个 id（等于会话 id），旧写法会被它抢先。
const realCtx = { agent: { id: 'session-real', session: { header: realHeader } }, scope: {}, signal: {} }
section.text(realCtx)
const seen = await rpc('getState')
check('从 agent.session.header 读到 cwd', seen.json.cwd, 'D:\\real-workspace')
check('会话 id 也读到了', seen.json.sessionId, 'session-real')

// 读到 cwd 之后，工作区绑定必须真的生效（而不是回落默认）
// 注意：绑定的档案必须是前面删除测试之后仍然存在的（teacher 已被删掉）。
await rpc('bindWorkspace', { cwd: 'D:\\real-workspace', id: 'bullets' })
section.text(realCtx)
const boundState = await rpc('getState')
check('真实会话的工作区绑定生效', boundState.json.effective.profileId, 'bullets')
check('来源标记为 workspace', boundState.json.effective.source, 'workspace')
check('注入文本确实用了该档案', section.text(realCtx).includes('## 用户工作风格'), true)

// 兜底：上下文完全为空时不得抛错
let cwdThrew = false
try {
  section.text(undefined)
  section.text({})
  section.text({ agent: {} })
} catch {
  cwdThrew = true
}
check('上下文缺字段时不抛错', cwdThrew, false)

rmSync(sandbox, { recursive: true, force: true })
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1

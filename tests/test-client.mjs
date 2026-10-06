// 客户端半边离线测试。
//
// 不启动浏览器，只验证「bundle 契约」与「注册行为」：
//   · 产物必须是普通脚本，且第一件事是 window.__ModuleLoader__.load({ id, factory })
//   · factory(require) 返回的 module.exports 必须是 { inject, apply }
//   · apply 必须把界面注册进 plugins.bundle.config，且 key 等于 bundle 包名
//     （用成列表槽位的 id 字段会让整个 web 条目在启动时失败）
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 位置无关：由本文件位置推出包根。
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLIENT = join(ROOT, 'lib', 'client.js')

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(actual)}`}`)
}

const code = readFileSync(CLIENT, 'utf8')

// 契约守卫：宿主直接把这个文件当脚本发给浏览器，不能出现 ESM 语法。
check('产物无 ESM import', /^\s*import\s/m.test(code), false)
check('产物无 ESM export', /^\s*export\s/m.test(code), false)
// 产物必须是「执行即注册」的脚本：去掉注释与空白后，第一条语句就是 ModuleLoader 调用。
const codeNoComments = code.replace(/^\s*\/\/.*$/gm, '').trimStart()
check('产物首条语句是 __ModuleLoader__.load', codeNoComments.startsWith('window.__ModuleLoader__.load('), true)

let captured = null
const fakeWindow = {
  __ModuleLoader__: {
    load(def) {
      captured = def
    },
  },
}

// 用 Function 执行顶层脚本，只注入 window。
new Function('window', code)(fakeWindow)
check('注册了 bundle', captured !== null, true)
check('bundle id 为包名', captured && captured.id, 'dsh-user-style')
check('factory 是函数', captured && typeof captured.factory, 'function')

// 极简 React 替身：注册阶段只会用到这几个成员。
const reactStub = {
  createElement: function () {
    return null
  },
  useState: function (initial) {
    return [initial, function () {}]
  },
  useEffect: function () {},
}
let requiredModules = []
const requireStub = function (id) {
  requiredModules.push(id)
  if (id === 'react') return reactStub
  throw new Error(`unexpected require: ${id}`)
}

const exportsObj = captured.factory(requireStub)
// react-dom 是可选 seed 模块：这里故意让 require 抛错，验证缺席时不会崩。
check('require 了 react（并尝试过 react-dom）', requiredModules, ['react', 'react-dom'])
check('exports.inject', exportsObj.inject, ['slots'])
check('exports.apply 是函数', typeof exportsObj.apply, 'function')

// apply：应当先用 slots.inject 等待槽位，再 register
const slotCalls = { injected: [], registered: [] }
const fakeCtx = {
  slots: {
    inject(name, cb) {
      slotCalls.injected.push(name)
      return cb()
    },
    register(def, component) {
      slotCalls.registered.push({ def, component })
      return function () {}
    },
  },
  effect(fn) {
    return fn()
  },
  get() {
    return undefined
  },
}

await exportsObj.apply(fakeCtx)

// 两个界面：工作页面的悬浮面板 + 插件页的完整设置
check('等待了两个槽位', slotCalls.injected, ['conversation.composer.dock', 'plugins.bundle.config'])
check('注册了 2 个界面', slotCalls.registered.length, 2)

const dock = slotCalls.registered.filter((r) => r.def.name === 'conversation.composer.dock')[0] || { def: {}, component: null }
check('悬浮面板挂在输入框 dock 槽位', dock.def.name, 'conversation.composer.dock')
check('dock 条目有 id', dock.def.id, 'dsh-user-style')
check('dock 条目有 priority（列表槽位排序）', typeof dock.def.priority, 'number')
check('悬浮面板组件可渲染', typeof dock.component, 'function')

const reg = slotCalls.registered.filter((r) => r.def.name === 'plugins.bundle.config')[0] || { def: {}, component: null }
check('设置页槽位名', reg.def.name, 'plugins.bundle.config')
check('槽位 key 等于 bundle 包名', reg.def.key, 'dsh-user-style')
check('提供了 label', typeof reg.def.label, 'function')
check('设置页组件可渲染', typeof reg.component, 'function')

// 悬浮组件必须能在没有 slot props 的情况下渲染（不能因为 props 为 undefined 就崩）
check('悬浮组件容忍 props 缺失', typeof dock.component(undefined), 'object')

// slots 服务缺席时必须优雅降级（只告警，不抛错）——否则会拖垮整个页面启动。
let threw = false
try {
  await exportsObj.apply({ get: () => undefined, effect: (fn) => fn() })
} catch {
  threw = true
}
check('slots 缺席时不抛错', threw, false)

// 样式只在浏览器里注入：Node 环境下 document 不存在，ensureStyles 必须静默跳过
check('无 document 时不抛错', typeof dock.component({}), 'object')

// -------------------------------- 药丸标签与贴边最小化（纯函数：界面看不到，但必须可断言）
const T = exportsObj.__test
check('暴露了测试钩子', typeof T, 'object')
check('取路径最后一段', T.shortWorkspaceLabel("D:\\New-Blue fish's work\\User Plugin"), 'User Plugin')
check('带尾部分隔符也能取对', T.shortWorkspaceLabel('D:\\proj\\inner\\'), 'inner')
check('正向斜杠同样处理', T.shortWorkspaceLabel('D:/proj/inner'), 'inner')
check('只有盘符时不崩', T.shortWorkspaceLabel('D:\\'), 'D:')
check('空路径返回空串', T.shortWorkspaceLabel(''), '')
check('undefined 不崩', T.shortWorkspaceLabel(undefined), '')
check('末段是纯数字时带上上一级', T.shortWorkspaceLabel('D:\\proj\\2'), 'proj / 2')
check('末段过短时带上上一级', T.shortWorkspaceLabel('D:\\proj\\ab'), 'proj / ab')
check('末段够长就用末段', T.shortWorkspaceLabel('D:\\work place 2'), 'work place 2')
check('超长末段被截断', T.shortWorkspaceLabel('C:\\a\\' + 'x'.repeat(40)).endsWith('…'), true)

// 找出当前会话落在哪个「已绑定」的工作区里（最长匹配优先）
const wsList = [
  { path: 'D:\\proj', boundProfileId: 'fast' },
  { path: 'D:\\proj\\inner', boundProfileId: 'strict' },
  { path: 'D:\\other', boundProfileId: 'teacher' },
  { path: 'D:\\unbound', boundProfileId: '' },
]
check('命中已绑定工作区', T.matchBoundWorkspace(wsList, 'D:\\other\\x'), 'D:\\other')
check('最长匹配优先', T.matchBoundWorkspace(wsList, 'D:\\proj\\inner\\deep'), 'D:\\proj\\inner')
check('父级绑定对子目录生效', T.matchBoundWorkspace(wsList, 'D:\\proj\\other'), 'D:\\proj')
check('未绑定的不算命中', T.matchBoundWorkspace(wsList, 'D:\\unbound\\x'), '')
check('大小写不敏感', T.matchBoundWorkspace(wsList, 'd:\\OTHER'), 'D:\\other')
check('相邻同名前缀不误命中', T.matchBoundWorkspace(wsList, 'D:\\proj-other'), '')
check('不在任何工作区时返回空', T.matchBoundWorkspace(wsList, 'D:\\elsewhere'), '')
check('空列表不崩', T.matchBoundWorkspace([], 'D:\\x'), '')
check('列表为 undefined 不崩', T.matchBoundWorkspace(undefined, 'D:\\x'), '')

// 贴边判定（固定视口 1000x800）
fakeWindow.innerWidth = 1000
fakeWindow.innerHeight = 800
check('左上角 → 最小化', T.isAtScreenEdge({ left: 2, top: 2 }), true)
check('右上角 → 最小化', T.isAtScreenEdge({ left: 990, top: 10 }), true)
check('左下角 → 最小化', T.isAtScreenEdge({ left: 4, top: 790 }), true)
check('贴右边缘 → 最小化', T.isAtScreenEdge({ left: 900, top: 400 }), true)
check('屏幕中间 → 不最小化', T.isAtScreenEdge({ left: 500, top: 400 }), false)
check('没有位置（用默认角落）→ 不最小化', T.isAtScreenEdge(null), false)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1

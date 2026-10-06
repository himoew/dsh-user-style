// 风格档的存储与解析。
//
// 设计约束（三条都很重要，改动前请先读）：
//  1. 本文件所有函数都不得抛异常到提示词组装路径上——一次抛出会让整个会话的提示词组装失败。
//  2. 存储是单个 JSON 文件，写入用临时文件 + rename，避免半截文件。
//  3. 读取带 mtime 缓存：组装发生在每个模型步骤，不能每步都读磁盘。
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'

/** DSH 主目录：优先 DSH_HOME，否则 ~/.dsh（与官方插件一致）。 */
export function dshHome() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return configured.length > 0 ? configured : join(homedir(), '.dsh')
}

export const DATA_DIR = process.env.DSH_USER_STYLE_DATA_DIR || join(dshHome(), 'dsh-user-style')
export const STORE_FILE = join(DATA_DIR, 'store.json')
export const TRACE_FILE = join(DATA_DIR, 'trace.jsonl')
export const LAST_RENDER_FILE = join(DATA_DIR, 'last-render.txt')

/** 内置预设在第几版。改预设内容时必须 +1，否则老用户不会拿到新版本。 */
export const PRESET_REVISION = 2

/** 内置预设。用户开箱即可启用，也可自行增删改。 */
export const PRESETS = [
  {
    id: 'strict',
    name: '严谨审慎',
    summary: '目标不清楚就先跟你确认，再动手',
    items: [
      '遇到不确定的选择、模糊的需求或多种可行方案时，先停下来与我确认目标，再动手',
      '有歧义的地方不要自行假设；把歧义点和可选方案列出来让我拍板',
      '目标确认之前不要改代码、不要写文件、不要执行不可逆操作',
      '若有更好的想法，优先与我讨论，不要自己直接换掉方案',
    ],
    notes: '',
  },
  {
    id: 'fast',
    name: '快速直接',
    summary: '过程可以快，但结果必须清晰',
    items: [
      '若有更成熟的方法完成目标，直接使用，无需询问',
      '不要花长时间自检、反复验证或反复打磨；先让它跑起来',
      '功能一旦可用就尽快交给我实测，由我反馈问题，不要自己先反复优化',
      '结束时总结为什么选了这个方案（或用了别的方式），以及实际完成了哪几步',
      '过程可以快，但结果必须让我看得清楚',
    ],
    notes: '',
  },
  {
    id: 'bullets',
    name: '节点备份',
    summary: '每完成一个可运行的节点就主动备份',
    items: [
      '每完成一个可验证的节点——功能跑通、确认可以运行——就主动做一次备份，不用等我开口',
      '备份要能回退：版本控制提交，或复制出带节点名（和时间）的副本',
      '备份前先确认该节点确实可运行，不要把半成品当作节点',
      '汇报进展按节点分点说明：完成了什么、是否已验证、备份在哪',
    ],
    notes: '',
  },
  {
    id: 'teacher',
    name: '教学讲解',
    summary: '讲清为什么，循序渐进',
    items: [
      '先讲原理与取舍，再给结论或代码',
      '解释「为什么这样做」，而不只给做法',
      '循序渐进，必要时先给最小可运行示例',
      '指出常见误区与容易踩的坑',
    ],
    notes: '',
  },
]

/**
 * 第 1 版预设，只用于迁移时判断「用户有没有改过这套内置档案」。
 *
 * 为什么不直接覆盖：内置预设用户是可以改的。迁移只在存档内容与本表**完全一致**
 * （说明他没动过）时才替换成新版；只要他改过一个字，就原样保留，绝不覆盖用户的编辑。
 */
const PRESETS_V1 = [
  {
    id: 'strict',
    name: '严谨审慎',
    summary: '结论有依据，不确定就说不确定',
    items: [
      '先给结论，再给依据，不要铺垫',
      '不确定的地方明确说「不确定」，不要猜着答',
      '涉及代码时给出文件路径与行号，便于核对',
      '改动前说明影响范围与风险，不要静默改动',
    ],
    notes: '',
  },
  {
    id: 'fast',
    name: '快速直接',
    summary: '少解释，直接动手',
    items: [
      '直接动手，不要反问确认，除非涉及不可逆操作',
      '结论优先，解释控制在必要范围内',
      '不要在结尾复述已经做过的事',
      '能一步做完就不要拆成多步征求同意',
    ],
    notes: '',
  },
  {
    id: 'bullets',
    name: '分点简报',
    summary: '分点作答，一段一个节点',
    items: ['用分点作答，每点一个意思，先总后分', '每个要点控制在一到两行，不复述', '层级不超过两层，避免长段落'],
    notes: '',
  },
  {
    id: 'teacher',
    name: '教学讲解',
    summary: '讲清为什么，循序渐进',
    items: [
      '先讲原理与取舍，再给结论或代码',
      '解释「为什么这样做」，而不只给做法',
      '循序渐进，必要时先给最小可运行示例',
      '指出常见误区与容易踩的坑',
    ],
    notes: '',
  },
]

/** 忽略字段顺序的内容比较，用于判断预设有没有被用户改过。 */
function sameContent(a, b) {
  const norm = (profile) => JSON.stringify([profile.name, profile.summary, (profile.items || []).filter(Boolean), profile.notes || ''])
  return norm(a) === norm(b)
}

/**
 * 把内置预设升级到当前版本，**只动用户没改过的那几套**。
 * 用户自己新建的档案、以及他改过的内置档案，一律不动。
 * @returns {{changed: boolean, updated: string[]}} 是否需要落盘，以及被更新的档案 id。
 */
export function migratePresets(store) {
  const updated = []
  if (store.presetRevision === PRESET_REVISION) return { changed: false, updated }
  for (const preset of PRESETS) {
    const index = store.profiles.findIndex((entry) => entry.id === preset.id)
    if (index < 0) continue
    const current = store.profiles[index]
    const v1 = PRESETS_V1.find((entry) => entry.id === preset.id)
    const untouchedByUser = (v1 && sameContent(current, v1)) || sameContent(current, preset)
    if (!untouchedByUser) continue
    if (sameContent(current, preset)) continue
    store.profiles[index] = { ...preset, items: [...preset.items] }
    updated.push(preset.id)
  }
  store.presetRevision = PRESET_REVISION
  return { changed: true, updated }
}

/** 空存储（未启用任何风格档）。默认不注入任何内容，避免在用户未同意时改变所有会话的行为。 */
export function emptyStore() {
  return {
    version: 1,
    presetRevision: PRESET_REVISION,
    profiles: PRESETS.map((p) => ({ ...p, items: [...p.items] })),
    defaultProfileId: '',
    workspaceBindings: {},
    sessionOverrides: {},
  }
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function asStringArray(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string')
}

/** 容错读取：任何形状异常都退化为空值，绝不抛给调用方。 */
function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = asString(raw.id).trim()
  if (!id) return null
  return {
    id,
    name: asString(raw.name, id).trim() || id,
    summary: asString(raw.summary),
    items: asStringArray(raw.items),
    notes: asString(raw.notes),
  }
}

function normalizeStringMap(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key === 'string' && typeof value === 'string' && value) out[key] = value
  }
  return out
}

export function normalizeStore(raw) {
  const fallback = emptyStore()
  if (!raw || typeof raw !== 'object') return fallback
  const profiles = []
  const seen = new Set()
  for (const entry of Array.isArray(raw.profiles) ? raw.profiles : []) {
    const profile = normalizeProfile(entry)
    if (profile && !seen.has(profile.id)) {
      seen.add(profile.id)
      profiles.push(profile)
    }
  }
  return {
    version: 1,
    // 缺失（老版本写的文件）视为 0，于是迁移会补上当前版本并刷新内置预设。
    presetRevision: typeof raw.presetRevision === 'number' ? raw.presetRevision : 0,
    profiles,
    defaultProfileId: asString(raw.defaultProfileId),
    workspaceBindings: normalizeStringMap(raw.workspaceBindings),
    sessionOverrides: normalizeStringMap(raw.sessionOverrides),
  }
}

// ---------------------------------------------------------------- 读写与缓存

let cache = { store: null, mtimeMs: -1, size: -1, checkedAt: 0 }
const CACHE_TTL_MS = 500

/**
 * 读取存储。带 500ms 的 stat 缓存；文件被外部编辑后最多 500ms 生效。
 * @param {{force?: boolean}} [options] force 为真时跳过缓存直接读盘。
 */
export function loadStore(options = {}) {
  const now = Date.now()
  if (!options.force && cache.store && now - cache.checkedAt < CACHE_TTL_MS) return cache.store
  try {
    cache.checkedAt = now
    if (!existsSync(STORE_FILE)) {
      // 首次运行：落一份内置预设，方便用户在界面里直接选。
      const initial = emptyStore()
      try {
        saveStore(initial)
      } catch {
        /* 落盘失败也要能工作，只是这次不持久化 */
      }
      cache = { store: initial, mtimeMs: cache.mtimeMs, size: cache.size, checkedAt: now }
      return initial
    }
    const stat = statSync(STORE_FILE)
    if (cache.store && stat.mtimeMs === cache.mtimeMs && stat.size === cache.size) {
      return cache.store
    }
    const parsed = JSON.parse(readFileSync(STORE_FILE, 'utf8'))
    const store = normalizeStore(parsed)
    cache = { store, mtimeMs: stat.mtimeMs, size: stat.size, checkedAt: now }
    return store
  } catch {
    // 读坏了不能让会话崩：回退到上一份好数据，没有就用内置预设（不落盘，避免覆盖用户文件）。
    return cache.store || emptyStore()
  }
}

/** 原子写入：先写临时文件再 rename。 */
export function saveStore(store) {
  const normalized = normalizeStore(store)
  mkdirSync(DATA_DIR, { recursive: true })
  const tmp = `${STORE_FILE}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  renameSync(tmp, STORE_FILE)
  try {
    const stat = statSync(STORE_FILE)
    cache = { store: normalized, mtimeMs: stat.mtimeMs, size: stat.size, checkedAt: Date.now() }
  } catch {
    cache = { store: normalized, mtimeMs: -1, size: -1, checkedAt: Date.now() }
  }
  return normalized
}

/**
 * 读—改—写。mutator 收到的是磁盘上的最新副本，返回新存储（或不返回，原地改）。
 */
export function mutateStore(mutator) {
  const current = loadStore({ force: true })
  const draft = JSON.parse(JSON.stringify(current))
  const result = mutator(draft)
  return saveStore(result === undefined ? draft : result)
}

// ------------------------------------------------------------------ 作用域解析

function byId(store, id) {
  if (!id) return null
  return store.profiles.find((profile) => profile.id === id) || null
}

/** 路径比较键：去掉尾部分隔符，Windows 下不区分大小写。工作区匹配与列表去重都用它。 */
export function normalizePathKey(value) {
  const text = asString(value).trim()
  if (!text) return ''
  let key = text.replace(/[\\/]+$/, '')
  if (process.platform === 'win32') key = key.toLowerCase()
  return key
}

/**
 * 工作区绑定用「最长前缀 + 路径边界」匹配，避免 D:\proj 命中 D:\proj-other。
 * @returns 命中的 profileId，或空字符串。
 */
export function matchWorkspaceBinding(bindings, cwd) {
  const target = normalizePathKey(cwd)
  if (!target) return ''
  let bestKey = ''
  let bestValue = ''
  for (const [rawKey, value] of Object.entries(bindings || {})) {
    const key = normalizePathKey(rawKey)
    if (!key || !value) continue
    const isSame = target === key
    const isChild = target.startsWith(key.endsWith(sep) ? key : key + sep)
    if (!isSame && !isChild) continue
    if (key.length > bestKey.length) {
      bestKey = key
      bestValue = value
    }
  }
  return bestValue
}

/**
 * 三层作用域：会话临时覆盖 → 工作区绑定 → 全局默认。
 * @returns {{profile: object|null, source: 'session'|'workspace'|'default'|'none', sourceKey: string}}
 */
export function resolveEffectiveProfile(store, context = {}) {
  const sessionId = asString(context.sessionId).trim()
  if (sessionId) {
    const override = store.sessionOverrides[sessionId]
    const profile = byId(store, override)
    if (profile) return { profile, source: 'session', sourceKey: sessionId }
  }
  const boundId = matchWorkspaceBinding(store.workspaceBindings, context.cwd)
  const bound = byId(store, boundId)
  if (bound) return { profile: bound, source: 'workspace', sourceKey: normalizePathKey(context.cwd) }
  const fallback = byId(store, store.defaultProfileId)
  if (fallback) return { profile: fallback, source: 'default', sourceKey: store.defaultProfileId }
  return { profile: null, source: 'none', sourceKey: '' }
}

/**
 * 把风格档渲染成注入文本。返回空串时节会自行消失（不占 token）。
 */
export function renderProfile(profile) {
  if (!profile) return ''
  const items = asStringArray(profile.items).map((item) => item.trim()).filter(Boolean)
  const notes = asString(profile.notes).trim()
  if (items.length === 0 && !notes) return ''
  const lines = [
    '## 用户工作风格（User working style）',
    '以下是用户本人设定的工作偏好。除非用户在本次对话中明确另有要求，否则按此执行：',
  ]
  for (const item of items) lines.push(`- ${item}`)
  if (notes) lines.push('', notes)
  return lines.join('\n')
}

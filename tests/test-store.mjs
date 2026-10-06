// dsh-user-style 本地自检：存储、三层作用域解析、渲染。
// 用独立数据目录，绝不碰真实的 ~/.dsh/dsh-user-style。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'user-style-test-'))
process.env.DSH_USER_STYLE_DATA_DIR = sandbox

const store = await import('../lib/store.js')

let failures = 0
// 与其他测试文件保持一致：按内容比较，这样数组/对象断言才有意义。
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(actual)}`}`)
}

// 首次读取应落盘内置预设，且默认不启用任何档案（不注入 = 不改变用户现有会话行为）
const initial = store.loadStore({ force: true })
check('内置预设数量', initial.profiles.length, store.PRESETS.length)
check('默认档案为空（开箱不注入）', initial.defaultProfileId, '')
check('存储文件已落盘', store.loadStore({ force: true }).profiles.length > 0, true)

// 三层作用域：没有默认时为 none
check('无任何设置 → none', store.resolveEffectiveProfile(initial, { cwd: 'D:\\proj', sessionId: 's1' }).source, 'none')
check('无设置注入空串', store.renderProfile(null), '')

// 全局默认
store.mutateStore((draft) => { draft.defaultProfileId = 'fast' })
const withDefault = store.loadStore({ force: true })
check('设默认后 → default', store.resolveEffectiveProfile(withDefault, { cwd: 'D:\\a', sessionId: 's1' }).source, 'default')
check('默认命中 fast', store.resolveEffectiveProfile(withDefault, { cwd: 'D:\\a', sessionId: 's1' }).profile.id, 'fast')

// 工作区绑定覆盖默认，并且要按最长前缀 + 路径边界匹配
store.mutateStore((draft) => { draft.workspaceBindings['D:\\proj'] = 'strict' })
store.mutateStore((draft) => { draft.workspaceBindings['D:\\proj\\inner'] = 'teacher' })
const withBind = store.loadStore({ force: true })
check('工作区绑定 → workspace', store.resolveEffectiveProfile(withBind, { cwd: 'D:\\proj', sessionId: 's1' }).source, 'workspace')
check('最长前缀优先', store.resolveEffectiveProfile(withBind, { cwd: 'D:\\proj\\inner\\x', sessionId: 's1' }).profile.id, 'teacher')
check('子目录继承父绑定', store.resolveEffectiveProfile(withBind, { cwd: 'D:\\proj\\other', sessionId: 's1' }).profile.id, 'strict')
check('大小写不敏感', store.resolveEffectiveProfile(withBind, { cwd: 'd:\\PROJ\\other', sessionId: 's1' }).profile.id, 'strict')
check('无绑定目录回落默认', store.resolveEffectiveProfile(withBind, { cwd: 'D:\\elsewhere', sessionId: 's1' }).profile.id, 'fast')

// 前缀相邻但非子目录不得误命中（D:\proj-other 不应命中 D:\proj）
check('相邻同名前缀不误命中', store.resolveEffectiveProfile(withBind, { cwd: 'D:\\proj-other', sessionId: 's1' }).profile.id, 'fast')

// 会话覆盖优先级最高
store.mutateStore((draft) => { draft.sessionOverrides['s1'] = 'bullets' })
const withSession = store.loadStore({ force: true })
check('会话覆盖优先级最高', store.resolveEffectiveProfile(withSession, { cwd: 'D:\\proj\\inner', sessionId: 's1' }).profile.id, 'bullets')
check('其他会话不受影响', store.resolveEffectiveProfile(withSession, { cwd: 'D:\\proj\\inner', sessionId: 's2' }).profile.id, 'teacher')

// 渲染
const bullets = withSession.profiles.find((p) => p.id === 'bullets')
const rendered = store.renderProfile(bullets)
check('渲染含标题', rendered.includes('## 用户工作风格'), true)
check('渲染逐条列出', rendered.split('\n').filter((l) => l.startsWith('- ')).length, bullets.items.length)
check('空档案渲染为空', store.renderProfile({ id: 'x', items: [], notes: '' }), '')

// 预设内容（按用户确认过的版本）
const presets = Object.fromEntries(store.PRESETS.map((p) => [p.id, p]))
check('内置预设仍是 4 套', store.PRESETS.length, 4)
check('第 3 套已改名', presets.bullets.name, '节点备份')
check('严谨第 4 条是「先讨论」', presets.strict.items[presets.strict.items.length - 1].includes('优先与我讨论'), true)
check('快速直接第 1 条允许直接用成熟方法', presets.fast.items[0], '若有更成熟的方法完成目标，直接使用，无需询问')
check('快速直接含结尾总结要求', presets.fast.items.some((i) => i.includes('结束时总结')), true)
check('快速直接含「过程可以快」', presets.fast.items.some((i) => i.includes('过程可以快')), true)
check('教学这套保持原样', presets.teacher.items.length, 4)

// 预设迁移：只刷新用户没改过的那几套，绝不覆盖用户的编辑
const fresh = store.emptyStore()
check('新存储带当前预设版本', fresh.presetRevision, store.PRESET_REVISION)
check('已是当前版本时无需变更', store.migratePresets(fresh).changed, false)

// 老档案（无 presetRevision）+ 未改过的内置预设 → 应被刷新
const legacy = {
  version: 1,
  profiles: [
    { id: 'strict', name: '严谨审慎', summary: '结论有依据，不确定就说不确定', items: ['先给结论，再给依据，不要铺垫', '不确定的地方明确说「不确定」，不要猜着答', '涉及代码时给出文件路径与行号，便于核对', '改动前说明影响范围与风险，不要静默改动'], notes: '' },
    { id: 'bullets', name: '分点简报', summary: '分点作答，一段一个节点', items: ['用分点作答，每点一个意思，先总后分', '每个要点控制在一到两行，不复述', '层级不超过两层，避免长段落'], notes: '' },
  ],
  defaultProfileId: '',
  workspaceBindings: {},
  sessionOverrides: {},
}
const legacyClone = JSON.parse(JSON.stringify(legacy))
const migrated = store.migratePresets(legacyClone)
check('老档案会被迁移', migrated.changed, true)
check('两套未改过的预设被刷新', [...migrated.updated].sort(), ['bullets', 'strict'])
check('迁移后名字已更新', legacyClone.profiles.find((p) => p.id === 'bullets').name, '节点备份')
check('迁移后条目已更新', legacyClone.profiles.find((p) => p.id === 'strict').items[3], '若有更好的想法，优先与我讨论，不要自己直接换掉方案')
check('未改动的档案数不变', legacyClone.profiles.length, 2)

// 老档案 + 用户改过其中一套 → 那套保留
const edited = JSON.parse(JSON.stringify(legacy))
edited.profiles[0].items = ['我自己的规矩：先问我']
edited.profiles[0].name = '我的严谨'
const migrated2 = store.migratePresets(edited)
check('改过的那套不被覆盖', edited.profiles[0].items[0], '我自己的规矩：先问我')
check('改过的那套名字也没被改', edited.profiles[0].name, '我的严谨')
check('未改过的另一套仍被刷新', migrated2.updated, ['bullets'])

// 老档案 + 用户自建档案 → 完全不动
const custom = JSON.parse(JSON.stringify(legacy))
custom.profiles.push({ id: 'mine', name: '我的档', summary: '', items: ['一条'], notes: '备注' })
store.migratePresets(custom)
check('用户自建档案原样保留', custom.profiles.find((p) => p.id === 'mine').items, ['一条'])

// 脏数据不得崩：全部走容错路径
check('脏数据→空存储', store.normalizeStore({ profiles: 'oops' }).profiles.length, 0)
check('脏档案被丢弃', store.normalizeStore({ profiles: [{ name: 'no-id' }] }).profiles.length, 0)
check('脏映射被清洗', Object.keys(store.normalizeStore({ workspaceBindings: { a: 1, b: 'x' } }).workspaceBindings).length, 1)
check('缺失对象→内置预设', store.normalizeStore(null).profiles.length, store.PRESETS.length)
check('老归档缺 presetRevision 视为 0', store.normalizeStore({ profiles: [] }).presetRevision, 0)
check('presetRevision 会被读出', store.normalizeStore({ presetRevision: 7 }).presetRevision, 7)

rmSync(sandbox, { recursive: true, force: true })
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1

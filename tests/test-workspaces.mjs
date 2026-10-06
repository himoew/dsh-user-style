// 工作区列表的测试。
//
// 用 DSH_HOME 指向沙箱，在里面造一份 storages/workspace.json，
// 验证解析、排序、当前工作区兜底、以及文件缺失时的降级——**绝不读你真实的 ~/.dsh**。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'user-style-ws-'))
process.env.DSH_HOME = sandbox

const { listWorkspaces } = await import('../lib/workspaces.js')

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(actual)}`}`)
}

// 1) 文件缺失：不抛错，只剩当前工作区
const empty = listWorkspaces('D:\\nowhere')
check('缺文件时不抛错', typeof empty.readError, 'string')
check('缺文件时只剩当前工作区', empty.workspaces.length, 1)
check('兜底项被标记为当前', empty.workspaces[0].isCurrent, true)
check('兜底项 path 正确', empty.workspaces[0].path, 'D:\\nowhere')
check('兜底项标记 synthesized', empty.workspaces[0].synthesized, true)
check('没有当前工作区时列表为空', listWorkspaces('').workspaces.length, 0)

// 2) 造一份真实形状的工作区文档
mkdirSync(join(sandbox, 'storages'), { recursive: true })
const doc = {
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, defaultWorkspaceId: 'ws-A', workspaceIds: ['ws-A', 'ws-B', 'ws-C'] },
  tables: {
    workspaces: {
      'ws-A': {
        path: 'C:\\Users\\Never\\Documents\\deepseek-harness\\default-workspace',
        title: 'default-workspace',
        sessionIds: ['s1', 's2', 's3'],
        createdAt: '2026-10-04T08:44:07.352Z',
        updatedAt: '2026-10-06T01:10:09.920Z',
      },
      'ws-B': {
        path: "D:\\Blue fish's work",
        title: "Blue fish's work",
        sessionIds: ['s4'],
        createdAt: '2026-10-04T08:45:42.140Z',
        updatedAt: '2026-10-06T01:49:09.422Z',
      },
      'ws-C': {
        path: "D:\\New-Blue fish's work\\User Plugin",
        title: 'User Plugin',
        sessionIds: ['s5', 's6'],
        createdAt: '2026-10-06T04:06:30.546Z',
        updatedAt: '2026-10-06T04:37:07.709Z',
      },
      // 脏数据必须被跳过而不是整份失败
      'ws-broken': { title: 'no path', sessionIds: [] },
    },
  },
}
writeFileSync(join(sandbox, 'storages', 'workspace.json'), JSON.stringify(doc, null, 2), 'utf8')

const listed = listWorkspaces("D:\\New-Blue fish's work\\User Plugin")
check('读到全部工作区（脏数据被跳过）', listed.workspaces.length, 3)
check('没有读取错误', listed.readError, '')
check('当前工作区排最前', listed.workspaces[0].path, "D:\\New-Blue fish's work\\User Plugin")
check('当前工作区被标记', listed.workspaces[0].isCurrent, true)
check('只有一个被标记为当前', listed.workspaces.filter((w) => w.isCurrent).length, 1)
check('其余按最近使用倒序', listed.workspaces.map((w) => w.title), ['User Plugin', "Blue fish's work", 'default-workspace'])
check('会话数被读出', listed.workspaces[0].sessionCount, 2)
check('默认工作区被标记', listed.workspaces.filter((w) => w.isDefault).map((w) => w.title), ['default-workspace'])
check('非当前项 isCurrent 为假', listed.workspaces[1].isCurrent, false)

// 3) 大小写与尾部分隔符不影响「当前」判定（Windows）
const messy = listWorkspaces('d:\\new-blue fish\'s work\\user plugin\\')
check('大小写/尾部分隔符不敏感', messy.workspaces.filter((w) => w.isCurrent).length, 1)
check('没有因此多出一项', messy.workspaces.length, 3)

// 4) 当前工作区不在台账里 → 合成一项并排最前
const synthetic = listWorkspaces('D:\\brand-new-place')
check('合成当前工作区', synthetic.workspaces.length, 4)
check('合成项排最前', synthetic.workspaces[0].path, 'D:\\brand-new-place')
check('合成项标记 synthesized', synthetic.workspaces[0].synthesized, true)
check('原有三项仍在', synthetic.workspaces.filter((w) => !w.synthesized).length, 3)

// 5) 坏 JSON → 降级而不是抛错
writeFileSync(join(sandbox, 'storages', 'workspace.json'), '{ not json', 'utf8')
const broken = listWorkspaces('D:\\x')
check('坏 JSON 不抛错', typeof broken.readError, 'string')
check('坏 JSON 时只剩当前工作区', broken.workspaces.length, 1)

rmSync(sandbox, { recursive: true, force: true })
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1

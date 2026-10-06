// 读取 DSH 已知的工作区列表。
//
// 真源：<DSH_HOME>/storages/workspace.json（工作区单元的持久化文档）。结构：
//   { global: { defaultWorkspaceId, workspaceIds: [...] },
//     tables: { workspaces: { "<uuid>": { path, title, sessionIds, createdAt, updatedAt } } } }
//
// 这个文件只是「一个提示」而不是硬依赖：读不到就退回「只有当前工作区」，
// 界面仍然可用，只是不能从列表里挑别的。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome, normalizePathKey } from './store.js'

export const WORKSPACE_STORE_FILE = join(dshHome(), 'storages', 'workspace.json')

/**
 * 列出已知工作区，当前工作区排在最前，其余按最近使用倒序。
 * @param currentCwd - 当前会话的工作区路径（可能为空）。
 */
export function listWorkspaces(currentCwd) {
  const currentKey = normalizePathKey(currentCwd)
  const byPath = new Map()
  let readError = ''

  try {
    const raw = JSON.parse(readFileSync(WORKSPACE_STORE_FILE, 'utf8'))
    const table = raw && raw.tables && raw.tables.workspaces && typeof raw.tables.workspaces === 'object' ? raw.tables.workspaces : {}
    const defaultId = raw && raw.global ? raw.global.defaultWorkspaceId : ''
    for (const [id, entry] of Object.entries(table)) {
      if (!entry || typeof entry.path !== 'string' || !entry.path) continue
      const key = normalizePathKey(entry.path)
      if (byPath.has(key)) continue
      byPath.set(key, {
        id,
        path: entry.path,
        title: typeof entry.title === 'string' ? entry.title : '',
        sessionCount: Array.isArray(entry.sessionIds) ? entry.sessionIds.length : 0,
        updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
        isDefault: id === defaultId,
        synthesized: false,
      })
    }
  } catch (err) {
    // 文件不存在或读坏了：不抛错，靠下面的兜底让界面还能用。
    readError = String((err && err.message) || err)
  }

  // 当前工作区必须在列表里——即使它还没被登记，或者存储根本读不到。
  if (currentKey && !byPath.has(currentKey)) {
    byPath.set(currentKey, {
      id: '',
      path: currentCwd,
      title: '',
      sessionCount: 0,
      updatedAt: '',
      isDefault: false,
      synthesized: true,
    })
  }

  const list = [...byPath.values()].map((entry) => ({
    ...entry,
    isCurrent: normalizePathKey(entry.path) === currentKey,
  }))

  list.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
    const at = a.updatedAt || ''
    const bt = b.updatedAt || ''
    if (at !== bt) return at < bt ? 1 : -1
    return a.path.localeCompare(b.path)
  })

  return { workspaces: list, readError }
}

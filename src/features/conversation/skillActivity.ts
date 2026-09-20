import type { CodexSkill, ThreadItem } from '../../core/domain/codex'

export interface SkillRead {
  path: string
  name: string
}

function normalizedPath(path: string): string {
  const parts: string[] = []
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '.') continue
    if (part === '..' && parts.length > 1) parts.pop()
    else parts.push(part)
  }
  return parts.join('/')
}

// Only use App Server's parsed read actions. A mention in shell text is not a read.
export function skillReads(item: ThreadItem, catalog: readonly CodexSkill[] = []): SkillRead[] {
  if (item.type !== 'commandExecution' || !Array.isArray(item.commandActions)) return []
  const reads = new Map<string, SkillRead>()
  for (const action of item.commandActions) {
    if (!action || typeof action !== 'object' || action.type !== 'read' || typeof action.path !== 'string') continue
    const path = normalizedPath(/^(\/|[A-Za-z]:[\\/])/.test(action.path) ? action.path : `${item.cwd ?? ''}/${action.path}`)
    if (path.split('/').at(-1) !== 'SKILL.md') continue
    const skill = catalog.find((candidate) => normalizedPath(candidate.path) === path)
    reads.set(path, { path, name: skill?.name ?? path.split('/').at(-2) ?? 'SKILL.md' })
  }
  return [...reads.values()]
}

export function skillReadStatus(item: ThreadItem): string {
  if (item.status === 'inProgress') return '读取中'
  if (item.status === 'declined') return '未读取'
  if (item.status === 'interrupted') return '已中断'
  if (item.status === 'failed' || (item.exitCode != null && item.exitCode !== 0)) return '读取失败'
  if (item.exitCode === 0) return '已读取'
  return '结果未确认'
}

import { itemText } from '../domain/codex'
import { appServer } from '../runtime/appServerClient'
import { runtime } from '../runtime/bridge'
import { hydrateClaudeHistory } from '../claude/history'
import type { OnboardingSource } from './types'

/** Read persisted history, including pages that were never loaded into the UI. */
export async function onboardingHistory(source: OnboardingSource): Promise<string[]> {
  if (source.threadId.startsWith('claude:')) {
    const session = (await runtime.listClaudeSessions()).find(s => s.id === source.threadId)
    if (!session?.providerSessionId) throw new Error('该 Claude 会话还没有可读取的历史')
    const history = await runtime.readClaudeHistory(session.id, session.cwd, session.providerSessionId)
    return hydrateClaudeHistory(history.messages).items
      .filter(e => ['userMessage', 'agentMessage', 'commandExecution', 'mcpToolCall'].includes(e.item.type))
      .flatMap(e => { const text = itemText(e.item).trim(); return text ? [`${e.item.type}:\n${text}`] : [] })
  }
  let cursor: string | null = null
  const cursors = new Set<string>(), seen = new Set<string>(), messages: string[] = []
  do {
    const page = await appServer.listTurns({ threadId: source.threadId, cursor, limit: 20, sortDirection: 'asc', itemsView: 'full' })
    for (const turn of page.data) {
      if (seen.has(turn.id)) continue
      seen.add(turn.id)
      if (turn.status === 'inProgress') messages.push('当前轮次仍在执行，以下记录不代表任务已经完成。')
      for (const item of turn.items) {
        if (!['userMessage', 'agentMessage', 'commandExecution', 'mcpToolCall'].includes(item.type)) continue
        const text = itemText(item).trim()
        if (text) messages.push(`${item.type}:\n${text}`)
      }
    }
    cursor = page.nextCursor
    if (cursor && cursors.has(cursor)) throw new Error('历史分页未前进，已停止；没有省略早期对话')
    if (cursor) cursors.add(cursor)
  } while (cursor)
  return messages
}

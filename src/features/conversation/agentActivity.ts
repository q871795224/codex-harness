import type { ThreadItemEntry } from '../../core/domain/codex'

export interface NativeAgentActivity {
  threadId: string
  tool: string
  status: string
  task: string
  message: string
  approvalCount: number
}

export function collectNativeAgentActivities(
  items: ThreadItemEntry[],
  approvalCounts: Readonly<Record<string, number>>,
): NativeAgentActivity[] {
  const activities = new Map<string, NativeAgentActivity>()
  for (const { item } of items) {
    if (item.type !== 'collabAgentToolCall' || !Array.isArray(item.receiverThreadIds)) continue
    const task = typeof item.prompt === 'string' ? item.prompt.trim() : ''
    for (const threadId of item.receiverThreadIds) {
      if (typeof threadId !== 'string' || !threadId) continue
      const previous = activities.get(threadId)
      const state = item.agentsStates?.[threadId]
      activities.set(threadId, {
        threadId,
        tool: typeof item.tool === 'string' ? item.tool : previous?.tool ?? '',
        status: state?.status ?? item.status ?? previous?.status ?? '',
        task: task || previous?.task || '',
        message: state?.message?.trim() || previous?.message || '',
        approvalCount: approvalCounts[threadId] ?? 0,
      })
    }
  }
  return [...activities.values()]
}

import type {
  ActivePermissionProfile,
  SandboxPolicy,
  Thread,
  ThreadCodexSettings,
  ThreadDetail,
  ThreadItem,
  ThreadItemEntry,
  Turn,
} from '../../core/domain/codex'

export type ThreadDetailEvent =
  | { type: 'settingsUpdated'; cwd: string; sandbox?: SandboxPolicy; activePermissionProfile: ActivePermissionProfile | null; model: string | null; threadSettings: Partial<ThreadCodexSettings> }
  | { type: 'statusChanged'; status: Thread['status'] }
  | { type: 'nameUpdated'; name: string | null }
  | { type: 'turnStarted'; turn: Turn }
  | { type: 'itemUpserted'; turnId: string; item: ThreadItem }
  | { type: 'agentMessageDelta'; itemId: string; delta: string }
  | { type: 'commandOutputDelta'; itemId: string; delta: string }
  | { type: 'turnCompleted'; turn: Turn }

export function reduceThreadDetailEvent(detail: ThreadDetail, event: ThreadDetailEvent): ThreadDetail {
  if (event.type === 'settingsUpdated') {
    return {
      ...detail,
      thread: { ...detail.thread, cwd: event.cwd, gitInfo: null },
      runtimeWorkspaceRoots: [event.cwd],
      sandbox: event.sandbox ?? detail.sandbox,
      activePermissionProfile: event.activePermissionProfile,
      model: event.model ?? detail.model,
      threadSettings: Object.keys(event.threadSettings).length > 0
        ? { ...(detail.threadSettings ?? {}), ...event.threadSettings }
        : detail.threadSettings,
    }
  }
  if (event.type === 'statusChanged') {
    return { ...detail, thread: { ...detail.thread, status: event.status } }
  }
  if (event.type === 'nameUpdated') {
    return { ...detail, thread: { ...detail.thread, name: event.name } }
  }
  if (event.type === 'turnStarted') {
    return {
      ...detail,
      turns: upsertTurn(detail.turns, event.turn),
      items: event.turn.items.reduce((items, item) => upsertItem(items, event.turn.id, item), detail.items),
    }
  }
  if (event.type === 'itemUpserted') {
    return { ...detail, items: upsertItem(detail.items, event.turnId, event.item) }
  }
  if (event.type === 'agentMessageDelta') {
    return {
      ...detail,
      items: updateItem(detail.items, event.itemId, (item) => ({ ...item, text: `${item.text ?? ''}${event.delta}` })),
    }
  }
  if (event.type === 'commandOutputDelta') {
    return {
      ...detail,
      items: updateItem(detail.items, event.itemId, (item) => ({ ...item, aggregatedOutput: `${item.aggregatedOutput ?? ''}${event.delta}` })),
    }
  }
  return {
    ...detail,
    turns: upsertTurn(detail.turns, event.turn),
    items: event.turn.items.reduce((items, item) => upsertItem(items, event.turn.id, item), detail.items),
    activeTurnId: detail.activeTurnId === event.turn.id ? null : detail.activeTurnId,
    foreignActive: detail.activeTurnId === event.turn.id ? false : detail.foreignActive,
  }
}

function upsertItem(items: ThreadItemEntry[], turnId: string, nextItem: ThreadItem): ThreadItemEntry[] {
  const id = typeof nextItem.id === 'string' ? nextItem.id : null
  if (!id) return [...items, { turnId, item: nextItem }]
  const found = items.findIndex((entry) => entry.item.id === id)
  if (found < 0) return [...items, { turnId, item: nextItem }]
  const copy = [...items]
  copy[found] = { turnId, item: { ...copy[found].item, ...nextItem } }
  return copy
}

function upsertTurn(turns: Turn[], nextTurn: Turn): Turn[] {
  const index = turns.findIndex((turn) => turn.id === nextTurn.id)
  if (index < 0) return [...turns, nextTurn]
  const copy = [...turns]
  const current = copy[index]
  copy[index] = {
    ...current,
    ...nextTurn,
    // A turn/started event can omit items already hydrated from history.
    items: nextTurn.items.length > 0 ? nextTurn.items : current.items,
  }
  return copy
}

function updateItem(items: ThreadItemEntry[], itemId: string, update: (item: ThreadItem) => ThreadItem): ThreadItemEntry[] {
  return items.map((entry) => entry.item.id === itemId ? { ...entry, item: update(entry.item) } : entry)
}

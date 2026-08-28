export function parseConversationTabOrder(raw: string | null): string[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw)
    return Array.isArray(value)
      ? [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0))]
      : []
  } catch {
    return []
  }
}

export function orderConversationTabs(visibleIds: string[], savedOrder: string[]): string[] {
  const visible = new Set(visibleIds)
  const ordered = savedOrder.filter((id) => visible.has(id))
  const known = new Set(ordered)
  return [...ordered, ...visibleIds.filter((id) => !known.has(id))]
}

export function reorderConversationTabs(
  visibleIds: string[],
  savedOrder: string[],
  draggedId: string,
  targetId: string,
  edge: 'before' | 'after' = 'before',
): string[] {
  if (draggedId === targetId) return savedOrder
  const ordered = [...visibleIds]
  const from = ordered.indexOf(draggedId)
  if (from < 0 || !ordered.includes(targetId)) return savedOrder
  ordered.splice(from, 1)
  const target = ordered.indexOf(targetId)
  ordered.splice(target + (edge === 'after' ? 1 : 0), 0, draggedId)
  const visible = new Set(ordered)
  return [...ordered, ...savedOrder.filter((id) => !visible.has(id))]
}

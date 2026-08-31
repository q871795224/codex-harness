import type { ThreadDetail, Turn } from '../../core/domain/codex'

export function prependOlderTurns(
  detail: ThreadDetail,
  page: { data: Turn[]; nextCursor: string | null },
): ThreadDetail {
  const olderTurns = [...page.data].reverse()
  const olderItems = olderTurns.flatMap((turn) => turn.items.map((item) => ({ turnId: turn.id, item })))
  return {
    ...detail,
    turns: olderTurns.concat(detail.turns),
    items: [...olderItems, ...detail.items],
    nextTurnsCursor: page.nextCursor,
  }
}

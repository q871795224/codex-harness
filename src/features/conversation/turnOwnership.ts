export interface ActiveTurnOwnership {
  activeTurnIds: Record<string, string>
  ownedActiveThreads: Record<string, boolean>
}

export function activateTurn(
  current: ActiveTurnOwnership,
  threadId: string,
  turnId: string,
  owned: boolean,
): ActiveTurnOwnership {
  return {
    activeTurnIds: { ...current.activeTurnIds, [threadId]: turnId },
    ownedActiveThreads: { ...current.ownedActiveThreads, [threadId]: owned },
  }
}

export function syncResumedTurn(
  current: ActiveTurnOwnership,
  threadId: string,
  activeTurnId: string | null,
): ActiveTurnOwnership {
  if (activeTurnId) {
    const owned = current.activeTurnIds[threadId] === activeTurnId
      && current.ownedActiveThreads[threadId] === true
    return activateTurn(current, threadId, activeTurnId, owned)
  }
  const activeTurnIds = { ...current.activeTurnIds }
  const ownedActiveThreads = { ...current.ownedActiveThreads }
  delete activeTurnIds[threadId]
  delete ownedActiveThreads[threadId]
  return { activeTurnIds, ownedActiveThreads }
}

export function completeTurn(
  current: ActiveTurnOwnership,
  threadId: string,
  completedTurnId: string | null,
): ActiveTurnOwnership {
  if (!completedTurnId || current.activeTurnIds[threadId] !== completedTurnId) return current
  const activeTurnIds = { ...current.activeTurnIds }
  const ownedActiveThreads = { ...current.ownedActiveThreads }
  delete activeTurnIds[threadId]
  delete ownedActiveThreads[threadId]
  return { activeTurnIds, ownedActiveThreads }
}

export function ownsStartedTurn(
  current: ActiveTurnOwnership,
  threadId: string,
  turnId: string,
  locallyStarting: boolean,
): boolean {
  return locallyStarting
    || (current.activeTurnIds[threadId] === turnId && current.ownedActiveThreads[threadId] === true)
}

export function completedForeignActive(
  activeTurnId: string | null,
  foreignActive: boolean,
  completedTurnId: string,
): boolean {
  return activeTurnId === completedTurnId ? false : foreignActive
}

export function deriveForeignActive(
  activeTurnId: string | null,
  owned: boolean,
): boolean {
  return Boolean(activeTurnId) && !owned
}

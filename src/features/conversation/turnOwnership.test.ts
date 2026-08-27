import { describe, expect, it } from 'vitest'
import {
  activateTurn,
  completeTurn,
  completedForeignActive,
  deriveForeignActive,
  ownsStartedTurn,
  syncResumedTurn,
  type ActiveTurnOwnership,
} from './turnOwnership'

const emptyOwnership = (): ActiveTurnOwnership => ({ activeTurnIds: {}, ownedActiveThreads: {} })

describe('turn ownership', () => {
  it('keeps a local turn owned when turn/started arrives after turn/start returns', () => {
    const afterResponse = activateTurn(emptyOwnership(), 'thread-1', 'turn-1', true)

    expect(ownsStartedTurn(afterResponse, 'thread-1', 'turn-1', false)).toBe(true)
  })

  it('marks an unrelated external turn as foreign', () => {
    const staleLocalTurn = activateTurn(emptyOwnership(), 'thread-1', 'turn-old', true)
    const externalOwned = ownsStartedTurn(staleLocalTurn, 'thread-1', 'turn-external', false)
    const externalTurn = activateTurn(staleLocalTurn, 'thread-1', 'turn-external', externalOwned)

    expect(externalOwned).toBe(false)
    expect(deriveForeignActive('turn-external', externalOwned)).toBe(true)
    expect(externalTurn.ownedActiveThreads['thread-1']).toBe(false)
  })

  it('clears ownership and foreign read-only state when the matching turn completes', () => {
    const active = activateTurn(emptyOwnership(), 'thread-1', 'turn-1', false)
    const completed = completeTurn(active, 'thread-1', 'turn-1')
    const detailForeign = completedForeignActive('turn-1', true, 'turn-1')

    expect(completed.activeTurnIds['thread-1']).toBeUndefined()
    expect(completed.ownedActiveThreads['thread-1']).toBeUndefined()
    expect(deriveForeignActive(null, false)).toBe(false)
    expect(deriveForeignActive('turn-new', true)).toBe(false)
  })

  it('clears stale ownership when a resumed thread has no active turn', () => {
    const active = activateTurn(emptyOwnership(), 'thread-1', 'turn-1', true)

    expect(syncResumedTurn(active, 'thread-1', null)).toEqual(emptyOwnership())
  })
})

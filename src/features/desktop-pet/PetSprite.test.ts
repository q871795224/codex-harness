import { expect, it } from 'vitest'
import { petFrame } from './PetSprite'

it('uses the Codex v1 activity rows and v2 look directions', () => {
  expect(petFrame({ version: 1, idleFrames: 6 }, 'waiting', 2)).toEqual({ row: 6, col: 2, rows: 9 })
  expect(petFrame({ version: 2, idleFrames: 6 }, 'idle', 0, 15)).toEqual({ row: 10, col: 7, rows: 11 })
  expect(petFrame({ version: 2, idleFrames: 6 }, 'ready', 3, 15)).toEqual({ row: 8, col: 3, rows: 11 })
})

it('falls back to user-supplied idle frames while preserving activity badges', () => {
  expect(petFrame({ version: 0, idleFrames: 9 }, 'failed', 8)).toEqual({ row: 1, col: 0, rows: 2 })
})

import { expect, it } from 'vitest'
import { dafeiyuArtwork, petLayout } from './dafeiyuLayout'
import layout from '../../../src-tauri/pets/dafeiyu/layout.json'

it('uses fixed profiles only for the built-in Dafeiyu', () => {
  const fish = { source: 'builtin' as const, directory: 'dafeiyu' }
  expect(petLayout(fish, true)).toBe('dafeiyu-video')
  expect(petLayout(fish, false)).toBe('dafeiyu-still')
  expect(petLayout({ ...fish, source: 'harness' }, true)).toBe('original')
  expect(petLayout({ ...fish, directory: 'another-pet' }, false)).toBe('original')
  expect(petLayout(undefined, true)).toBe('original')
})

it('uses a measured fixed frame and preserves the original artwork scale', () => {
  expect([layout.still.width, layout.still.height]).toEqual([72, 90])
  expect([layout.video.width, layout.video.height]).toEqual([48, 54])
  const style = dafeiyuArtwork(true)
  // In a 48 × 54 window the original artwork remains 123 × 133 at (-37, -43).
  expect(parseFloat(String(style.width)) * 48 / 100).toBeCloseTo(123)
  expect(parseFloat(String(style.height)) * 54 / 100).toBeCloseTo(133)
  expect(parseFloat(String(style.left)) * 48 / 100).toBeCloseTo(-37)
  expect(parseFloat(String(style.top)) * 54 / 100).toBeCloseTo(-43)
})

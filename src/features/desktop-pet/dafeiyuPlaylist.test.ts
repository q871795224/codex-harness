import { afterEach, expect, it, vi } from 'vitest'
import movies from '../../../src-tauri/pets/dafeiyu/movies.json'
import { nextDafeiyuClip } from './dafeiyuPlaylist'

afterEach(() => vi.restoreAllMocks())

it('uses breathing and calm clips for bridges and keeps them out of the main action pool', () => {
  const bridges = new Set<string | null>()
  const random = vi.spyOn(Math, 'random')
  for (let i = 0; i < 100; i++) {
    random.mockReturnValue(i / 100)
    const bridge = nextDafeiyuClip(89, 'bridge', -1)
    bridges.add(bridge === null ? null : movies.idle[bridge])
    const action = nextDafeiyuClip(89, 'action', null)
    expect(action).not.toBeNull()
    expect(['哈欠连天.mov', '悠闲哼歌.mov', '碎碎念-发呆碎碎念.mov']).not.toContain(movies.idle[action!])
  }
  expect(bridges).toEqual(new Set([null, '哈欠连天.mov', '悠闲哼歌.mov', '碎碎念-发呆碎碎念.mov']))
})

it('avoids the previous clip when alternatives exist and handles a small catalog', () => {
  vi.spyOn(Math, 'random').mockReturnValue(0)
  expect(nextDafeiyuClip(89, 'action', 0)).toBe(1)
  expect(nextDafeiyuClip(89, 'bridge', null)).not.toBeNull()
  expect(nextDafeiyuClip(1, 'action', 0)).toBe(0)
  expect(nextDafeiyuClip(1, 'bridge', null)).toBeNull()
  expect(nextDafeiyuClip(0, 'action', null)).toBeNull()
})

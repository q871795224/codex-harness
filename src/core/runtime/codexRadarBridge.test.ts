import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
import { invoke } from '@tauri-apps/api/core'
import { runtime } from './bridge'

beforeEach(() => { vi.mocked(invoke).mockReset() })

it('passes explicit cache versus forced-refresh intent to native Radar', async () => {
  const table = { rows: [], fetchedAt: 42, warnings: ['fixture failure'] }
  vi.mocked(invoke).mockResolvedValue(table)
  expect(await runtime.codexRadarModelTable()).toEqual(table)
  expect(invoke).toHaveBeenLastCalledWith('codex_radar_model_table', { force: false })
  expect(await runtime.codexRadarModelTable(true)).toEqual(table)
  expect(invoke).toHaveBeenLastCalledWith('codex_radar_model_table', { force: true })
  vi.mocked(invoke).mockRejectedValue('HTTP 502')
  await expect(runtime.codexRadarModelTable(true)).rejects.toBe('HTTP 502')
})

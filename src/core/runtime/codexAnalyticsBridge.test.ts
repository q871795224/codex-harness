import { expect, it, vi } from 'vitest'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))
import { invoke } from '@tauri-apps/api/core'
import { runtime } from './bridge'
it('passes typed query and counter settings to native commands', async () => {
  const query = { since: 1, until: 2, model: 'fixture', threadId: 't', kind: 'skill' as const, name: 'demo', offset: 50 }
  await runtime.codexAnalyticsSnapshot(query)
  expect(invoke).toHaveBeenCalledWith('codex_analytics_snapshot', { query })
  await runtime.codexAnalyticsConfigure('local')
  expect(invoke).toHaveBeenCalledWith('codex_analytics_configure', { mode: 'local' })
})

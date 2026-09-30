// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appServer } from '../../core/runtime/appServerClient'
import { ThreadPermissionsSaveError } from '../../core/runtime/threadPermissions'
import { useCodexCore } from './useCodexCore'
import { yoloModeSettings } from './yoloMode'

vi.mock('../../core/runtime/bridge', () => ({ runtime: { listenEvents: vi.fn(async () => () => {}) } }))
vi.mock('../../core/runtime/appServerClient', () => ({ appServer: {
  listModels: vi.fn(), readConfig: vi.fn(), listMcpServers: vi.fn(), updateThreadSettings: vi.fn(),
} }))

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(appServer.listModels).mockResolvedValue({ data: [], nextCursor: null })
  vi.mocked(appServer.readConfig).mockResolvedValue({ config: { model: 'test', model_reasoning_effort: null, approval_policy: 'on-request', sandbox_mode: 'workspace-write' } })
  vi.mocked(appServer.listMcpServers).mockResolvedValue({ data: [] })
})
afterEach(cleanup)

it.each([
  { error: new Error('request rejected'), expectedSandbox: 'workspace-write' },
  { error: new ThreadPermissionsSaveError('disk full'), expectedSandbox: 'danger-full-access' },
])('keeps the UI consistent with the server after $error.message', async ({ error, expectedSandbox }) => {
  const { result } = renderHook(() => useCodexCore())
  await waitFor(() => expect(result.current.loading).toBe(false))
  vi.mocked(appServer.updateThreadSettings).mockRejectedValueOnce(error)
  await act(async () => {
    await expect(result.current.updateThreadSettings('thread', yoloModeSettings(true))).rejects.toBe(error)
  })
  expect(result.current.settingsForThread('thread').sandboxMode).toBe(expectedSandbox)
  expect(result.current.error).toBe(error.message)
})

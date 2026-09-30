import { expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { runtime } from './bridge'
import { appServer } from './appServerClient'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

it('uses persisted permissions for both conversation resumes and quick Agent inspection', async () => {
  const database = new Map<string, string>()
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const params = args as Record<string, unknown>
    if (command === 'get_app_state') return database.get(params.key as string) ?? null
    if (command === 'set_app_state') { database.set(params.key as string, params.value as string); return }
    if (command === 'app_server_request') return { thread: { id: 'a', status: { type: 'idle' }, turns: [] } }
    throw new Error(`Unexpected command: ${command}`)
  })
  await appServer.updateThreadSettings({
    threadId: 'a', approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' },
  })
  await appServer.resumeThread({ threadId: 'a', excludeTurns: true, initialTurnsPage: { limit: 5 } })
  expect(invoke).toHaveBeenLastCalledWith('app_server_request', {
    method: 'thread/resume',
    params: {
      threadId: 'a', approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access',
      excludeTurns: true, initialTurnsPage: { limit: 5, itemsView: 'summary' },
    },
  })
  expect(await runtime.inspectCodexThread('a')).toEqual({ active: false, lastTurnStatus: null })
  expect(invoke).toHaveBeenLastCalledWith('app_server_request', {
    method: 'thread/resume',
    params: {
      threadId: 'a', approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access',
      excludeTurns: true, initialTurnsPage: { limit: 1, sortDirection: 'desc', itemsView: 'summary' },
    },
  })
})

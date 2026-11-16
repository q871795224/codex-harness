import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppServerEvent } from '../../core/domain/codex'
import { createProjectDocService } from '../../core/project-docs/service'
import { appServer } from '../../core/runtime/appServerClient'
import { runtime } from '../../core/runtime/bridge'
import { compactProject } from './compaction'
import { DEFAULT_PROJECT_DOC_CONFIG } from './config'

vi.mock('../../core/runtime/appServerClient', () => ({ appServer: {
  startThread: vi.fn(), startTurn: vi.fn(), interruptTurn: vi.fn(), unsubscribeThread: vi.fn(),
} }))
vi.mock('../../core/runtime/bridge', () => ({ runtime: {
  listenEvents: vi.fn(), projectDocBeginCompaction: vi.fn(),
  projectDocCompleteCompaction: vi.fn(), projectDocCancelCompaction: vi.fn(),
} }))

let onEvent: (event: AppServerEvent) => void
const unlisten = vi.fn()
const deps = () => ({ docs: createProjectDocService(), config: DEFAULT_PROJECT_DOC_CONFIG })

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(runtime.projectDocBeginCompaction).mockResolvedValue({
    jobId: 'job', baseSeq: 4, content: 'original', archivePath: '/archive/original.md', tokens: 20_000,
  })
  vi.mocked(runtime.projectDocCompleteCompaction).mockResolvedValue({
    newSeq: 5, beforeTokens: 20_000, afterTokens: 4000, archivePath: '/archive/original.md',
  })
  vi.mocked(runtime.projectDocCancelCompaction).mockResolvedValue(undefined)
  vi.mocked(appServer.startThread).mockResolvedValue({ thread: { id: 'temporary', ephemeral: true } } as never)
  vi.mocked(appServer.startTurn).mockResolvedValue({ turn: { id: 'turn', status: 'inProgress' } } as never)
  vi.mocked(appServer.unsubscribeThread).mockResolvedValue(undefined)
  vi.mocked(appServer.interruptTurn).mockResolvedValue(undefined)
  vi.mocked(runtime.listenEvents).mockImplementation(async (listener) => { onEvent = listener; return unlisten })
})
afterEach(() => vi.useRealTimers())

it('runs the compaction entry point in a read-only ephemeral thread and saves its live result', async () => {
  vi.mocked(appServer.startTurn).mockImplementation(async () => {
    onEvent({ method: 'item/completed', params: { threadId: 'temporary',
      item: { type: 'agentMessage', phase: 'final_answer', text: '## Status\ncompacted' } } })
    onEvent({ method: 'turn/completed', params: { threadId: 'temporary', turn: { id: 'turn', status: 'completed' } } })
    return { turn: { id: 'turn', status: 'inProgress' } } as never
  })
  await expect(compactProject(deps(), 'project', '/workspace')).resolves.toMatchObject({ newSeq: 5 })
  expect(appServer.startThread).toHaveBeenCalledWith(expect.objectContaining({
    cwd: '/workspace', ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never',
    model: DEFAULT_PROJECT_DOC_CONFIG.archiveModel,
  }))
  expect(appServer.startTurn).toHaveBeenCalledWith(expect.objectContaining({
    threadId: 'temporary', effort: DEFAULT_PROJECT_DOC_CONFIG.archiveEffort,
  }))
  expect(runtime.projectDocCompleteCompaction).toHaveBeenCalledWith('project', 'job', '## Status\ncompacted')
  expect(appServer.unsubscribeThread).toHaveBeenCalledWith('temporary')
  expect(unlisten).toHaveBeenCalledOnce()
})

it('interrupts a timed-out compaction and releases its thread and job without saving', async () => {
  vi.useFakeTimers()
  const pending = expect(compactProject(deps(), 'project', '/workspace')).rejects.toThrow('超时')
  await vi.advanceTimersByTimeAsync(300_001)
  await pending
  expect(appServer.interruptTurn).toHaveBeenCalledWith('temporary', 'turn')
  expect(appServer.unsubscribeThread).toHaveBeenCalledWith('temporary')
  expect(unlisten).toHaveBeenCalledOnce()
  expect(runtime.projectDocCompleteCompaction).not.toHaveBeenCalled()
  expect(runtime.projectDocCancelCompaction).toHaveBeenCalledWith('project', 'job')
})

import { beforeEach, expect, it, vi } from 'vitest'
import { appServer } from '../../core/runtime/appServerClient'
import { runtime } from '../../core/runtime/bridge'
import { runStructuredCodexTask } from '../../core/runtime/structuredCodexTask'
import { interpretSessionRequest, parseSessionRequest, queryAssistantSessions, type SessionRequest } from './sessionAssistant'

vi.mock('../../core/runtime/appServerClient', () => ({ appServer: { listThreads: vi.fn() } }))
vi.mock('../../core/runtime/bridge', () => ({ runtime: { assistantWorkspaceDirectory: vi.fn(), listClaudeSessions: vi.fn(), superbotRequest: vi.fn() } }))
vi.mock('../../core/runtime/structuredCodexTask', () => ({ runStructuredCodexTask: vi.fn() }))

const request: SessionRequest = { action: 'list', provider: 'all', scope: 'active', query: '', recentDays: null, previousRows: [] }
const thread = (id: string, name: string, cwd: string, updatedAt: number) => ({
  id, name, cwd, updatedAt, createdAt: updatedAt, recencyAt: null, ephemeral: false,
  preview: '正文不会进入模型上下文', status: { type: 'idle' as const }, canAcceptDirectInput: true,
})

beforeEach(() => vi.resetAllMocks())

it('queries every Codex page independently of the current sidebar and reports unavailable sources', async () => {
  vi.mocked(appServer.listThreads).mockResolvedValueOnce({
    data: [thread('1', '日常', '/work/other', 10)], nextCursor: 'more',
  }).mockResolvedValueOnce({
    data: [thread('2', '继续开发', '/work/router', 20)], nextCursor: null,
  })
  vi.mocked(runtime.listClaudeSessions).mockResolvedValue([
    { id: 'claude:1', title: 'Router 调研', cwd: '/work', createdAt: 10_000, updatedAt: 30_000, archived: false, providerSessionId: 'existing' },
  ])
  vi.mocked(runtime.superbotRequest).mockRejectedValue(new Error('unavailable'))
  const result = await queryAssistantSessions({ ...request, query: 'router' }, [], [])
  expect(result.rows.map(row => row.id)).toEqual(['claude:1', '2'])
  expect(result.unavailable).toEqual(['superbot'])
  expect(appServer.listThreads).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: 'more', archived: false }))
})

it('resolves referenced rows against the current active catalog and filters pinned sessions locally', async () => {
  vi.mocked(appServer.listThreads).mockResolvedValue({ data: [thread('1', '一', '/', 10), thread('2', '二', '/', 20)], nextCursor: null })
  const { rows } = await queryAssistantSessions({ ...request, provider: 'codex' }, [], [])
  const result = await queryAssistantSessions({ ...request, action: 'archive', provider: 'codex', scope: 'pinned', previousRows: [2] }, rows, ['1', '2'])
  expect(result.rows.map(row => row.id)).toEqual(['1'])
  expect(() => parseSessionRequest(JSON.stringify({ ...request, previousRows: [3] }), rows.length)).toThrow()
  expect(() => parseSessionRequest(JSON.stringify({ ...request, action: 'delete' }), 0)).toThrow()
})

it('uses the dedicated workspace and sends only the request and numbered titles to Codex', async () => {
  vi.mocked(runtime.assistantWorkspaceDirectory).mockResolvedValue('/assistant')
  vi.mocked(runStructuredCodexTask).mockResolvedValue(JSON.stringify({ ...request, action: 'pin', previousRows: [1] }))
  const result = await interpretSessionRequest('置顶第一个', [{ id: 'private-id', title: '第一条', cwd: '/private', provider: 'codex', updatedAt: 0, archived: false }])
  expect(result.action).toBe('pin')
  const [cwd, [input], , , , trigger] = vi.mocked(runStructuredCodexTask).mock.calls[0]
  expect(cwd).toBe('/assistant')
  expect(input).toMatchObject({ type: 'text', text: JSON.stringify({ request: '置顶第一个', previousResults: [{ row: 1, title: '第一条' }] }) })
  expect(trigger).toBe('harness-assistant')
})

import { beforeEach, expect, it, vi } from 'vitest'
import { appServer } from '../../core/runtime/appServerClient'
import { runtime } from '../../core/runtime/bridge'
import { textInput } from '../../core/domain/codex'
import { assistantInput, parseSessionRequest, queryAssistantSessions, type SessionRequest } from './sessionAssistant'

vi.mock('../../core/runtime/appServerClient', () => ({ appServer: { listThreads: vi.fn() } }))
vi.mock('../../core/runtime/bridge', () => ({ runtime: { assistantWorkspaceDirectory: vi.fn(), listClaudeSessions: vi.fn(), superbotRequest: vi.fn() } }))

const request: SessionRequest = { action: 'list', provider: 'all', scope: 'active', query: '', recentDays: null, referenceIds: [] }
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
  const result = await queryAssistantSessions({ ...request, query: 'router' }, [])
  expect(result.rows.map(row => row.id)).toEqual(['claude:1', '2'])
  expect(result.unavailable).toEqual(['superbot'])
  expect(appServer.listThreads).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: 'more', archived: false }))
})

it('resolves referenced rows against the current active catalog and filters pinned sessions locally', async () => {
  vi.mocked(appServer.listThreads).mockResolvedValue({ data: [thread('1', '一', '/', 10), thread('2', '二', '/', 20)], nextCursor: null })
  const result = await queryAssistantSessions({ ...request, action: 'archive', provider: 'codex', scope: 'pinned', referenceIds: ['1'] }, ['1', '2'])
  expect(result.rows.map(row => row.id)).toEqual(['1'])
  expect(() => parseSessionRequest(JSON.stringify({ ...request, referenceIds: [3] }))).toThrow()
  expect(() => parseSessionRequest(JSON.stringify({ ...request, action: 'delete' }))).toThrow()
})

it('preserves attachment inputs and sends stable references without workspace paths', () => {
  const image = { type: 'localImage' as const, path: '/attachments/example.png' }
  const result = assistantInput([textInput('置顶第一个'), image], [{ id: 'target', title: '第一条', cwd: '/private', provider: 'codex', updatedAt: 0, archived: false }])
  expect(result).toEqual([
    textInput('置顶第一个'), image,
    textInput('界面会话引用：[{"row":1,"id":"target","title":"第一条"}]'),
  ])
})

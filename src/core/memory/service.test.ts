import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { AppServerEvent, Turn } from '../domain/codex'
import { appServer } from '../runtime/appServerClient'
import { runtime } from '../runtime/bridge'
import { createMemoryService, extractMemoryJson, loadMemoryTurns } from './service'
vi.mock('../runtime/appServerClient', () => ({ appServer: {
  listTurns: vi.fn(), readConfig: vi.fn(), startThread: vi.fn(), startTurn: vi.fn(), interruptTurn: vi.fn(), unsubscribeThread: vi.fn(),
} }))
vi.mock('../runtime/bridge', () => ({ runtime: { memoryCatalog: vi.fn(), memorySave: vi.fn(), listenEvents: vi.fn(), getAppState: vi.fn() } }))
let handle: (event: AppServerEvent) => void
const unlisten = vi.fn()
const turn = (id = 't1') => ({ id, status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: '请记住已经确认的经验', text_elements: [] }] }] }) as unknown as Turn
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(runtime.getAppState).mockResolvedValue(null)
  vi.mocked(appServer.listTurns).mockResolvedValue({ data: [turn()], nextCursor: null })
  vi.mocked(appServer.readConfig).mockResolvedValue({ config: { model: 'test-model', model_context_window: 200_000 } } as never)
  vi.mocked(runtime.memoryCatalog).mockResolvedValue({ currentWorkspace: 'repo', workspaces: ['repo'], domains: [] })
  vi.mocked(appServer.startThread).mockResolvedValue({ thread: { id: 'child' } } as never)
  vi.mocked(runtime.listenEvents).mockImplementation(async (handler) => { handle = handler; return unlisten })
  vi.mocked(appServer.unsubscribeThread).mockResolvedValue(undefined)
  vi.mocked(appServer.interruptTurn).mockResolvedValue(undefined)
  result('{"memories":[]}')
})
afterEach(() => vi.useRealTimers())
it.each([
  [null, {}, 'gpt-6-luna'],
  [null, { model: 'workspace-model' }, 'gpt-6-luna'],
  [{ model: '' }, { model: 'workspace-model' }, 'workspace-model'],
  [{ model: '' }, {}, 'gpt-6-luna'],
  [{ model: 'saved-model' }, { model: 'workspace-model' }, 'saved-model'],
])('resolves memory model from saved settings, workspace config, then the default', async (settings, config, expected) => {
  vi.mocked(runtime.getAppState).mockResolvedValue(settings ? JSON.stringify(settings) : null)
  vi.mocked(appServer.readConfig).mockResolvedValue({ config } as never)
  await createMemoryService({ publish: vi.fn() }).saveConversation({ threadId: 'source', cwd: '/repo' })
  expect(appServer.startThread).toHaveBeenCalledWith(expect.objectContaining({ model: expected }))
})

function result(text: string) {
  vi.mocked(appServer.startTurn).mockImplementation(async () => {
    handle({ method: 'item/completed', params: { threadId: 'child', item: { type: 'agentMessage', phase: 'final_answer', text } } })
    handle({ method: 'turn/completed', params: { threadId: 'child', turn: { id: 'generated', status: 'completed', items: [] } } })
    return { turn: { id: 'generated', status: 'inProgress', items: [] } as unknown as Turn }
  })
}
it('reads all pages in chronological order and detects broken pagination', async () => {
  vi.mocked(appServer.listTurns).mockResolvedValueOnce({ data: [turn('old')], nextCursor: 'next' }).mockResolvedValueOnce({ data: [turn('new')], nextCursor: null })
  expect((await loadMemoryTurns('source')).map((value) => value.id)).toEqual(['old', 'new'])
  expect(appServer.listTurns).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'next', itemsView: 'full', sortDirection: 'asc' }))
  vi.mocked(appServer.listTurns).mockResolvedValue({ data: [], nextCursor: 'same' })
  await expect(loadMemoryTurns('source')).rejects.toThrow('分页')
})
it('accepts no-op without calling storage and cleans up the ephemeral thread', async () => {
  const publish = vi.fn().mockReturnValue('notice')
  const service = createMemoryService({ publish })
  expect(await service.saveConversation({ threadId: 'source', cwd: '/repo' })).toEqual([])
  expect(runtime.memorySave).not.toHaveBeenCalled()
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ title: '本次没有值得保存的记忆', state: 'done' }))
  expect(appServer.startTurn).toHaveBeenCalledWith(expect.objectContaining({ outputSchema: expect.any(Object), turnTrigger: 'memory-save' }))
  expect(appServer.startThread).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true, sandbox: 'read-only', config: expect.objectContaining({ 'features.memories': false, project_doc_max_bytes: 0 }) }))
  expect(appServer.unsubscribeThread).toHaveBeenCalledWith('child')
  expect(unlisten).toHaveBeenCalled()
  expect(service.isRunning('source')).toBe(false)
})
it('passes structured candidates to Harness, reports success only after persistence', async () => {
  const candidate = { title: '经验', kind: 'fact', scope: 'workspace/repo', content: '内容', applicability: '条件', evidence: '证据', sourceTurnIds: ['t1'] }
  result(JSON.stringify({ memories: [candidate] }))
  vi.mocked(runtime.memorySave).mockResolvedValue([{ id: 'mem-1', title: '经验', scope: 'workspace/repo', path: '/memory/MEMORY.md' }])
  const publish = vi.fn().mockReturnValue('notice')
  await createMemoryService({ publish }).saveConversation({ threadId: 'source', cwd: '/repo' })
  expect(runtime.memorySave).toHaveBeenCalledWith({ threadId: 'source', cwd: '/repo', sourceWorkspace: 'repo', sourceTurnIds: ['t1'], memories: [candidate] })
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ title: '已保存 1 条记忆' }))
  vi.mocked(runtime.memorySave).mockRejectedValueOnce(new Error('磁盘已满'))
  await expect(createMemoryService({ publish }).saveConversation({ threadId: 'source', cwd: '/repo' })).rejects.toThrow('磁盘已满')
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ title: '记忆保存未完成', level: 'error' }))
})
it('blocks duplicate clicks across views, rejects malformed output without saving', async () => {
  let finish!: () => void
  vi.mocked(appServer.listTurns).mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ data: [turn()], nextCursor: null }) }))
  const service = createMemoryService({ publish: vi.fn() })
  const first = service.saveConversation({ threadId: 'source', cwd: '/repo' })
  await expect(service.saveConversation({ threadId: 'source', cwd: '/repo' })).rejects.toThrow('正在保存')
  result('not json')
  finish()
  await expect(first).rejects.toThrow()
  expect(runtime.memorySave).not.toHaveBeenCalled()
  expect(service.isRunning('source')).toBe(false)
})
it('interrupts timed-out extraction and releases event listeners', async () => {
  vi.useFakeTimers()
  vi.mocked(appServer.startTurn).mockResolvedValue({ turn: { id: 'running', status: 'inProgress', items: [] } as unknown as Turn })
  const task = extractMemoryJson('/repo', 'prompt', 'test-model', 150000, 95, {})
  const rejected = expect(task).rejects.toThrow('超时')
  await vi.advanceTimersByTimeAsync(300001)
  await rejected
  expect(appServer.interruptTurn).toHaveBeenCalledWith('child', 'running')
  expect(unlisten).toHaveBeenCalled()
})

it('uses saved settings for the model, effort, prompt, turn selection and input budget', async () => {
  vi.mocked(runtime.getAppState).mockResolvedValue(JSON.stringify({ model: 'custom-model', effort: 'high', prompt: '只保留用户纠正', maxTurns: 1, budgetPercent: 10, contextWindowTokens: 20000 }))
  const recent = turn('recent')
  recent.items = [{ type: 'agentMessage', text: 'HEAD ' + 'x'.repeat(20000) + ' TAIL' }]
  vi.mocked(appServer.listTurns).mockResolvedValue({ data: [recent], nextCursor: 'older' })
  await createMemoryService({ publish: vi.fn() }).saveConversation({ threadId: 'source', cwd: '/repo' })
  expect(appServer.startThread).toHaveBeenCalledWith(expect.objectContaining({ model: 'custom-model', developerInstructions: '只保留用户纠正', config: expect.objectContaining({ model_context_window: 20000 }) }))
  const request = vi.mocked(appServer.startTurn).mock.calls[0][0]
  expect(request.effort).toBe('high')
  const text = (request.input as Array<{ text: string }>)[0].text
  expect(text).not.toContain('excluded')
  expect(text).toContain('HEAD')
  expect(text).toContain('TAIL')
  expect(text).toContain('中间上下文')
  expect(new TextEncoder().encode(text).length).toBeLessThan(20000 * .95 * .1 * 4)
})

it('loads only the requested recent turns and restores chronological order', async () => {
  vi.mocked(appServer.listTurns).mockResolvedValueOnce({ data: [turn('newest'), turn('previous')], nextCursor: 'older' })
  expect((await loadMemoryTurns('source', 2)).map((value) => value.id)).toEqual(['previous', 'newest'])
  expect(appServer.listTurns).toHaveBeenCalledTimes(1)
  expect(appServer.listTurns).toHaveBeenCalledWith(expect.objectContaining({ limit: 2, sortDirection: 'desc' }))
})

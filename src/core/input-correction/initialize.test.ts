import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appServer } from '../runtime/appServerClient'
import { runtime } from '../runtime/bridge'
import { loadMemoryTurns } from '../memory/service'
import { extractRules, initializeDictionary } from './initialize'
import type { AppServerEvent, Turn } from '../domain/codex'
vi.mock('../runtime/appServerClient', () => ({ appServer: { startThread: vi.fn(), startTurn: vi.fn(), interruptTurn: vi.fn(), unsubscribeThread: vi.fn(), readConfig: vi.fn(), listThreads: vi.fn() } }))
vi.mock('../runtime/bridge', () => ({ runtime: { listenEvents: vi.fn() } }))
vi.mock('../memory/service', () => ({ loadMemoryTurns: vi.fn() }))
let handler: (event: AppServerEvent) => void
const unlisten = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(appServer.startThread).mockResolvedValue({ thread: { id: 'child' } } as never)
  vi.mocked(appServer.unsubscribeThread).mockResolvedValue(undefined)
  vi.mocked(appServer.interruptTurn).mockResolvedValue(undefined)
  vi.mocked(runtime.listenEvents).mockImplementation(async (listener) => { handler = listener; return unlisten })
  vi.mocked(appServer.startTurn).mockImplementation(async () => {
    handler({ method: 'turn/completed', params: { threadId: 'child', turn: { status: 'completed', items: [{ type: 'agentMessage', text: '{"rules":[{"from":"绘画","to":"会话"}]}' }] } } })
    return { turn: { id: 'turn', status: 'inProgress' } } as never
  })
})
afterEach(() => vi.useRealTimers())
it('uses an isolated low-effort Luna request and always cleans up listeners', async () => {
  expect(JSON.parse(await extractRules('/repo', '绘画', { mcp_servers: { private: {} } }))).toEqual({ rules: [{ from: '绘画', to: '会话' }] })
  expect(appServer.startThread).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-6-luna', ephemeral: true, sandbox: 'read-only', config: expect.objectContaining({ 'mcp_servers.private.enabled': false }) }))
  expect(appServer.startTurn).toHaveBeenCalledWith(expect.objectContaining({ turnTrigger: 'input-correction-initialize', effort: 'low', sandboxPolicy: { type: 'readOnly', networkAccess: false } }))
  expect(unlisten).toHaveBeenCalledOnce()
  expect(appServer.unsubscribeThread).toHaveBeenCalledWith('child')
})
it('interrupts a timed-out model turn and releases resources', async () => {
  vi.useFakeTimers()
  vi.mocked(appServer.startTurn).mockResolvedValue({ turn: { id: 'slow', status: 'inProgress' } } as never)
  const result = extractRules('/repo', '绘画', {})
  const rejected = expect(result).rejects.toThrow('超时')
  await vi.advanceTimersByTimeAsync(300001)
  await rejected
  expect(appServer.interruptTurn).toHaveBeenCalledWith('child', 'slow')
  expect(unlisten).toHaveBeenCalledOnce()
})
it('paginates active and archived history, removes injected context, ignores assistant text and reuses initialization', async () => {
  vi.mocked(appServer.readConfig).mockResolvedValue({ config: {} } as never)
  vi.mocked(appServer.listThreads).mockResolvedValueOnce({ data: [{ id: 'a' }], nextCursor: 'next' } as never).mockResolvedValueOnce({ data: [{ id: 'b' }], nextCursor: null } as never).mockResolvedValueOnce({ data: [{ id: 'a' }, { id: 'c' }], nextCursor: null } as never)
  vi.mocked(loadMemoryTurns).mockResolvedValue([{ id: 't', items: [
    { type: 'userMessage', content: [{ type: 'text', text: '# AGENTS.md instructions X </INSTRUCTIONS>\n<skill>secret skill</skill>\n请切换绘画' }] },
    { type: 'agentMessage', text: 'ASSISTANT_TEXT' },
  ] }] as unknown as Turn[])
  const progress = vi.fn()
  expect(await initializeDictionary('/repo', progress)).toEqual([{ from: '绘画', to: '会话' }])
  expect(loadMemoryTurns).toHaveBeenCalledTimes(3)
  expect(appServer.listThreads).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: 'next', archived: false }))
  expect(appServer.listThreads).toHaveBeenLastCalledWith(expect.objectContaining({ archived: true }))
  const prompt = JSON.stringify(vi.mocked(appServer.startTurn).mock.calls[0][0].input)
  expect(prompt).toContain('请切换绘画')
  expect(prompt).not.toContain('secret skill')
  expect(prompt).not.toContain('ASSISTANT_TEXT')
  await initializeDictionary('/repo', progress)
  expect(appServer.startTurn).toHaveBeenCalledOnce()
})

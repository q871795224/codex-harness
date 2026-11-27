import { beforeEach, expect, it, vi } from 'vitest'
import { messageLocator, parseMessageLocator } from '../domain/messageLocator'
import { createManagementHandler, type ManagementContext } from './service'
import { appServer } from '../runtime/appServerClient'
import { runtime } from '../runtime/bridge'

vi.mock('../runtime/appServerClient', () => ({ appServer: { readThread: vi.fn(), listItems: vi.fn() } }))
vi.mock('../runtime/bridge', () => ({ runtime: { listClaudeSessions: vi.fn(), readClaudeHistory: vi.fn() } }))
const reference = 'harness-message://codex/origin/turn/message'
const context = { harness: { phase: 'ready', selectedThreadId: 'unrelated' }, plugins: { loading: false } } as ManagementContext
const call = (params: Record<string, unknown>) => createManagementHandler(() => context)({ requestId: 'read', method: 'messages.get', params })

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(appServer.readThread).mockResolvedValue({ thread: { id: 'origin', name: '诊断会话', cwd: '/repo' } } as never)
})

it('locates an unloaded message through every page without selecting or resuming the session', async () => {
  vi.mocked(appServer.listItems)
    .mockResolvedValueOnce({ data: [{ turnId: 'turn', item: { id: 'other', type: 'agentMessage', text: '别的消息' } }], nextCursor: 'next' })
    .mockResolvedValueOnce({ data: [{ turnId: 'turn', item: { id: 'message', type: 'userMessage', content: [{ type: 'text', text: '精确消息', text_elements: [] }] } }], nextCursor: null })
  expect(await call({ reference })).toMatchObject({ threadId: 'origin', turnId: 'turn', itemId: 'message',
    session: { id: 'origin', name: '诊断会话', cwd: '/repo' }, item: { type: 'userMessage', content: [{ text: '精确消息' }] } })
  expect(appServer.readThread).toHaveBeenCalledWith({ threadId: 'origin', includeTurns: false })
  expect(appServer.listItems).toHaveBeenLastCalledWith({ threadId: 'origin', turnId: 'turn', cursor: 'next', limit: 1, sortDirection: 'asc' })
  expect(context.harness.selectedThreadId).toBe('unrelated')
})

it('rejects missing items and cursor loops instead of returning a nearby message', async () => {
  vi.mocked(appServer.listItems).mockResolvedValue({ data: [], nextCursor: null })
  await expect(call({ reference })).rejects.toThrow('消息不存在')
  vi.mocked(appServer.listItems).mockResolvedValue({ data: [], nextCursor: 'stuck' })
  await expect(call({ reference })).rejects.toThrow('分页未前进')
})

it('requires the exact turn and rejects malformed references before reading history', async () => {
  vi.mocked(appServer.listItems).mockResolvedValue({ data: [{ turnId: 'wrong', item: { id: 'message', type: 'userMessage' } }], nextCursor: null })
  await expect(call({ reference })).rejects.toThrow('消息不存在')
  vi.clearAllMocks()
  for (const reference of ['message', 'https://codex/origin/turn/message', 'harness-message://codex/origin/turn/', 'harness-message://codex/origin/turn/message?extra=1']) {
    await expect(call({ reference })).rejects.toThrow()
  }
  await expect(call({ reference, command: 'turn/start' })).rejects.toThrow()
  expect(appServer.readThread).not.toHaveBeenCalled()
})

it('roundtrips provider item IDs and omits references without stable identities', () => {
  const entry = { turnId: 'turn:1', item: { id: 'msg/中文%?#', type: 'agentMessage' } }
  expect(parseMessageLocator(messageLocator('origin', entry)!)).toEqual({ threadId: 'origin', turnId: 'turn:1', itemId: 'msg/中文%?#' })
  expect(messageLocator('origin', { ...entry, item: { type: 'userMessage' } })).toBeUndefined()
  expect(messageLocator(null, entry)).toBeUndefined()
  expect(messageLocator('claude:session', entry)).toBeUndefined()
})

it('uses Claude native UUIDs rather than render IDs, including after a reload', async () => {
  const entry = { turnId: 'local-turn', item: { id: 'local-assistant', type: 'agentMessage', providerTurnId: 'native-user', providerMessageId: 'native-answer' } }
  const reference = messageLocator('claude:origin', entry)!
  expect(reference).toBe('harness-message://claude/claude%3Aorigin/native-user/native-answer')
  expect(messageLocator('claude:origin', { ...entry, turnId: 'reloaded-turn', item: { ...entry.item, id: 'reloaded-item' } })).toBe(reference)
  vi.mocked(runtime.listClaudeSessions).mockImplementation(async archived => archived ? [{ id: 'claude:origin', providerSessionId: 'sdk-session', title: '归档会话', cwd: '/repo' }] as never : [])
  vi.mocked(runtime.readClaudeHistory).mockResolvedValue({ messages: [
    { type: 'user', uuid: 'native-user', sessionId: 'sdk-session', message: { content: '问题' }, parentToolUseId: null, timestamp: null },
    { type: 'assistant', uuid: 'native-answer', sessionId: 'sdk-session', message: { content: [{ type: 'text', text: '答案' }] }, parentToolUseId: null, timestamp: null },
  ] })
  expect(await call({ reference })).toMatchObject({ provider: 'claude', turnId: 'native-user', itemId: 'native-answer', session: { name: '归档会话' }, item: { text: '答案' }, nativeMessage: { uuid: 'native-answer' } })
  expect(runtime.readClaudeHistory).toHaveBeenCalledWith('claude:origin', '/repo', 'sdk-session')
  await expect(call({ reference: reference.replace('native-user', 'wrong-turn') })).rejects.toThrow('消息不存在')
  await expect(call({ reference: reference.replace('native-answer', 'missing') })).rejects.toThrow('消息不存在')
  expect(appServer.readThread).not.toHaveBeenCalled()
})

it('rejects provider mismatches before reading either provider', async () => {
  for (const reference of ['harness-message://claude/origin/turn/item', 'harness-message://codex/claude%3Aorigin/turn/item', 'harness-message://superbot/origin/turn/item']) {
    await expect(call({ reference })).rejects.toThrow()
  }
  expect(runtime.listClaudeSessions).not.toHaveBeenCalled()
  expect(appServer.readThread).not.toHaveBeenCalled()
})

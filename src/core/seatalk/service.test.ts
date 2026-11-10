import { beforeEach, expect, it, vi } from 'vitest'
import { emptyThreadDetail, textInput, type ApprovalRequest, type Thread } from '../domain/codex'
import { requestToken, SeaTalkSync, type RemoteCall, type SeaTalkSnapshot } from './service'

const now = Date.now()
const thread = (id: string): Thread => ({ id, cwd: `/repo/${id}`, name: id, preview: 'work', ephemeral: false,
  status: { type: 'idle' }, canAcceptDirectInput: true, createdAt: 1, updatedAt: 1, recencyAt: 1 })
function fixture() {
  const snapshot: SeaTalkSnapshot = { threads: [thread('one'), thread('two')], details: {}, approvals: {}, activeTurnIds: {}, archived: false }
  const actions = { send: vi.fn(async () => {}), stop: vi.fn(async () => {}), answer: vi.fn(async () => {}), warn: vi.fn() }
  const bindings = snapshot.threads.map(t => ({ threadId: t.id, rootId: `root-${t.id}`, createdAt: now - 10000 }))
  const messages: { id: string; rootId: string; text: string; cursor: number }[] = []
  const claimed = new Set<string>(); const delivered = new Set<string>()
  const deliveries: Record<string, unknown>[] = []
  const call = vi.fn(async (action: string, input: Record<string, unknown> = {}) => {
    if (action === 'status') return { reachable: true, connected: true, interactiveCards: true, accountId: 'account', ownerId: 'owner' }
    if (action === 'bindings') return { bindings }
    if (action === 'messages') {
      const page = messages.filter(m => m.cursor > Number(input.after ?? 0)).slice(0, 100)
      return { messages: page, cursor: page.at(-1)?.cursor ?? input.after, hasMore: page.length === 100 }
    }
    if (action === 'claim') {
      const message = messages.find(m => m.id === input.messageId)!
      const fresh = !claimed.has(message.id); claimed.add(message.id)
      return { claimed: fresh, threadId: bindings.find(b => b.rootId === message.rootId)?.threadId }
    }
    if (action === 'send') {
      const key = `${input.threadId}:${input.eventId}`
      if (!delivered.has(key)) { deliveries.push(input); delivered.add(key) }
      return bindings.find(b => b.threadId === input.threadId) ?? { rootId: `root-${input.threadId}`, createdAt: now - 10000 }
    }
    return { ok: true }
  })
  return { snapshot, actions, bindings, messages, deliveries, call, service: new SeaTalkSync(call as RemoteCall, () => snapshot, actions) }
}
beforeEach(() => vi.clearAllMocks())

it('sends only user messages and final results to their own branch once, without replaying older history', async () => {
  const f = fixture(); const detail = emptyThreadDetail(thread('two'))
  detail.items = [
    { turnId: 'old', item: { id: 'old-item', type: 'agentMessage', text: 'old history' } },
    { turnId: 'turn', item: { id: 'progress', type: 'agentMessage', phase: 'commentary', text: 'working' }, timing: { completedAt: now } },
    { turnId: 'turn', item: { id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'done' }, timing: { completedAt: now } },
  ]
  f.snapshot.details.two = detail
  await f.service.tick(); await f.service.tick()
  expect(f.deliveries.map(d => [d.threadId, d.text])).toEqual([['two', 'done']])
  const restart = new SeaTalkSync(f.call as RemoteCall, () => f.snapshot, f.actions)
  await restart.tick()
  expect(f.deliveries).toHaveLength(1)
})

it('directs an inbound reply to its mapped session and never submits the same message twice across instances', async () => {
  const f = fixture()
  f.messages.push({ id: 'mobile', cursor: 1, rootId: 'root-two', text: 'continue work' })
  await Promise.all([f.service.tick(), f.service.tick()])
  await new SeaTalkSync(f.call as RemoteCall, () => f.snapshot, f.actions).tick()
  expect(f.actions.send).toHaveBeenCalledExactlyOnceWith('two', 'continue work')
  expect(f.deliveries[0]).toMatchObject({ threadId: 'two', text: '已接收；执行中的追加消息会排队。', silent: true })
})

it('catches up beyond one hundred messages and does not execute unknown slash commands as prompts', async () => {
  const f = fixture()
  for (let i = 1; i <= 125; i++) f.messages.push({ id: `m${i}`, cursor: i, rootId: 'root-one', text: '/状态' })
  f.messages.push({ id: 'invalid', cursor: 126, rootId: 'root-two', text: '/批准 wrong' })
  await f.service.tick()
  expect(f.deliveries).toHaveLength(126)
  expect(f.actions.send).not.toHaveBeenCalled()
  expect(f.deliveries.at(-1)?.text).toMatch(/^操作结果未确认：/)
})

it('requires the current request token and answers all questions through the existing approval channel', async () => {
  const f = fixture()
  const request: ApprovalRequest = { id: 'q', threadId: 'two', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'choice', question: 'Choose a mode' }] } }
  f.snapshot.approvals.two = [request]
  const token = await requestToken(request)
  f.messages.push({ id: 'answer', cursor: 1, rootId: 'root-two', text: `/回答 ${token} fast` })
  await f.service.tick()
  expect(f.actions.answer).toHaveBeenCalledExactlyOnceWith(request, { answers: { choice: { answers: ['fast'] } } })
  f.messages.push({ id: 'duplicate', cursor: 2, rootId: 'root-two', text: `/回答 ${token} slow` })
  await f.service.tick()
  expect(f.actions.answer).toHaveBeenCalledTimes(1)
  expect(f.deliveries.at(-1)?.text).toContain('已处理')
})

it('rejects stale approval tokens and never allows secret answers through SeaTalk', async () => {
  const f = fixture()
  const old: ApprovalRequest = { id: 'q', threadId: 'two', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'secret', question: 'Private question', isSecret: true }] } }
  const stale = await requestToken(old)
  const updated = { ...old, params: { questions: [{ id: 'secret', question: 'Changed private question', isSecret: true }] } }
  f.snapshot.approvals.two = [updated]
  f.messages.push({ id: 'stale', cursor: 1, rootId: 'root-two', text: `/回答 ${stale} hidden answer` },
    { id: 'secret', cursor: 2, rootId: 'root-two', text: `/回答 ${await requestToken(updated)} hidden answer` })
  await f.service.tick()
  expect(f.actions.answer).not.toHaveBeenCalled()
  expect(f.deliveries.some(d => String(d.text).includes('Changed private question'))).toBe(false)
  expect(f.deliveries.some(d => String(d.text).includes('hidden answer'))).toBe(false)
})

it('records execution failures and sends a failure receipt without automatically retrying the prompt', async () => {
  const f = fixture(); f.actions.send.mockRejectedValueOnce(new Error('owned elsewhere'))
  f.messages.push({ id: 'mobile', cursor: 1, rootId: 'root-two', text: 'continue' })
  await f.service.tick(); await f.service.tick()
  expect(f.actions.send).toHaveBeenCalledTimes(1)
  expect(f.call).toHaveBeenCalledWith('finish', { messageId: 'mobile', status: 'failed' })
  expect(f.deliveries.at(-1)?.text).toContain('owned elsewhere')
})

it('a foreign active turn is left for its owning instance, and cancellation targets the mapped thread', async () => {
  const f = fixture(); f.snapshot.details.two = { ...emptyThreadDetail(thread('two')), foreignActive: true }
  f.messages.push({ id: 'mobile', cursor: 1, rootId: 'root-two', text: '/停止' })
  await f.service.tick()
  expect(f.actions.stop).not.toHaveBeenCalled()
  expect(f.call.mock.calls.some(call => call[0] === 'claim')).toBe(false)
  f.snapshot.details.two.foreignActive = false
  await f.service.tick()
  expect(f.actions.stop).toHaveBeenCalledExactlyOnceWith('two')
})

it('creates roots automatically for ordinary sessions and skips ephemeral helper sessions', async () => {
  const f = fixture(); f.bindings.splice(0)
  f.snapshot.threads[1].ephemeral = true
  await f.service.tick()
  expect(f.deliveries).toEqual([{ threadId: 'one', title: 'one', cwd: '/repo/one', silent: true }])
})

it('splits a long Unicode result into native-size messages without losing content', async () => {
  const f = fixture(); const detail = emptyThreadDetail(thread('one')); const content = '你好👋'.repeat(5000)
  detail.items = [{ turnId: 'turn', item: { id: 'long', type: 'agentMessage', phase: 'final_answer', text: content }, timing: { completedAt: now } }]
  f.snapshot.details.one = detail
  await f.service.tick()
  expect(f.deliveries.map(d => d.text).join('')).toBe(content)
  expect(f.deliveries.every(d => new TextEncoder().encode(String(d.text)).byteLength <= 16000)).toBe(true)
})

it('includes the first input of an already active turn even when it precedes root creation', async () => {
  const f = fixture(); const detail = emptyThreadDetail(thread('one'))
  f.snapshot.activeTurnIds.one = 'turn'
  f.bindings[0].createdAt = now + 1000
  detail.items = [{ turnId: 'turn', item: { id: 'input', type: 'userMessage', content: [textInput('first input')] }, timing: { startedAt: now } }]
  f.snapshot.details.one = detail
  await f.service.tick()
  expect(f.deliveries.map(d => d.text)).toEqual(['你：\nfirst input'])
})

it('checks current native ownership before claiming, rather than trusting a stale idle snapshot', async () => {
  const f = fixture(); const prepare = vi.fn(async () => false)
  const service = new SeaTalkSync(f.call as RemoteCall, () => f.snapshot, { ...f.actions, prepare })
  f.messages.push({ id: 'mobile', cursor: 1, rootId: 'root-two', text: 'continue' })
  await service.tick()
  expect(prepare).toHaveBeenCalledExactlyOnceWith('two')
  expect(f.call.mock.calls.some(call => call[0] === 'claim')).toBe(false)
  expect(f.actions.send).not.toHaveBeenCalled()
  prepare.mockResolvedValue(true)
  await service.tick()
  expect(f.actions.send).toHaveBeenCalledExactlyOnceWith('two', 'continue')
})


it('omits tool events, queued drafts and routine turn status while forwarding desktop input', async () => {
  const f = fixture(); const detail = emptyThreadDetail(thread('one'))
  detail.items = [
    { turnId: 'turn', item: { id: 'u', type: 'userMessage', content: [textInput('hello')] }, timing: { completedAt: now } },
    ...['commandExecution', 'fileChange', 'mcpToolCall', 'reasoning'].map(type => ({ turnId: 'turn', item: { id: type, type, text: 'private process' }, timing: { completedAt: now } })),
    { turnId: 'turn', item: { id: 'a', type: 'agentMessage', phase: 'final_answer' as const, text: '**done**' }, timing: { completedAt: now } },
  ]
  detail.turns = [{ id: 'turn', status: 'completed', completedAt: now, startedAt: now - 100, durationMs: 100, error: null, items: [] }]
  f.snapshot.details.one = detail
  f.snapshot.activeTurnIds.one = 'turn'
  await f.service.tick()
  expect(f.deliveries.map(d => d.text)).toEqual(['你：\nhello', '**done**'])
  expect(f.deliveries.every(d => d.format === 'markdown')).toBe(true)
})

it('waits for a legacy turn to finish and sends only its last phase-less message', async () => {
  const f = fixture(); const detail = emptyThreadDetail(thread('one'))
  detail.items = ['progress', 'result'].map(id => ({ turnId: 'turn', item: { id, type: 'agentMessage', text: id }, timing: { completedAt: now } }))
  detail.turns = [{ id: 'turn', status: 'inProgress', completedAt: null, startedAt: now, durationMs: null, error: null, items: [] }]
  f.snapshot.details.one = detail
  await f.service.tick()
  expect(f.deliveries).toHaveLength(0)
  detail.turns[0].status = 'completed'
  await f.service.tick()
  expect(f.deliveries.map(d => d.text)).toEqual(['result'])
})

it('sends actionable approval cards and rejects repeated clicks after resolution', async () => {
  const f = fixture()
  const request: ApprovalRequest = { id: 'approval', threadId: 'two', method: 'item/commandExecution/requestApproval', params: { command: 'ls' } }
  f.snapshot.approvals.two = [request]
  await f.service.tick()
  const card = f.deliveries[0].card as { buttons: { text: string; command: string }[] }
  expect(card.buttons.map(b => b.text)).toEqual(['批准本次操作', '拒绝'])
  f.messages.push({ id: 'click', cursor: 1, rootId: 'root-two', text: card.buttons[0].command })
  await f.service.tick()
  expect(f.actions.answer).toHaveBeenCalledExactlyOnceWith(request, 'accept')
  f.messages.push({ id: 'click-again', cursor: 2, rootId: 'root-two', text: card.buttons[1].command })
  await f.service.tick()
  expect(f.actions.answer).toHaveBeenCalledTimes(1)
})

it('collects card selections for all questions before submitting one complete answer', async () => {
  const f = fixture()
  const request: ApprovalRequest = { id: 'q', threadId: 'two', method: 'item/tool/requestUserInput', params: { questions: [
    { id: 'mode', question: 'Mode?', options: [{ label: 'fast', description: 'quick' }] },
    { id: 'color', question: 'Color?', options: [{ label: 'blue' }] },
  ] } }
  f.snapshot.approvals.two = [request]
  await f.service.tick()
  const cards = f.deliveries.map(d => d.card as { buttons: { command: string }[] })
  f.messages.push({ id: 'one', cursor: 1, rootId: 'root-two', text: cards[0].buttons[0].command })
  await f.service.tick()
  expect(f.actions.answer).not.toHaveBeenCalled()
  f.messages.push({ id: 'two', cursor: 2, rootId: 'root-two', text: cards[1].buttons[0].command })
  await f.service.tick()
  expect(f.actions.answer).toHaveBeenCalledExactlyOnceWith(request, { answers: { mode: { answers: ['fast'] }, color: { answers: ['blue'] } } })
})


it('keeps approvals operable with explicit commands when Bridge has not been upgraded', async () => {
  const f = fixture()
  f.snapshot.approvals.two = [{ id: 'a', threadId: 'two', method: 'item/fileChange/requestApproval', params: {} }]
  const call: RemoteCall = async (action, input) => action === 'status'
    ? { reachable: true, connected: true } as never : f.call(action, input) as never
  await new SeaTalkSync(call, () => f.snapshot, f.actions).tick()
  expect(f.deliveries[0].card).toBeUndefined()
  expect(f.deliveries[0].text).toContain('/批准 ')
  expect(f.deliveries[0].text).toContain('/拒绝 ')
  expect(f.actions.warn).toHaveBeenCalledTimes(1)
})

it('requests silent delivery for new roots, every result segment, and pending question cards', async () => {
  const f = fixture(); f.bindings.splice(0)
  const detail = emptyThreadDetail(thread('one'))
  const content = '你好👋'.repeat(5000)
  detail.items = [{ turnId: 'turn', item: { id: 'long', type: 'agentMessage', phase: 'final_answer', text: content }, timing: { completedAt: now } }]
  f.snapshot.details.one = detail
  f.snapshot.approvals.one = [{ id: 'question', threadId: 'one', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'mode', question: 'Choose a mode' }] } }]
  await f.service.tick()
  expect(f.deliveries.filter(d => d.eventId === undefined)).toHaveLength(2)
  expect(f.deliveries.filter(d => String(d.eventId).startsWith('item:')).map(d => d.text).join('')).toBe(content)
  expect(f.deliveries.some(d => d.card)).toBe(true)
  expect(f.deliveries.every(d => d.silent === true)).toBe(true)
})

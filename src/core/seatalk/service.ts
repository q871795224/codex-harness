import { itemText, threadTitle, type ApprovalRequest, type Thread, type ThreadDetail, type QueuedSubmission } from '../domain/codex'
import { parseUserInputQuestions } from '../domain/userInput'
import { asyncUserInputAnswered, asyncUserInputRequest } from '../../features/conversation/asyncUserInput'

export interface SeaTalkSnapshot {
  threads: Thread[]
  details: Record<string, ThreadDetail>
  approvals: Record<string, ApprovalRequest[]>
  activeTurnIds: Record<string, string>
  archived: boolean
  queues?: Record<string, QueuedSubmission[]>
}
export interface SeaTalkActions {
  prepare?(threadId: string): Promise<boolean>
  send(threadId: string, text: string): Promise<void>
  stop(threadId: string): Promise<void>
  answer(request: ApprovalRequest, decision: unknown): Promise<void>
  warn(message: string): void
}
export type RemoteCall = <T>(action: 'status' | 'bindings' | 'messages' | 'send' | 'claim' | 'finish', input?: Record<string, unknown>) => Promise<T>
interface Binding { threadId: string; rootId: string; createdAt: number }
interface Inbound { id: string; rootId: string; text: string; cursor: number }
interface Page { messages: Inbound[]; cursor: number; hasMore: boolean }
interface ChannelStatus { accountId: string; ownerId: string; reachable: boolean; connected: boolean; state: string; interactiveCards?: boolean }
const bytes = new TextEncoder()
export async function digest(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes.encode(text))
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('')
}
export async function requestToken(request: ApprovalRequest): Promise<string> {
  return (await digest(JSON.stringify([request.threadId, request.id, request.method, request.params]))).slice(0, 16)
}
export function pendingRequests(snapshot: SeaTalkSnapshot, threadId: string): ApprovalRequest[] {
  const detail = snapshot.details[threadId]
  const requests = [...(snapshot.approvals[threadId] ?? [])]
  detail?.items.forEach((entry, index) => {
    const request = asyncUserInputRequest(threadId, entry.item, entry.turnId)
    if (request && !asyncUserInputAnswered(request, detail.items.slice(index + 1))) requests.push(request)
  })
  return requests
}

// The service is mounted beside the core runtime, independent of the active tab.
export class SeaTalkSync {
  private running = false
  private disposed = false
  private cursor = 0
  private interactiveCards = false
  private nextThreadIndex = 0
  private sendBudget = 24
  private deadline = Infinity
  private readonly sent = new Set<string>()
  private readonly warned = new Set<string>()
  private readonly selections = new Map<string, Record<string, string>>()
  private readonly answered = new Set<string>()
  private readonly completedTurns = new Map<string, number>()
  noteTurnCompleted(threadId: string, turnId: string) { this.completedTurns.set(`${threadId}:${turnId}`, Date.now()) }
  constructor(private readonly call: RemoteCall, private readonly snapshot: () => SeaTalkSnapshot, private readonly actions: SeaTalkActions) {}
  dispose() { this.disposed = true }
  private warning(key: string, message: string) {
    if (!this.warned.has(key)) { this.warned.add(key); this.actions.warn(message) }
  }
  async tick(): Promise<void> {
    if (this.running || this.disposed) return
    this.running = true
    try {
      const status = await this.call<ChannelStatus>('status')
      if (!status.reachable || !status.connected) {
        this.warning('offline', 'SeaTalk 会话通道未连接，请检查 Bridge 中 harness-sessions 的收消息配置。')
        return
      }
      this.warned.delete('offline')
      this.interactiveCards = status.interactiveCards === true
      this.deadline = Infinity
      this.sendBudget = 1000
      const { bindings } = await this.call<{ bindings: Binding[] }>('bindings')
      const snapshot = this.snapshot()
      const byThread = new Map(bindings.map(binding => [binding.threadId, binding]))
      // Paginate rather than repeatedly reading the most recent 100 messages.
      // Every command is claimed durably in Bridge before it reaches the agent.
      for (let pageNumber = 0; pageNumber < 10 && !this.disposed; pageNumber++) {
        const page = await this.call<Page>('messages', { after: this.cursor })
        let deferredCursor: number | undefined
        for (const message of page.messages) {
          if (this.disposed) return
          const binding = [...byThread.values()].find(binding => binding.rootId === message.rootId)
          if (!binding) continue
          // Refresh ownership without changing desktop selection before claiming.
          // A stale UI snapshot must not claim another instance's mobile input.
          let preparationError: unknown
          let available = !this.snapshot().details[binding.threadId]?.foreignActive
          try { if (this.actions.prepare) available = await this.actions.prepare(binding.threadId) }
          catch (error) { preparationError = error }
          if (!available && !preparationError) {
            deferredCursor = Math.min(deferredCursor ?? message.cursor, message.cursor)
            continue
          }
          const claim = await this.call<{ claimed: boolean; threadId: string }>('claim', { messageId: message.id })
          if (!claim.claimed) continue
          let commandStatus = 'completed'
          let result: string
          try {
            if (preparationError) throw preparationError
            result = await this.execute(claim.threadId, message.text)
          } catch (error) {
            commandStatus = 'failed'
            result = `操作结果未确认：${error instanceof Error ? error.message : '会话操作失败'}。请先查询状态，再决定是否重新发送。`
          }
          // Completion is recorded even when the acknowledgement cannot be sent.
          await this.call('finish', { messageId: message.id, status: commandStatus })
          try { await this.send(claim.threadId, `ack:${message.id}`, result) }
          catch { this.warning(`ack:${message.id}`, '手机指令已处理，但 SeaTalk 回执发送失败；请先查询会话状态，避免重复提交。') }
        }
        this.cursor = deferredCursor === undefined ? page.cursor : deferredCursor - 1
        if (!page.hasMore || deferredCursor !== undefined) break
      }
      this.sendBudget = 24
      this.deadline = Date.now() + 2000
      for (let offset = 0; offset < snapshot.threads.length; offset++) {
        const index = this.nextThreadIndex % snapshot.threads.length
        const thread = snapshot.threads[index]
        this.nextThreadIndex = (index + 1) % snapshot.threads.length
        if (this.disposed) return
        if (thread.ephemeral || (!byThread.has(thread.id) && snapshot.archived)) continue
        const detail = snapshot.details[thread.id]
        if (!thread.preview && !detail?.items.length && !snapshot.activeTurnIds[thread.id]) continue
        try {
          if (Date.now() > this.deadline || this.sendBudget <= 0) { this.nextThreadIndex = index; break }
          let binding = byThread.get(thread.id)
          if (!binding) {
            binding = { threadId: thread.id, ...await this.call<Omit<Binding, 'threadId'>>('send', { threadId: thread.id, title: threadTitle(thread), cwd: thread.cwd }) }
            byThread.set(thread.id, binding)
          }
          await this.syncThread(thread, binding, snapshot)
        } catch (error) {
          if (error instanceof SyncYield) { this.nextThreadIndex = index; break }
          this.warning(`send:${thread.id}`, `会话「${threadTitle(thread)}」的 SeaTalk 同步未完成，请检查 Bridge 发送回执。`)
        }
      }
    } catch { this.warning('bridge', 'SeaTalk 会话同步暂不可用；电脑端可继续使用。请检查本机 Bridge。') }
    finally { this.running = false }
  }

  private async send(threadId: string, eventId: string, text: string, card?: { title: string; buttons: { text: string; command: string }[] }) {
    if (card && !this.interactiveCards) {
      this.warning('cards-unavailable', 'Bridge 尚未支持会话交互卡片，请安装配套补丁；当前可用文字指令处理审批和提问。')
      text = `${card.title}\n${text}\n\n${card.buttons.map(button => `${button.text}：${button.command}`).join('\n')}`
      card = undefined
    }
    // Split on Unicode codepoints; every segment is below the native byte limit.
    const segments: string[] = []; let segment = ''; let length = 0
    for (const char of text) {
      const size = bytes.encode(char).length
      if (length + size > (card ? 3500 : 16000)) { segments.push(segment); segment = ''; length = 0 }
      segment += char; length += size
    }
    if (segment) segments.push(segment)
    for (const [index, part] of segments.entries()) {
      if (this.disposed) return
      const key = `${threadId}:${eventId}:${index}`
      if (this.sent.has(key)) continue
      const thread = this.snapshot().threads.find(thread => thread.id === threadId)
      if (Date.now() > this.deadline || this.sendBudget <= 0) throw new SyncYield()
      --this.sendBudget
      this.sent.add(key)
      await this.call('send', { threadId, title: thread ? threadTitle(thread) : 'Harness 会话', cwd: thread?.cwd ?? '/', eventId: `${eventId}:${index}`, text: part, ...(card ? { card } : { format: 'markdown' }) })
    }
  }

  private async syncThread(thread: Thread, binding: Binding, snapshot: SeaTalkSnapshot) {
    const detail = snapshot.details[thread.id]
    const since = binding.createdAt
    const activeTurnId = snapshot.activeTurnIds[thread.id]
    for (const entry of detail?.items ?? []) {
      const turn = detail?.turns.find(turn => turn.id === entry.turnId)
      const completedAt = (entry.item.type === 'userMessage' ? entry.timing?.startedAt : undefined) ?? entry.timing?.completedAt ?? (millis(turn?.completedAt) || this.completedTurns.get(`${thread.id}:${entry.turnId}`))
      if (!completedAt || (completedAt < since && entry.turnId !== activeTurnId)) continue
      const item = entry.item
      if (!item.id || item.delivery === 'async') continue
      const isUser = item.type === 'userMessage'
      const isFinal = item.type === 'agentMessage' && (item.phase === 'final_answer' || (
        !item.phase && turn?.status === 'completed' &&
        !detail?.items.some(other => other.turnId === entry.turnId && other.item.phase === 'final_answer' && other.item.delivery !== 'async') &&
        detail?.items.filter(other => other.turnId === entry.turnId && other.item.type === 'agentMessage' && !other.item.phase && other.item.delivery !== 'async').at(-1) === entry
      ))
      if (!isUser && !isFinal) continue
      const text = isUser ? `你：\n${itemText(item)}` : itemText(item)
      if (text.trim()) await this.send(thread.id, `item:${entry.turnId}:${item.id}`, text)
    }
    for (const turn of detail?.turns ?? []) {
      if (!['failed', 'interrupted'].includes(turn.status) || (millis(turn.completedAt) || this.completedTurns.get(`${thread.id}:${turn.id}`) || 0) < since) continue
      await this.send(thread.id, `turn:${turn.id}:${turn.status}`, turn.status === 'failed' ? '本轮执行失败，请在 Harness 查看错误。' : turn.status === 'interrupted' ? '本轮已停止。' : '本轮执行完成。')
    }
    for (const request of pendingRequests(snapshot, thread.id)) {
      const token = await requestToken(request)
      if (this.answered.has(token)) continue
      const questions = parseUserInputQuestions(request.params)
      if (questions.some(question => question.isSecret)) {
        await this.send(thread.id, `request:${token}`, '有一个涉及敏感信息的问题，请回到 Harness 回答。')
      } else if (questions.length) {
        for (const [index, question] of questions.entries()) {
          const prompt = `${question.question}\n\n${question.options.map(option => `${option.label}${option.description ? `：${option.description}` : ''}`).join('\n')}\n\n自定义回答：/回答 ${token} ${questions.length === 1 ? '你的答案' : JSON.stringify(Object.fromEntries(questions.map(q => [q.id, '答案'])))}`
          await this.send(thread.id, `request:${token}:q${index}`, prompt, {
            title: question.header,
            buttons: question.options.slice(0, 5).map((option, optionIndex) => ({ text: option.label, command: `/选项 ${token} ${index} ${optionIndex}` })),
          })
        }
      } else if (isExecutableApproval(request)) {
        await this.send(thread.id, `request:${token}`, approvalDescription(request), { title: '需要审批', buttons: [
          { text: '批准本次操作', command: `/批准 ${token}` }, { text: '拒绝', command: `/拒绝 ${token}` },
        ] })
      } else {
        await this.send(thread.id, `request:${token}`, '有一个待处理请求，请回到 Harness 查看。')
      }
    }
  }

  private async execute(threadId: string, text: string): Promise<string> {
    const value = text.trim()
    if (!value) throw new Error('暂只支持文字消息')
    if (value === '/状态') {
      const snapshot = this.snapshot()
      return pendingRequests(snapshot, threadId).length ? '等待你处理审批或问题。' : snapshot.activeTurnIds[threadId] ? '正在执行。' : '当前空闲。'
    }
    if (value === '/停止') { await this.actions.stop(threadId); return '已请求停止当前轮次。' }
    const command = value.match(/^\/(批准|拒绝|回答|选项)\s+([a-f0-9]{16})(?:\s+([\s\S]+))?$/)
    if (command) {
      const [, action, token, answer] = command
      const requests = pendingRequests(this.snapshot(), threadId)
      const request = (await Promise.all(requests.map(async request => ({ request, token: await requestToken(request) })))).find(item => item.token === token)?.request
      if (!request || this.answered.has(token)) throw new Error('该请求已处理、已更新或已过期')
      const questions = parseUserInputQuestions(request.params)
      if (questions.some(question => question.isSecret)) throw new Error('敏感问题请在 Harness 内回答')
      if (action === '选项') {
        const choice = answer?.match(/^(\d+) (\d+)$/)
        const question = choice && questions[Number(choice[1])]
        const option = question && question.options[Number(choice![2])]
        if (!question || !option) throw new Error('选项已失效')
        const values = { ...this.selections.get(token), [question.id]: option.label }
        this.selections.set(token, values)
        if (questions.some(q => !values[q.id])) return `已选择「${option.label}」，请继续回答其余问题。`
        await this.actions.answer(request, { answers: Object.fromEntries(questions.map(q => [q.id, { answers: [values[q.id]] }])) })
        this.selections.delete(token)
      } else if (action === '回答') {
        if (!questions.length || !answer) throw new Error('请提供完整问题答案')
        const values = questions.length === 1 ? { [questions[0].id]: answer } : JSON.parse(answer) as Record<string, string>
        if (!values || typeof values !== 'object' || questions.some(question => typeof values[question.id] !== 'string' || !values[question.id].trim())) throw new Error('请回答所有问题')
        await this.actions.answer(request, { answers: Object.fromEntries(questions.map(question => [question.id, { answers: [values[question.id].trim()] }])) })
      } else {
        if (questions.length || !isExecutableApproval(request)) throw new Error('此请求需要回答问题')
        await this.actions.answer(request, action === '批准' ? 'accept' : 'decline')
      }
      this.answered.add(token)
      return action === '回答' || action === '选项' ? '回答已提交。' : action === '批准' ? '已批准本次请求。' : '已拒绝本次请求。'
    }
    if (value.startsWith('/')) throw new Error('支持 /状态、/停止、/批准、/拒绝、/回答；普通文字直接继续会话')
    await this.actions.send(threadId, value)
    return '已接收；执行中的追加消息会排队。'
  }
}
function millis(value: number | null | undefined) { return value ? value < 1e12 ? value * 1000 : value : 0 }
function isExecutableApproval(request: ApprovalRequest) {
  return ['execCommandApproval', 'applyPatchApproval', 'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'claude/tool/requestApproval'].includes(request.method)
}
function approvalDescription(request: ApprovalRequest) {
  const command = request.params.command
  const reason = request.params.reason
  return [Array.isArray(command) ? command.join(' ') : typeof command === 'string' ? command : '', typeof reason === 'string' ? reason : ''].filter(Boolean).join('\n') || '请核对电脑端显示的操作内容后决定。'
}

class SyncYield extends Error {}

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Bot, Check, CircleHelp, Inbox, LoaderCircle, MessageCircleReply, RefreshCw, Send } from 'lucide-react'
import type { AgentRunService } from '../../core/agent-runs/types'
import { itemText } from '../../core/domain/codex'
import type { LocalConnectorMessage, LocalConnectorService, LocalConnectorSendInput } from '../../core/local-connectors/types'
import type { ConversationTabProps, HarnessPlugin, PluginInstanceRecord, PluginSettingsProps } from '../../extensions/types'

interface SeaTalkConfig {
  baseUrl: string
  account: string
  defaultTargetType: 'user' | 'group'
  defaultTargetId: string
  defaultThreadId: string
}

interface SeaTalkSnapshot {
  phase: 'checking' | 'connected' | 'disconnected'
  accounts: string[]
  messages: LocalConnectorMessage[]
  error: string | null
  refreshedAt: number | null
}

export const seaTalkPlugin: HarnessPlugin = {
  manifest: {
    schemaVersion: 1,
    id: 'builtin.seatalk',
    name: 'SeaTalk Bridge',
    description: '通过本机 bridge 接收 SeaTalk 消息，并以可编辑草稿和显式确认方式发送。',
    version: '1.0.0',
    engine: { codexHarness: '^0.1.0' },
    supportedScopes: ['global', 'workspace', 'thread'],
    permissions: ['localhost:bridge-agent'],
  },
  settings: SeaTalkSettings,
  activate(ctx) {
    const connectors = ctx.services.get<LocalConnectorService>('harness.localConnectors')
    const agentRuns = ctx.services.get<AgentRunService>('harness.agentRuns')
    const config = readConfig(ctx.config)
    const bridge = new SeaTalkBridgeRuntime(connectors, config)
    bridge.start()
    ctx.effect(() => bridge.dispose())
    ctx.slots.conversationTabs.register({
      id: 'seatalk',
      label: 'SeaTalk',
      order: 40,
      icon: Send,
      render: (props) => (
        <SeaTalkTab
          bridge={bridge}
          agentRuns={agentRuns}
          instanceId={ctx.instanceId}
          config={config}
          context={props}
        />
      ),
    })
  },
}

export const seaTalkDefaultInstance: PluginInstanceRecord = {
  instanceId: 'builtin.seatalk:default',
  pluginId: seaTalkPlugin.manifest.id,
  scope: { kind: 'global' },
  enabled: true,
  config: {
    baseUrl: 'http://127.0.0.1:8787',
    account: 'seatalk-local',
    defaultTargetType: 'group',
    defaultTargetId: '',
    defaultThreadId: '',
  },
  createdAt: 0,
  updatedAt: 0,
}

class SeaTalkBridgeRuntime {
  private snapshotValue: SeaTalkSnapshot = {
    phase: 'checking',
    accounts: [],
    messages: [],
    error: null,
    refreshedAt: null,
  }
  private readonly listeners = new Set<() => void>()
  private interval: number | null = null
  private refreshing = false

  constructor(
    private readonly connector: LocalConnectorService,
    private readonly config: SeaTalkConfig,
  ) {}

  snapshot = (): SeaTalkSnapshot => this.snapshotValue

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(): void {
    void this.refresh()
    this.interval = window.setInterval(() => void this.refresh(), 5_000)
  }

  dispose(): void {
    if (this.interval !== null) window.clearInterval(this.interval)
    this.interval = null
    this.listeners.clear()
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return
    this.refreshing = true
    try {
      const [health, messages] = await Promise.all([
        this.connector.health(this.config.baseUrl),
        this.connector.listMessages(this.config.baseUrl, 100),
      ])
      this.setSnapshot({
        phase: health.ok ? 'connected' : 'disconnected',
        accounts: health.accounts ?? health.channels ?? [],
        messages: messages.filter((message) => message.direction === 'inbound' && message.platform.toLowerCase().includes('seatalk')),
        error: health.ok ? null : 'bridge 健康检查未通过',
        refreshedAt: Date.now(),
      })
    } catch (error) {
      this.setSnapshot({ ...this.snapshotValue, phase: 'disconnected', error: messageOf(error), refreshedAt: Date.now() })
    } finally {
      this.refreshing = false
    }
  }

  async send(input: Omit<LocalConnectorSendInput, 'account'>): Promise<{ ok: boolean; messageId?: string }> {
    const result = await this.connector.sendMessage(this.config.baseUrl, { ...input, account: this.config.account })
    await this.refresh()
    return result
  }

  private setSnapshot(snapshot: SeaTalkSnapshot): void {
    this.snapshotValue = snapshot
    for (const listener of this.listeners) listener()
  }
}

function SeaTalkTab({ bridge, agentRuns, instanceId, config, context }: {
  bridge: SeaTalkBridgeRuntime
  agentRuns: AgentRunService
  instanceId: string
  config: SeaTalkConfig
  context: ConversationTabProps
}) {
  const snapshot = useSyncExternalStore(bridge.subscribe, bridge.snapshot)
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null)
  const clearReplyTarget = useCallback(() => setReplyTarget(null), [])
  const accountMissing = snapshot.phase === 'connected' && snapshot.accounts.length > 0 && !snapshot.accounts.includes(config.account)
  return (
    <div className="seatalk-scroll">
      <div className="seatalk-page">
        <header className="seatalk-heading">
          <div>
            <span className="settings-kicker">LOCAL COMPANION</span>
            <h2>SeaTalk Bridge</h2>
            <p>收件箱保持在内存中；发送必须经过草稿预览与显式确认。</p>
          </div>
          <div className={`seatalk-connection ${snapshot.phase}`}>
            <span />{snapshot.phase === 'connected' ? '已连接' : snapshot.phase === 'checking' ? '检查中' : '未连接'}
            <button type="button" onClick={() => void bridge.refresh()} title="刷新 bridge"><RefreshCw size={13} /></button>
          </div>
        </header>
        {(snapshot.error || accountMissing) && <div className="seatalk-error">{snapshot.error ?? `bridge 中找不到 account：${config.account}`}</div>}
        <div className="seatalk-grid">
          <SeaTalkDraft
            bridge={bridge}
            agentRuns={agentRuns}
            instanceId={instanceId}
            config={config}
            context={context}
            replyTarget={replyTarget}
            onReplyConsumed={clearReplyTarget}
          />
          <SeaTalkInbox snapshot={snapshot} onReply={setReplyTarget} />
        </div>
      </div>
    </div>
  )
}

interface ReplyTarget {
  type: 'user' | 'group'
  id: string
  threadId: string
  sender: string
  message: string
}

function SeaTalkDraft({ bridge, agentRuns, instanceId, config, context, replyTarget, onReplyConsumed }: {
  bridge: SeaTalkBridgeRuntime
  agentRuns: AgentRunService
  instanceId: string
  config: SeaTalkConfig
  context: ConversationTabProps
  replyTarget: ReplyTarget | null
  onReplyConsumed(): void
}) {
  const runs = useSyncExternalStore(agentRuns.subscribe, agentRuns.snapshot)
  const [targetType, setTargetType] = useState<'user' | 'group'>(config.defaultTargetType)
  const [targetId, setTargetId] = useState(config.defaultTargetId)
  const [threadId, setThreadId] = useState(config.defaultThreadId)
  const [intent, setIntent] = useState('')
  const [draft, setDraft] = useState('')
  const [draftRunId, setDraftRunId] = useState<string | null>(null)
  const [loadedRunId, setLoadedRunId] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sentMessageId, setSentMessageId] = useState<string | null>(null)
  const draftRun = runs.find((run) => run.runId === draftRunId) ?? null

  useEffect(() => {
    if (!replyTarget) return
    setTargetType(replyTarget.type)
    setTargetId(replyTarget.id)
    setThreadId(replyTarget.threadId)
    setIntent(`回复 ${replyTarget.sender} 的这条 SeaTalk 消息：\n${replyTarget.message}`)
    setConfirming(false)
    onReplyConsumed()
  }, [onReplyConsumed, replyTarget])

  useEffect(() => {
    if (!draftRun || draftRun.runId === loadedRunId) return
    if (draftRun.status === 'failed' || draftRun.status === 'cancelled') {
      setError(draftRun.errorSummary ?? '草稿生成任务未完成')
      setLoadedRunId(draftRun.runId)
      return
    }
    if (draftRun.status !== 'completed') return
    setLoadedRunId(draftRun.runId)
    void agentRuns.loadResult(draftRun.runId)
      .then((result) => setDraft(cleanDraft(result)))
      .catch((nextError) => setError(messageOf(nextError)))
  }, [agentRuns, draftRun, loadedRunId])

  const generate = async () => {
    if (!context.workspaceRoot || !intent.trim()) return
    setBusy(true)
    setError(null)
    setSentMessageId(null)
    try {
      const run = await agentRuns.start({
        instanceId,
        title: '生成 SeaTalk 草稿',
        mode: 'detached',
        workspaceRoot: context.workspaceRoot,
        prompt: draftPrompt(intent, context),
      })
      setDraftRunId(run.runId)
      setLoadedRunId(null)
    } catch (nextError) {
      setError(messageOf(nextError))
    } finally {
      setBusy(false)
    }
  }

  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await bridge.send({
        targetType,
        targetId: targetId.trim(),
        text: draft.trim(),
        threadId: threadId.trim() || null,
      })
      if (!result.ok) throw new Error('bridge 未确认消息已发送')
      setSentMessageId(result.messageId ?? 'sent')
      setConfirming(false)
    } catch (nextError) {
      setError(messageOf(nextError))
    } finally {
      setBusy(false)
    }
  }

  const generating = draftRun?.status === 'starting' || draftRun?.status === 'running' || draftRun?.status === 'waitingApproval'
  const ready = Boolean(targetId.trim() && draft.trim())

  return (
    <section className="seatalk-card seatalk-draft">
      <div className="seatalk-card-title"><Send size={16} /><div><h3>组织并发送</h3><p>Codex 只生成草稿；Harness 不会自动发送。</p></div></div>
      <div className="seatalk-target-row">
        <select value={targetType} onChange={(event) => setTargetType(event.target.value as 'user' | 'group')}>
          <option value="group">群组</option><option value="user">同事</option>
        </select>
        <input value={targetId} onChange={(event) => setTargetId(event.target.value)} placeholder="目标 ID" />
      </div>
      <input value={threadId} onChange={(event) => setThreadId(event.target.value)} placeholder="Thread / root message ID（可选）" />
      <textarea value={intent} onChange={(event) => setIntent(event.target.value)} rows={3} placeholder="告诉 Codex 这段发言的目的、语气和重点…" />
      <button type="button" className="seatalk-generate" disabled={busy || generating || !intent.trim() || !context.workspaceRoot} onClick={() => void generate()}>
        {generating ? <LoaderCircle className="spin" size={14} /> : <Bot size={14} />}{generating ? 'Codex 正在起草' : '用当前会话生成草稿'}
      </button>
      {!context.workspaceRoot && <small className="seatalk-hint">当前会话没有已识别的 workspace，仍可手动填写草稿。</small>}
      <label className="seatalk-draft-editor"><span>可编辑草稿</span><textarea value={draft} onChange={(event) => { setDraft(event.target.value); setConfirming(false); setSentMessageId(null) }} rows={7} placeholder="生成结果会出现在这里，也可以直接输入…" /></label>
      {error && <div className="seatalk-error">{error}</div>}
      {sentMessageId && <div className="seatalk-sent"><Check size={14} />已发送 · {sentMessageId}</div>}
      {confirming ? (
        <div className="seatalk-confirm">
          <strong>确认发送到 {targetType === 'group' ? '群组' : '同事'} {targetId}</strong>
          <pre>{draft}</pre>
          <div><button type="button" onClick={() => setConfirming(false)}>返回编辑</button><button type="button" className="primary" disabled={busy} onClick={() => void send()}>{busy ? '发送中' : '确认发送'}</button></div>
        </div>
      ) : (
        <button type="button" className="seatalk-preview" disabled={!ready || busy} onClick={() => setConfirming(true)}>预览并确认</button>
      )}
    </section>
  )
}

function SeaTalkInbox({ snapshot, onReply }: { snapshot: SeaTalkSnapshot; onReply(target: ReplyTarget): void }) {
  return (
    <section className="seatalk-card seatalk-inbox">
      <div className="seatalk-card-title"><Inbox size={16} /><div><h3>Inbox</h3><p>{snapshot.messages.length} 条最近入站消息 · 仅内存</p></div></div>
      <div className="seatalk-message-list">
        {snapshot.messages.length === 0 ? <div className="seatalk-empty">暂无 SeaTalk 入站消息。</div> : snapshot.messages.map((message) => {
          const target = replyTargetFor(message)
          return (
            <article key={message.id} className="seatalk-message">
              <header><strong>{message.senderName ?? message.senderId ?? 'SeaTalk 用户'}</strong><time>{formatTime(message.receivedAt ?? message.createdAt)}</time></header>
              <p>{message.text || `[${message.messageType}]`}</p>
              <footer><span>{message.conversationType === 'dm' ? '私聊' : '群组'} · {message.conversationId ?? '未知会话'}</span>{target && <button type="button" onClick={() => onReply(target)}><MessageCircleReply size={12} />回复</button>}</footer>
            </article>
          )
        })}
      </div>
    </section>
  )
}

function SeaTalkSettings({ instance, saveConfig }: PluginSettingsProps) {
  const [form, setForm] = useState(() => readConfig(instance.config))
  const [saved, setSaved] = useState(false)
  const save = async () => {
    await saveConfig({ ...form })
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1_500)
  }
  return (
    <div className="plugin-business-settings seatalk-settings">
      <label className="plugin-setting-row"><span>Bridge 地址 <i className="plugin-field-help" title="仅允许连接本机 127.0.0.1 或 ::1；凭据仍由 bridge-agent 管理。"><CircleHelp size={13} /></i></span><input value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} /></label>
      <label className="plugin-setting-row"><span>Bridge account</span><input value={form.account} onChange={(event) => setForm({ ...form, account: event.target.value })} /></label>
      <label className="plugin-setting-row"><span>默认目标</span><select value={form.defaultTargetType} onChange={(event) => setForm({ ...form, defaultTargetType: event.target.value as 'user' | 'group' })}><option value="group">群组</option><option value="user">同事</option></select></label>
      <label className="plugin-setting-row"><span>目标 ID</span><input value={form.defaultTargetId} onChange={(event) => setForm({ ...form, defaultTargetId: event.target.value })} /></label>
      <label className="plugin-setting-row"><span>默认 Thread ID</span><input value={form.defaultThreadId} onChange={(event) => setForm({ ...form, defaultThreadId: event.target.value })} placeholder="可选" /></label>
      <div className="plugin-setting-row plugin-setting-actions"><span>保存设置</span><button type="button" onClick={() => void save()}>{saved ? '已保存' : '保存'}</button></div>
    </div>
  )
}

function readConfig(config: Readonly<Record<string, unknown>>): SeaTalkConfig {
  return {
    baseUrl: textConfig(config.baseUrl, 'http://127.0.0.1:8787'),
    account: textConfig(config.account, 'seatalk-local'),
    defaultTargetType: config.defaultTargetType === 'user' ? 'user' : 'group',
    defaultTargetId: textConfig(config.defaultTargetId, ''),
    defaultThreadId: textConfig(config.defaultThreadId, ''),
  }
}

function textConfig(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function draftPrompt(intent: string, context: ConversationTabProps): string {
  const transcript = context.items
    .filter((entry) => entry.item.type === 'userMessage' || entry.item.type === 'agentMessage')
    .slice(-8)
    .map((entry) => `${entry.item.type === 'userMessage' ? '用户' : 'Codex'}：${itemText(entry.item)}`)
    .join('\n\n')
    .slice(-8_000)
  return [
    '请为一条即将发送给 SeaTalk 同事或群组的消息起草正文。',
    '只输出可直接发送的正文，不要解释、不要加 Markdown 代码围栏，也不要声称已经发送。',
    `发言意图：${intent.trim()}`,
    transcript ? `当前 Harness 会话的最近上下文：\n${transcript}` : '当前会话没有可用的文字上下文。',
  ].join('\n\n')
}

function cleanDraft(value: string): string {
  return value.trim().replace(/^```(?:text|markdown)?\s*/i, '').replace(/\s*```$/, '').trim()
}

function replyTargetFor(message: LocalConnectorMessage): ReplyTarget | null {
  if (!message.replyTargetType || !message.replyTargetId) return null
  return {
    type: message.replyTargetType,
    id: message.replyTargetId,
    threadId: message.threadId ?? '',
    sender: message.senderName ?? message.senderId ?? 'SeaTalk 用户',
    message: message.text || `[${message.messageType}]`,
  }
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

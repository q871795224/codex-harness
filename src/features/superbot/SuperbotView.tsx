import { useEffect, useRef, useState } from 'react'
import { Archive, ArchiveRestore, Bot, ExternalLink, LoaderCircle, RefreshCw, Send, Square } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { runtime } from '../../core/runtime/bridge'
import { remoteSuperbotId, type SuperbotModel, type SuperbotRunConfig, type SuperbotSession, type SuperbotSnapshot } from '../../core/superbot/types'
import { MarkdownLink } from '../markdown/MarkdownLink'
import { MarkdownCodeBlock } from '../markdown/MarkdownCodeBlock'
import type { useSuperbotHarness } from './useSuperbotHarness'
import './SuperbotView.css'

export function SuperbotView({ id, session, snapshot, service, draft, onDraft, sendShortcut, draftReady, onArchive }: {
  id: string; session?: SuperbotSession; snapshot?: SuperbotSnapshot
  service: ReturnType<typeof useSuperbotHarness>; draft: string; onDraft: (text: string) => void
  sendShortcut: 'enter' | 'mod-enter'; draftReady: boolean; onArchive?: (archived: boolean) => Promise<unknown>
}) {
  const [settings, setSettings] = useState<SuperbotRunConfig>({})
  const initialized = useRef(false)
  const [title, setTitle] = useState(session?.title ?? '')
  const [editingTitle, setEditingTitle] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [sending, setSending] = useState(false)
  const sendLock = useRef(false)
  const draftRef = useRef(draft); draftRef.current = draft
  const scroll = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const textArea = useRef<HTMLTextAreaElement>(null)
  const { catalog, read } = service
  useEffect(() => { void catalog().catch(e => setLocalError(String(e))) }, [catalog])
  useEffect(() => {
    if (initialized.current || !snapshot) return
    initialized.current = true
    setSettings(snapshot.session.run_config ?? {})
  }, [snapshot])
  useEffect(() => { if (!editingTitle) setTitle(session?.title ?? '') }, [session?.title, editingTitle])
  useEffect(() => {
    if (stickToBottom.current) scroll.current?.scrollTo?.({ top: scroll.current.scrollHeight })
  }, [snapshot])
  const active = Boolean(snapshot?.pending.task_id)
  const readOnly = !session || session.read_only || session.status === 'archived'
  const model = service.models.find(m => m.id === settings.model)
  const levels = model?.thinking?.supported_levels ?? []
  const run = async (fn: () => Promise<unknown>) => {
    setLocalError(null)
    try { await fn() } catch (e) { setLocalError(String(e)) }
  }
  const send = async () => {
    if (sendLock.current || sending || service.busy || active || readOnly || !draft.trim() || !snapshot) return
    const submitted = draft
    sendLock.current = true
    setSending(true); setLocalError(null)
    try {
      await service.send(id, submitted, settings)
      if (draftRef.current === submitted) onDraft('')
      stickToBottom.current = true
    } catch (e) { setLocalError(String(e)) } finally { sendLock.current = false; setSending(false) }
  }
  const changeModel = (value: string, models: SuperbotModel[]) => {
    const chosen = models.find(m => m.id === value)
    setSettings(value ? { model: value, thinking_level: chosen?.thinking?.default_level ?? '' } : { reset: true })
  }
  return <section className="superbot-view" aria-label="Superbot 会话">
    <header className="superbot-header">
      <Bot size={19} />
      {editingTitle ? <form onSubmit={e => { e.preventDefault(); void run(async () => { await service.rename(id, title); setEditingTitle(false) }) }}>
        <input aria-label="Superbot 会话标题" value={title} onChange={e => setTitle(e.target.value)} autoFocus maxLength={200} />
        <button disabled={service.busy}>保存</button><button type="button" onClick={() => setEditingTitle(false)}>取消</button>
      </form> : <button className="superbot-title" disabled={readOnly} title="重命名会话" onClick={() => setEditingTitle(true)}>{session?.title ?? 'Superbot'}</button>}
      <span className="superbot-environment">公司云端 · naming</span>
      <button type="button" title="刷新会话与模型" aria-label="刷新 Superbot" disabled={service.busy} onClick={() => void run(() => Promise.all([read(id), catalog(), service.refresh()]))}><RefreshCw size={15} /></button>
      <button type="button" title="在 Collab 打开" aria-label="在 Collab 打开" onClick={() => void run(() => runtime.openExternalUrl(`https://collab.shopee.io/naming/chat?session=${remoteSuperbotId(id)}`))}><ExternalLink size={15} /></button>
      <button type="button" aria-label={session?.status === 'archived' ? '恢复 Superbot 会话' : '归档 Superbot 会话'} disabled={service.busy || active || session?.read_only} onClick={() => void run(() => onArchive ? onArchive(session?.status !== 'archived') : service.archive(id, session?.status !== 'archived'))}>
        {session?.status === 'archived' ? <ArchiveRestore size={15} /> : <Archive size={15} />}
      </button>
    </header>
    {(localError || service.error) && <div className="superbot-error" role="alert">{localError || service.error}</div>}
    <div className="conversation-scroll" ref={scroll} onScroll={() => {
      const el = scroll.current; if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100
    }}><div className="message-column">
      {!snapshot && !service.error && <p role="status"><LoaderCircle size={15} className="spin" /> 正在读取会话…</p>}
      {snapshot?.page.has_more && snapshot.page.next_cursor && <button type="button" disabled={loadingOlder} onClick={() => {
        const before = snapshot.page.next_cursor!; stickToBottom.current = false; setLoadingOlder(true)
        const oldHeight = scroll.current?.scrollHeight ?? 0
        void run(async () => { await read(id, before) }).finally(() => {
          setLoadingOlder(false)
          requestAnimationFrame(() => { if (scroll.current) scroll.current.scrollTop += scroll.current.scrollHeight - oldHeight })
        })
      }}>{loadingOlder ? '正在加载…' : '加载更早消息'}</button>}
      {snapshot?.page.messages.length === 0 && <p className="superbot-empty">向 Superbot 发送消息，任务将在公司云端执行。</p>}
      {snapshot?.page.messages.map(message => <article key={message.id} className={`message ${message.role === 'user' ? 'user-message' : 'agent-message'}`}>
        <div className="message-label">{message.role === 'user' ? '你' : 'Superbot'}<time dateTime={message.created_at}>{new Date(message.created_at).toLocaleString()}</time></div>
        <div className={message.role === 'user' ? 'user-bubble markdown-body' : 'markdown-body'}><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: MarkdownLink, pre: MarkdownCodeBlock, img: ({ alt }) => <span>{alt || '图片'}（在 Collab 查看）</span> }}>{message.content}</ReactMarkdown></div>
        {message.failure_reason && <p className="superbot-error">{message.failure_reason}</p>}
        {message.task_status === 'failed' && !message.failure_reason && <p className="superbot-error">任务失败，请在 Collab 查看详情。</p>}
      </article>)}
      {active && <article className="message agent-message" aria-label="Superbot 执行过程">
        <div className="message-label"><LoaderCircle size={14} className="spin" />Superbot · {snapshot?.pending.status ?? '执行中'}</div>
        <p role="status">正在公司云端执行…</p>
        {snapshot?.events.map(event => <details key={event.seq}><summary>{event.tool || event.type}</summary><pre>{event.content ?? event.text ?? JSON.stringify(event.output ?? event.result ?? event.input ?? {}, null, 2)}</pre></details>)}
      </article>}
    </div></div>
    <form className="superbot-composer" onSubmit={e => { e.preventDefault(); void send() }}>
      <div className="superbot-settings">
        <label>模型<select aria-label="Superbot 模型" disabled={service.busy || active || readOnly} value={settings.model ?? ''} onChange={e => changeModel(e.target.value, service.models)}>
          <option value="">Superbot 默认模型</option>
          {settings.model && !service.models.some(m => m.id === settings.model) && <option value={settings.model}>{settings.model}</option>}
          {service.models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select></label>
        <label>推理强度<select aria-label="Superbot 推理强度" disabled={service.busy || active || readOnly || levels.length === 0} value={settings.thinking_level ?? ''} onChange={e => setSettings(s => ({ ...s, thinking_level: e.target.value }))}>
          <option value="">默认</option>{levels.map(level => <option key={level.value} value={level.value}>{level.label}</option>)}
        </select></label>
      </div>
      <textarea ref={textArea} aria-label="发送给 Superbot 的消息" placeholder={readOnly ? '此会话只读' : active ? '任务运行中，可先编辑下一条消息' : '发送给 Superbot…'} disabled={!draftReady || readOnly} value={draft} onChange={e => onDraft(e.target.value)} onKeyDown={e => {
        if (e.nativeEvent.isComposing || e.key !== 'Enter' || e.shiftKey) return
        if (sendShortcut === 'enter' ? !e.metaKey && !e.ctrlKey && !e.altKey : (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send() }
      }} />
      <div className="superbot-send-row"><span>{session?.status === 'archived' ? '已归档' : 'Superbot · 公司云端'}</span>
        {active ? <button type="button" disabled={service.busy || readOnly} onClick={() => void run(() => service.stop(id))}><Square size={14} />停止</button>
          : <button type="submit" disabled={!draftReady || !snapshot || service.busy || sending || readOnly || !draft.trim()}><Send size={14} />{sending ? '发送中…' : '发送'}</button>}
      </div>
    </form>
  </section>
}

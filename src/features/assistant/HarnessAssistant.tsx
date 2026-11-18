import { Archive, ArrowUp, MessageCircle, Pin, PinOff, X } from 'lucide-react'
import { useRef, useState, type FormEvent, type MouseEvent } from 'react'
import { interpretSessionRequest, queryAssistantSessions, type AssistantSession, type SessionRequest } from './sessionAssistant'
import './assistant.css'

type Mutation = 'archive' | 'pin' | 'unpin'
const labels = { archive: '归档', pin: '置顶', unpin: '取消置顶' }
const providers = { codex: 'Codex', claude: 'Claude', superbot: 'Superbot' }
const pageSize = 12
const listRequest: SessionRequest = { action: 'list', provider: 'all', scope: 'active', query: '', recentDays: null, previousRows: [] }

interface Props {
  disabled: boolean
  pinned: readonly string[]
  onMutate(session: AssistantSession, action: Mutation): Promise<void>
}

export function HarnessAssistant({ disabled, pinned, onMutate }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const running = useRef(false)
  const [draft, setDraft] = useState('')
  const [prompt, setPrompt] = useState('')
  const [rows, setRows] = useState<AssistantSession[]>([])
  const [visibleCount, setVisibleCount] = useState(pageSize)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [suggested, setSuggested] = useState<Mutation | null>(null)
  const [confirmation, setConfirmation] = useState<{ session: AssistantSession; action: Mutation } | null>(null)

  function close() {
    dialog.current?.close()
    setConfirmation(null)
    trigger.current?.focus()
  }

  function closeFromBackdrop(event: MouseEvent<HTMLDialogElement>) {
    if (event.target !== event.currentTarget) return
    const bounds = event.currentTarget.getBoundingClientRect()
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close()
  }

  async function search(message: string, request?: SessionRequest) {
    if (disabled || running.current) return
    running.current = true
    setBusy(true)
    setPrompt(message)
    setError('')
    setStatus('正在查询会话…')
    setConfirmation(null)
    setSuggested(null)
    try {
      const previous = rows.slice(0, visibleCount)
      const intent = request ?? await interpretSessionRequest(message, previous)
      if (intent.action === 'unsupported') {
        setStatus('我可以查询会话、归档、置顶或取消置顶。')
        setRows([])
        return
      }
      const result = await queryAssistantSessions(intent, previous, pinned)
      setRows(result.rows)
      setVisibleCount(pageSize)
      setSuggested(intent.action === 'list' ? null : intent.action)
      setStatus(result.rows.length ? `找到 ${result.rows.length} 个会话` : '没有找到匹配的会话。')
      if (result.unavailable.length) setError(`${result.unavailable.map(provider => providers[provider]).join('、')} 会话目录暂不可用。`)
    } catch (reason) {
      setStatus('查询未完成。')
      setError(reason instanceof Error ? reason.message : String(reason))
      setRows([])
    } finally {
      running.current = false
      setBusy(false)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!draft.trim() || running.current) return
    void search(draft.trim())
    setDraft('')
  }

  async function apply() {
    if (!confirmation || running.current || disabled) return
    const { session, action } = confirmation
    running.current = true
    setBusy(true)
    setError('')
    setConfirmation(null)
    try {
      await onMutate(session, action)
      if (action === 'archive') setRows(current => current.filter(row => row.id !== session.id))
      setStatus(`已${labels[action]}「${session.title}」。`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setStatus(`未能${labels[action]}「${session.title}」。`)
    } finally {
      running.current = false
      setBusy(false)
    }
  }

  return (
    <div className="harness-assistant">
      <button ref={trigger} type="button" className="harness-assistant-launcher" aria-haspopup="dialog" title="打开 Harness 助理"
        onClick={() => { dialog.current?.showModal(); input.current?.focus() }}>
        <MessageCircle size={17} />助理
      </button>
      <dialog ref={dialog} className="harness-assistant-window" aria-labelledby="harness-assistant-title" onClick={closeFromBackdrop}
        onKeyDown={event => event.stopPropagation()}
        onCancel={event => { event.preventDefault(); event.stopPropagation(); close() }}>
        <header>
          <MessageCircle size={19} />
          <h2 id="harness-assistant-title">Harness 助理</h2>
          <button type="button" aria-label="关闭 Harness 助理" onClick={close}><X size={18} /></button>
        </header>
        <div className="harness-assistant-content" aria-busy={busy}>
          {!prompt && <div className="harness-assistant-start">
            <p>想查找或整理哪些会话？</p>
            <div>
              <button type="button" disabled={disabled} onClick={() => void search('查看最近 7 天的会话', { ...listRequest, recentDays: 7 })}>最近会话</button>
              <button type="button" disabled={disabled} onClick={() => void search('查看已置顶会话', { ...listRequest, scope: 'pinned' })}>已置顶</button>
            </div>
          </div>}
          {prompt && <p className="harness-assistant-prompt">{prompt}</p>}
          <div role="status">{status}{suggested && rows.length > 0 && !busy && ` · 可选择会话${labels[suggested]}`}</div>
          {error && <p className="harness-assistant-error" role="alert">{error}</p>}
          {rows.length > 0 && <ol className="harness-assistant-results">
            {rows.slice(0, visibleCount).map((session, index) => {
              const pinAction = pinned.includes(session.id) ? 'unpin' : 'pin'
              const PinIcon = pinAction === 'unpin' ? PinOff : Pin
              return <li key={session.id}>
                <span aria-hidden="true" className="harness-assistant-row-number">{index + 1}</span>
                <div className="harness-assistant-row-text">
                  <strong title={session.title}>{session.title}</strong>
                  <small title={session.cwd}>{providers[session.provider]}{session.cwd && ` · ${session.cwd.split(/[/\\\\]/).filter(Boolean).at(-1)}`}
                    {session.archived ? ' · 已归档' : pinned.includes(session.id) ? ' · 已置顶' : ''}</small>
                </div>
                {!session.archived && <>
                  <button type="button" disabled={busy || disabled} data-suggested={suggested === pinAction}
                    title={labels[pinAction]} aria-label={`${labels[pinAction]}${session.title}`}
                    onClick={() => setConfirmation({ action: pinAction, session })}><PinIcon size={16} /></button>
                  <button type="button" disabled={busy || disabled} data-suggested={suggested === 'archive'}
                    title="归档" aria-label={`归档${session.title}`}
                    onClick={() => setConfirmation({ action: 'archive', session })}><Archive size={16} /></button>
                </>}
              </li>
            })}
          </ol>}
          {rows.length > visibleCount && <button className="harness-assistant-more" type="button" disabled={busy} onClick={() => setVisibleCount(count => count + pageSize)}>显示更多</button>}
        </div>
        {confirmation && <div className="harness-assistant-confirm" role="group" aria-label="确认会话操作">
          <span>{labels[confirmation.action]}「{confirmation.session.title}」？</span>
          <button type="button" onClick={() => setConfirmation(null)}>取消</button>
          <button type="button" className="harness-assistant-primary" disabled={disabled} onClick={() => void apply()}>确认{labels[confirmation.action]}</button>
        </div>}
        <form onSubmit={submit}>
          <input ref={input} aria-label="给助理发消息" placeholder="例如：找一下最近的 Router 会话" value={draft}
            maxLength={1000} onChange={event => setDraft(event.target.value)} />
          <button type="submit" className="harness-assistant-primary" aria-label="发送给助理" disabled={disabled || busy || !draft.trim()}><ArrowUp size={18} /></button>
        </form>
      </dialog>
    </div>
  )
}

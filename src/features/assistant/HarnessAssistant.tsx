import { Archive, MessageCircle, Pin, PinOff, X } from 'lucide-react'
import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react'
import { ASSISTANT_INSTRUCTIONS, assistantInput, assistantVisibleInput, parseSessionRequest, queryAssistantSessions, type AssistantSession, type SessionRequest } from './sessionAssistant'
import type { MessageReference, UserInput } from '../../core/domain/codex'
import type { useCodexCore } from '../codex/useCodexCore'
import { Composer, type ComposerDraft } from '../conversation/Composer'
import { sameComposerDraft } from '../conversation/composerDraftStorage'
import { QueueDock } from '../conversation/QueueDock'
import { useDelayedSend } from '../conversation/useDelayedSend'
import type { useUnifiedHarness } from '../conversation/useUnifiedHarness'
import './assistant.css'

type Mutation = 'archive' | 'pin' | 'unpin'
type WindowPosition = { left: number; top: number }

function withinViewport(position: WindowPosition, bounds: DOMRect): WindowPosition {
  return {
    left: Math.max(0, Math.min(position.left, window.innerWidth - bounds.width)),
    top: Math.max(0, Math.min(position.top, window.innerHeight - bounds.height)),
  }
}
const labels = { archive: '归档', pin: '置顶', unpin: '取消置顶' }
const providers = { codex: 'Codex', claude: 'Claude', superbot: 'Superbot' }
const pageSize = 12
const listRequest: SessionRequest = { action: 'list', provider: 'all', scope: 'active', query: '', recentDays: null, referenceIds: [] }

interface Props {
  harness: Pick<ReturnType<typeof useUnifiedHarness>, 'assistantThread' | 'busy' | 'details' | 'keyboard' | 'pendingSteers' | 'queues' | 'setFollowUpMode' | 'threadTokenUsages' | 'workingThreadIds'>
  codex: Pick<ReturnType<typeof useCodexCore>, 'models' | 'loading' | 'settingsForThread' | 'syncThreadSettings' | 'updateThreadSettings'>
  disabled: boolean
  pinned: readonly string[]
  onMutate(session: AssistantSession, action: Mutation): Promise<void>
}

export function HarnessAssistant({ harness, codex, disabled, pinned, onMutate }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const [threadId, setThreadId] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [position, setPosition] = useState<WindowPosition>()
  const drag = useRef<{ pointerId: number; offsetX: number; offsetY: number }>()
  const titlebarPress = useRef(false)
  useEffect(() => {
    if (!dialogOpen) return
    const keepOnScreen = () => {
      const bounds = dialog.current?.getBoundingClientRect()
      if (!bounds) return
      setPosition(current => {
        if (!current) return current
        const next = withinViewport(current, bounds)
        return next.left === current.left && next.top === current.top ? current : next
      })
    }
    keepOnScreen()
    window.addEventListener('resize', keepOnScreen)
    return () => window.removeEventListener('resize', keepOnScreen)
  }, [dialogOpen])
  const [loading, setLoading] = useState(false)
  const draft = useRef<ComposerDraft>()
  const [consumedDraft, setConsumedDraft] = useState<ComposerDraft>()
  const handledTurn = useRef<string>()
  const resultVersion = useRef(0)
  const allowedReferences = useRef(new Set<string>())
  const detail = threadId ? harness.details[threadId] : undefined
  const queue = threadId ? harness.queues[threadId] ?? [] : []
  const pendingSteers = threadId ? harness.pendingSteers[threadId] ?? [] : []
  const visibleQueue = queue.map(item => ({ ...item, input: assistantVisibleInput(item.input) }))
  const visibleSteers = pendingSteers.map(item => ({
    ...item,
    text: assistantVisibleInput(item.input).flatMap(input => input.type === 'text' ? [input.text] : []).join('\n').trim() || '附件',
  }))
  const actualSettings = detail?.threadSettings
  const { syncThreadSettings } = codex
  useEffect(() => {
    if (threadId && actualSettings) syncThreadSettings(threadId, actualSettings)
  }, [threadId, actualSettings, syncThreadSettings])
  const running = useRef(false)
  const [prompt, setPrompt] = useState('')
  const [rows, setRows] = useState<AssistantSession[]>([])
  const [visibleCount, setVisibleCount] = useState(pageSize)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [suggested, setSuggested] = useState<Mutation | null>(null)
  const [confirmation, setConfirmation] = useState<{ session: AssistantSession; action: Mutation } | null>(null)

  function close() {
    drag.current = undefined
    titlebarPress.current = false
    dialog.current?.close()
    setDialogOpen(false)
    setConfirmation(null)
    trigger.current?.focus()
  }

  function startDrag(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0 || drag.current || (event.target as Element).closest('button')) return
    const floatingWindow = dialog.current
    if (!floatingWindow) return
    const bounds = floatingWindow.getBoundingClientRect()
    floatingWindow.setPointerCapture(event.pointerId)
    titlebarPress.current = true
    drag.current = { pointerId: event.pointerId, offsetX: event.clientX - bounds.left, offsetY: event.clientY - bounds.top }
    event.preventDefault()
  }

  function moveWindow(event: PointerEvent<HTMLElement>) {
    const active = drag.current
    const bounds = dialog.current?.getBoundingClientRect()
    if (!active || event.pointerId !== active.pointerId || !bounds) return
    setPosition(withinViewport({ left: event.clientX - active.offsetX, top: event.clientY - active.offsetY }, bounds))
  }

  function finishDrag(event: PointerEvent<HTMLElement>) {
    if (drag.current?.pointerId === event.pointerId) drag.current = undefined
  }

  function closeFromBackdrop(event: MouseEvent<HTMLDialogElement>) {
    if (event.target !== event.currentTarget || titlebarPress.current) return
    const bounds = event.currentTarget.getBoundingClientRect()
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close()
  }

  async function search(request: SessionRequest) {
    const version = ++resultVersion.current
    setStatus('正在查询会话…')
    setError('')
    setConfirmation(null)
    setSuggested(null)
    try {
      if (request.action === 'unsupported') {
        setStatus('我可以查询会话、归档、置顶或取消置顶。')
        setRows([])
        return
      }
      if (request.referenceIds.some(id => !allowedReferences.current.has(id))) {
        throw new Error('引用的会话已无法定位，请重新查询。')
      }
      const result = await queryAssistantSessions(request, pinned)
      if (version !== resultVersion.current) return
      setRows(result.rows)
      setVisibleCount(pageSize)
      setSuggested(request.action === 'list' ? null : request.action)
      setStatus(result.rows.length ? `找到 ${result.rows.length} 个会话` : '没有找到匹配的会话。')
      if (result.unavailable.length) setError(`${result.unavailable.map(provider => providers[provider]).join('、')} 会话目录暂不可用。`)
    } catch (reason) {
      if (version !== resultVersion.current) return
      setStatus('查询未完成。')
      setError(reason instanceof Error ? reason.message : String(reason))
      setRows([])
    }
  }

  async function open() {
    if (dialog.current && !dialog.current.open) dialog.current.showModal()
    setDialogOpen(true)
    if (threadId) return
    if (disabled || loading) return
    setLoading(true)
    setError('')
    try {
      setThreadId(await harness.assistantThread.create(ASSISTANT_INSTRUCTIONS))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setLoading(false) }
  }

  async function send(id: string, input: UserInput[], mode: 'interject' | 'queue', references?: MessageReference[]) {
    if (disabled) throw new Error('Harness 暂不可用，草稿已保留。')
    const previous = rows.slice(0, visibleCount)
    for (const row of previous) allowedReferences.current.add(row.id)
    const message = input.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n').trim()
    await harness.assistantThread.send(id, assistantInput(input, previous), mode, references)
    setPrompt(message || '附件')
    setConfirmation(null)
    setError('')
  }

  const delayed = useDelayedSend(async (id, message) => {
    if (!sameComposerDraft(draft.current, message.draft)) throw new Error('草稿已变更，请重新设置延迟发送。')
    await send(id, message.input, message.mode, message.references)
    setConsumedDraft(message.draft)
  }, (_, reason) => setError(reason instanceof Error ? reason.message : String(reason)))

  const latestTurn = detail?.turns.filter(turn => turn.status !== 'inProgress').at(-1)
  const finalText = latestTurn
    ? detail?.items.slice().reverse().find(entry => entry.turnId === latestTurn.id && entry.item.type === 'agentMessage' && entry.item.phase !== 'commentary')?.item.text
      ?? latestTurn.items.slice().reverse().find(item => item.type === 'agentMessage' && item.phase !== 'commentary')?.text
    : undefined
  useEffect(() => {
    if (!latestTurn || handledTurn.current === latestTurn.id) return
    handledTurn.current = latestTurn.id
    if (latestTurn.status === 'failed') {
      setError(latestTurn.error?.message || '助理执行失败。')
      return
    }
    if (latestTurn.status === 'interrupted') return
    try {
      void search(parseSessionRequest(finalText ?? ''))
    } catch {
      setStatus('助理未能生成会话查询，请换一种说法。')
    }
  }, [latestTurn, finalText])

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
        onClick={() => void open()}>
        <MessageCircle size={17} />助理
      </button>
      <dialog ref={dialog} className="harness-assistant-window" aria-labelledby="harness-assistant-title" onClick={closeFromBackdrop}
        style={position ? { ...position, right: 'auto', bottom: 'auto' } : undefined}
        onPointerDownCapture={() => { titlebarPress.current = false }}
        onPointerMove={moveWindow} onPointerUp={finishDrag} onPointerCancel={finishDrag} onLostPointerCapture={finishDrag}
        onKeyDown={event => event.stopPropagation()}
        onCancel={event => { event.preventDefault(); event.stopPropagation(); close() }}>
        <header className="harness-assistant-titlebar" onPointerDown={startDrag}>
          <MessageCircle size={19} />
          <h2 id="harness-assistant-title">Harness 助理</h2>
          <button type="button" aria-label="关闭 Harness 助理" onClick={close}><X size={18} /></button>
        </header>
        <div className="harness-assistant-content" aria-busy={busy}>
          {!prompt && <div className="harness-assistant-start">
            <p>想查找或整理哪些会话？</p>
            <div>
              <button type="button" disabled={disabled} onClick={() => { setPrompt('查看最近 7 天的会话'); void search({ ...listRequest, recentDays: 7 }) }}>最近会话</button>
              <button type="button" disabled={disabled} onClick={() => { setPrompt('查看已置顶会话'); void search({ ...listRequest, scope: 'pinned' }) }}>已置顶</button>
            </div>
          </div>}
          {prompt && <p className="harness-assistant-prompt">{prompt}</p>}
          <div role="status">{threadId && harness.workingThreadIds[threadId] ? '助理正在处理…' : status}{suggested && rows.length > 0 && !busy && ` · 可选择会话${labels[suggested]}`}</div>
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
        <div className="harness-assistant-composer">
          {loading && <span role="status">正在打开助理会话…</span>}
          {!threadId && !loading && !disabled && <button type="button" onClick={() => void open()}>打开助理会话</button>}
          {threadId && <>
            <QueueDock queue={visibleQueue} pendingSteers={visibleSteers}
              busy={harness.busy} working={Boolean(harness.workingThreadIds[threadId])}
              canMutate={!disabled && !detail?.foreignActive}
              onRemove={id => void harness.assistantThread.removeQueue(id, threadId)}
              onPromote={item => {
                const original = queue.find(entry => entry.id === item.id)
                if (original) void harness.assistantThread.promoteQueue(original, threadId)
              }}
              onStart={() => void harness.assistantThread.startQueue(threadId)} />
            <Composer variant="assistant" threadId={threadId} consumedDraft={consumedDraft}
              disabled={disabled || Boolean(detail?.foreignActive)} busy={busy || harness.assistantThread.submitting}
              working={Boolean(harness.workingThreadIds[threadId])} foreignActive={Boolean(detail?.foreignActive)}
              contextUsage={harness.threadTokenUsages[threadId] ?? null}
              workspaceRoot={detail?.thread.cwd ?? null}
              sendShortcut={harness.keyboard.sendShortcut} followUpMode={harness.keyboard.followUpMode}
              focusRequest={0} autoFocus={dialogOpen} rawMode={false}
              models={codex.models} settings={codex.settingsForThread(threadId)} settingsDisabled={codex.loading}
              onSettingsChange={patch => codex.updateThreadSettings(threadId, patch, false)}
              onFollowUpModeChange={harness.setFollowUpMode}
              delayedSend={delayed.pending[threadId]}
              onCancelDelayedSend={() => delayed.cancel(threadId)}
              onScheduleSend={(minutes, input, mode, references, titleSource) => {
                if (draft.current) delayed.schedule(threadId, minutes, { input, mode, references, titleSource, draft: draft.current })
              }}
              onDraftChange={next => { draft.current = next }}
              onSend={(input, mode, references) => send(threadId, input, mode, references)}
              onCommand={() => {}}
              onStop={() => harness.assistantThread.stop(threadId)} />
          </>}
        </div>
      </dialog>
    </div>
  )
}

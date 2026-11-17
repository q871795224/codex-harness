import { useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, MessageSquareText, RefreshCw } from 'lucide-react'
import { runtime } from '../../core/runtime/bridge'
import type { ThreadCodexSettings } from '../../core/domain/codex'
import { remoteSuperbotId, superbotThread, type SuperbotRunConfig, type SuperbotSession, type SuperbotSnapshot } from '../../core/superbot/types'
import { superbotTranscript } from '../../core/superbot/transcript'
import { Composer, type ComposerDraft } from '../conversation/Composer'
import { ConversationHeader, ConversationView } from '../conversation/ConversationView'
import type { useSuperbotHarness } from './useSuperbotHarness'

/** Cloud data adapter; all conversation UI is shared with Codex and Claude. */
export function SuperbotView({ id, session, snapshot, service, draft, onDraft, sendShortcut, draftReady, onArchive, pinned = false, onTogglePinned, codexSettings, focusRequest = 0, conversationFocusRequest = 0 }: {
  id: string; session?: SuperbotSession; snapshot?: SuperbotSnapshot
  service: ReturnType<typeof useSuperbotHarness>; draft?: ComposerDraft; onDraft: (draft: ComposerDraft) => void
  sendShortcut: 'enter' | 'mod-enter'; draftReady: boolean; onArchive?: (archived: boolean) => Promise<unknown>
  pinned?: boolean; onTogglePinned?: () => void; codexSettings: ThreadCodexSettings
  focusRequest?: number; conversationFocusRequest?: number
}) {
  const [settings, setSettings] = useState<SuperbotRunConfig>({})
  const initialized = useRef(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [rawMode, setRawMode] = useState(false)
  const [rawOverrides, setRawOverrides] = useState<ReadonlySet<string>>(new Set())
  const [scrollRequest, setScrollRequest] = useState(0)
  const { catalog, read } = service
  useEffect(() => { void catalog().catch(e => setLocalError(String(e))) }, [catalog])
  useEffect(() => {
    if (initialized.current || !snapshot) return
    initialized.current = true
    setSettings(snapshot.session.run_config ?? {})
  }, [snapshot])
  const transcript = useMemo(() => superbotTranscript(snapshot), [snapshot])
  const activeTurn = transcript.turns.find(turn => turn.id === transcript.activeTurnId)
  const selected = session ?? snapshot?.session
  const thread = selected ? superbotThread(selected, snapshot?.pending.task_id) : null
  const active = Boolean(transcript.activeTurnId)
  const readOnly = !selected || selected.read_only || selected.status === 'archived'
  const initialDraft = useMemo(() => draft?.attachments.length ? { ...draft, attachments: [] } : draft, [draft])
  const run = async (fn: () => Promise<unknown>) => {
    setLocalError(null)
    try { await fn() } catch (e) { setLocalError(String(e)) }
  }
  const archive = (value: boolean) => run(() => onArchive ? onArchive(value) : service.archive(id, value))
  return <>
    {thread && <ConversationHeader thread={thread} workspace={null} gitContextResolved={false}
      archived={selected?.status === 'archived'} isWorking={active} pinned={pinned}
      workspaceChanging={false} canChangeWorkspace={false} environmentLabel="公司云端 · naming"
      readOnly={selected?.read_only || service.busy} onRename={title => void run(() => service.rename(id, title))}
      onArchive={() => void archive(true)} onUnarchive={() => void archive(false)}
      onTogglePinned={() => onTogglePinned?.()} onChooseWorkspace={() => {}}
      headerActions={<>
        <button type="button" className="thread-project" title="刷新会话与模型" aria-label="刷新 Superbot" disabled={service.busy} onClick={() => void run(() => Promise.all([read(id), catalog(), service.refresh()]))}><RefreshCw size={13} />刷新</button>
        <button type="button" className="thread-project" aria-label="在 Collab 打开" onClick={() => void run(() => runtime.openExternalUrl(`https://collab.shopee.io/naming/chat?session=${remoteSuperbotId(id)}`))}><ExternalLink size={13} />Collab</button>
      </>} />}
    <div className="tab-bar">
      <div className="thread-tabs"><button type="button" className="active"><MessageSquareText size={15} />对话</button></div>
      <div className="notification-tab-tools"><span className="connection-state"><span />Superbot · 公司云端</span></div>
    </div>
    <ConversationView threadId={id} provider="superbot" items={transcript.items} turns={transcript.turns} cwd=""
      approvals={[]} workspace={null} workspaces={[]} workspaceChanging={false} initialScrollTop={null}
      scrollToLatestRequest={scrollRequest} hasOlderTurns={snapshot?.page.has_more ?? false} loadingOlderTurns={loadingOlder}
      onLoadOlderTurns={() => {
        const before = snapshot?.page.next_cursor
        if (!before || loadingOlder) return
        setLoadingOlder(true)
        void run(() => read(id, before)).finally(() => setLoadingOlder(false))
      }}
      onAnswerApproval={() => {}} onScrollPosition={() => {}} onWorkspaceChange={() => {}} onChooseWorkspace={() => {}}
      rawMode={rawMode} onRawModeToggle={() => setRawMode(false)} rawOverrides={rawOverrides}
      onRawOverrideToggle={key => setRawOverrides(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next })}
      working={active} workingTurnId={transcript.activeTurnId} workingStartedAt={activeTurn?.startedAt != null ? activeTurn.startedAt * 1000 : null}
      conversationFocusRequest={conversationFocusRequest}
      banners={<>
        {(localError || service.error) && <div className="composer-inline-error" role="alert">{localError || service.error}</div>}
        {!snapshot && !service.error && <p role="status">正在读取会话…</p>}
      </>} />
    {draftReady && selected?.status !== 'archived' && <div className="input-column">
      <Composer provider="superbot" threadId={id} initialDraft={initialDraft} disabled={!draftReady || !snapshot || readOnly}
        working={active} foreignActive={false} busy={service.busy} contextUsage={null} workspaceRoot={null}
        sendShortcut={sendShortcut} focusRequest={focusRequest} models={[]} settings={codexSettings}
        superbotModels={service.models} superbotSettings={settings} onSuperbotSettingsChange={setSettings}
        rawMode={rawMode} followUpMode="queue" onSettingsChange={() => {}} onFollowUpModeChange={() => {}}
        onCommand={() => {}} onStop={() => run(() => service.stop(id))} onDraftChange={next => onDraft(next)}
        onSend={async input => {
          const content = input.filter(item => item.type === 'text').map(item => item.text).join('\n')
          if (active || readOnly) throw new Error('当前会话无法发送消息')
          setLocalError(null)
          try { await service.send(id, content, settings); setScrollRequest(n => n + 1) }
          catch (e) { setLocalError(String(e)); throw e }
        }} />
    </div>}
  </>
}

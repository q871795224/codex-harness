import { useEffect, useState, type CSSProperties } from 'react'
import { DEFAULT_FONT_SIZES } from '../../core/domain/codex'
import type { DesktopAssistantSnapshot } from '../../core/desktop-pet/assistantTypes'
import { runtime } from '../../core/runtime/bridge'
import { HarnessAssistant } from '../assistant/HarnessAssistant'

export default function DesktopAssistantWindow() {
  const [state, setState] = useState<DesktopAssistantSnapshot>()
  const [error, setError] = useState('')
  useEffect(() => {
    let disposed = false
    let remove: (() => void) | undefined
    const accept = (next: DesktopAssistantSnapshot) => {
      if (!disposed) setState(current => !current || next.sequence > current.sequence ? next : current)
    }
    void runtime.listenDesktopAssistantState(accept).then(unlisten => {
      if (disposed) { unlisten(); return }
      remove = unlisten
      return runtime.desktopAssistantRequest('state', null).then(accept)
    }).catch(reason => { if (!disposed) setError(String(reason)) })
    return () => { disposed = true; remove?.() }
  }, [])

  if (!state) return <main className="desktop-assistant-loading" role={error ? 'alert' : 'status'}>{error || '正在打开助理会话…'}</main>
  const id = state.threadId
  const map = <T,>(value: T): Record<string, T> => id ? { [id]: value } : {}
  return <main className="app-shell desktop-assistant-shell" data-theme={state.theme} style={{
    '--h-navigation-font-offset': `${state.fontSizes.navigation - DEFAULT_FONT_SIZES.navigation}px`,
    '--h-conversation-font-offset': `${state.fontSizes.conversation - DEFAULT_FONT_SIZES.conversation}px`,
  } as CSSProperties}>
    <HarnessAssistant standalone disabled={state.disabled} pinned={state.pinned} harness={{
      assistantThread: {
        submitting: state.submitting,
        create: () => runtime.desktopAssistantRequest('create', null),
        send: (threadId, input, mode, references) => runtime.desktopAssistantRequest('send', { threadId, input, mode, references }),
        stop: threadId => runtime.desktopAssistantRequest('stop', { threadId: threadId ?? '' }),
        removeQueue: (queueId, threadId) => runtime.desktopAssistantRequest('removeQueue', { threadId: threadId ?? '', queueId }),
        promoteQueue: (item, threadId) => runtime.desktopAssistantRequest('promoteQueue', { threadId: threadId ?? '', queueId: item.id }),
        startQueue: threadId => runtime.desktopAssistantRequest('startQueue', { threadId: threadId ?? '' }),
      },
      busy: state.busy, details: state.detail ? map(state.detail) : {}, keyboard: state.keyboard,
      pendingSteers: map(state.pendingSteers), queues: map(state.queue), threadTokenUsages: state.usage ? map(state.usage) : {},
      workingThreadIds: map(state.working),
      setFollowUpMode: mode => { void runtime.desktopAssistantRequest('followUp', { mode }).catch(reason => setError(String(reason))) },
    }} codex={{
      models: state.models, loading: state.loading, settingsForThread: () => state.settings, syncThreadSettings: () => {},
      updateThreadSettings: (threadId, patch) => runtime.desktopAssistantRequest('settings', { threadId, model: patch.model, effort: patch.effort }),
    }} onMutate={(session, action) => runtime.desktopAssistantRequest('mutate', { id: session.id, action })}
      onQuery={request => runtime.desktopAssistantRequest('query', request)}
      onClose={() => { void runtime.desktopAssistantHide().catch(reason => setError(String(reason))) }} />
    {error && <p className="desktop-assistant-surface-error" role="alert">{error}</p>}
  </main>
}

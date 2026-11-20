import { useEffect, useRef } from 'react'
import type { useUnifiedHarness } from '../../features/conversation/useUnifiedHarness'
import { runtime } from '../runtime/bridge'
import { appServer } from '../runtime/appServerClient'
import { listAllActiveThreads } from '../../features/conversation/threadCatalog'
import { SeaTalkSync } from './service'

function logSyncIssue(event: string) {
  void runtime.recordClientDiagnostic({ level: 'info', area: 'seatalk-sync', event }).catch(() => undefined)
}

export function useSeaTalkSync(harness: ReturnType<typeof useUnifiedHarness>) {
  const current = useRef(harness)
  current.current = harness
  const catalog = useRef(new Map<string, (typeof harness.threads)[number]>())
  if (harness.viewMode !== 'archived') for (const thread of harness.threads) catalog.current.set(thread.id, thread)
  useEffect(() => {
    if (harness.phase !== 'ready') return
    let disposed = false
    void listAllActiveThreads(appServer).then(threads => {
      if (disposed) return
      for (const thread of threads) if (!catalog.current.has(thread.id)) catalog.current.set(thread.id, thread)
    }).catch(() => logSyncIssue('catalog.read_failed'))
    return () => { disposed = true }
  }, [harness.phase])
  useEffect(() => {
    const service = new SeaTalkSync(runtime.seatalkRemoteCall, () => ({
      threads: [...catalog.current.values()], details: current.current.details,
      approvals: current.current.approvals, activeTurnIds: current.current.activeTurnIds,
      archived: false, queues: current.current.queues,
    }), {
      prepare: threadId => current.current.prepareRemoteThread(threadId),
      send: (threadId, text) => current.current.sendRemoteMessage(threadId, text),
      stop: threadId => current.current.stopRemoteTurn(threadId),
      answer: (request, decision) => current.current.answerRemoteApproval(request, decision),
      warn: message => logSyncIssue(message.startsWith('会话「') ? 'thread.delivery_unconfirmed' : 'bridge.sync_warning'),
    })
    const unsubscribe = current.current.onTurnCompleted(event => service.noteTurnCompleted(event.threadId, event.turnId))
    void service.tick()
    const timer = window.setInterval(() => void service.tick(), 2000)
    return () => { window.clearInterval(timer); unsubscribe(); service.dispose() }
  }, [])
}

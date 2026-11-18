import { useEffect, useRef } from 'react'
import type { AssistantMutation, DesktopAssistantRequest, DesktopAssistantSnapshot } from '../../core/desktop-pet/assistantTypes'
import { runtime } from '../../core/runtime/bridge'
import { ASSISTANT_INSTRUCTIONS, parseSessionRequest, queryAssistantSessions, type AssistantSession } from '../assistant/sessionAssistant'
import type { useCodexCore } from '../codex/useCodexCore'
import type { useUnifiedHarness } from '../conversation/useUnifiedHarness'

interface Host {
  harness: ReturnType<typeof useUnifiedHarness>
  codex: ReturnType<typeof useCodexCore>
  onMutate: (session: AssistantSession, action: AssistantMutation) => Promise<void>
}

function snapshot({ harness, codex }: Host, sequence: number): DesktopAssistantSnapshot {
  const id = harness.assistantThreadId
  const full = id ? harness.details[id] : undefined
  // The separate window needs the latest answer, not the underlying transcript.
  const latest = full?.turns.filter(turn => turn.status !== 'inProgress').at(-1)
  const detail = full && {
    ...full, thread: { ...full.thread, turns: undefined },
    turns: latest ? [{ ...latest, items: latest.items.filter(item => item.type === 'agentMessage') }] : [],
    items: latest ? full.items.filter(entry => entry.turnId === latest.id && entry.item.type === 'agentMessage') : [],
  }
  const queue = id ? harness.queues[id] ?? [] : []
  return {
    sequence, disabled: harness.phase !== 'ready', theme: harness.appearance.theme, fontSizes: harness.appearance.fontSizes,
    threadId: id, detail, submitting: harness.assistantThread.submitting,
    busy: Object.fromEntries(queue.map(item => [`promote:${item.id}`, Boolean(harness.busy[`promote:${item.id}`])])),
    working: Boolean(id && harness.workingThreadIds[id]),
    queue, pendingSteers: id ? harness.pendingSteers[id] ?? [] : [], usage: id ? harness.threadTokenUsages[id] ?? null : null,
    keyboard: harness.keyboard, pinned: harness.navigation.pinnedThreadIds,
    models: codex.models, loading: codex.loading, settings: codex.settingsForThread(id),
  }
}

async function handle(host: Host, request: DesktopAssistantRequest, catalog: { candidates: Map<string, AssistantSession>; revision: number }, sequence: number): Promise<unknown> {
  const { harness, codex } = host
  if (request.action === 'state') return snapshot(host, sequence)
  if (harness.phase !== 'ready') throw new Error('Harness 正在准备，请稍后重试。')
  const { action, args } = request
  if (args && 'threadId' in args && args.threadId !== harness.assistantThreadId) throw new Error('助理会话已变更。')
  switch (action) {
    case 'create': return harness.assistantThread.create(ASSISTANT_INSTRUCTIONS)
    case 'send': return harness.assistantThread.send(args.threadId, args.input, args.mode, args.references)
    case 'stop': return harness.assistantThread.stop(args.threadId)
    case 'removeQueue': return harness.assistantThread.removeQueue(args.queueId, args.threadId)
    case 'startQueue': return harness.assistantThread.startQueue(args.threadId)
    case 'promoteQueue': {
      const item = harness.queues[args.threadId]?.find(queued => queued.id === args.queueId)
      if (!item) throw new Error('排队消息已变更。')
      return harness.assistantThread.promoteQueue(item, args.threadId)
    }
    case 'settings': return codex.updateThreadSettings(args.threadId, { model: args.model, effort: args.effort }, false)
    case 'followUp': {
      if (args.mode !== 'queue' && args.mode !== 'interject') throw new Error('后续消息模式无效。')
      return harness.setFollowUpMode(args.mode)
    }
    case 'query': {
      const result = await queryAssistantSessions(parseSessionRequest(JSON.stringify(args)), harness.navigation.pinnedThreadIds)
      if (sequence >= catalog.revision) {
        catalog.revision = sequence
        catalog.candidates = new Map(result.rows.map(session => [session.id, session]))
      }
      return result
    }
    case 'mutate': {
      const session = catalog.candidates.get(args.id)
      if (!session || session.archived || !['archive', 'pin', 'unpin'].includes(args.action)) throw new Error('请重新查询要操作的会话。')
      return host.onMutate(session, args.action)
    }
  }
}

export function useDesktopAssistantHost(host: Host, enabled: boolean) {
  const current = useRef(host)
  current.current = host
  const connected = useRef(false)
  const sequence = useRef(0)
  const lastState = useRef('')
  useEffect(() => {
    let disposed = false
    let remove: (() => void) | undefined
    const catalog = { candidates: new Map<string, AssistantSession>(), revision: 0 }
    void runtime.listenDesktopAssistantRequest(request => {
      if (disposed) return
      if (request.action === 'state') connected.current = true
      void handle(current.current, request, catalog, ++sequence.current).then(
        result => runtime.desktopAssistantReply(request.id, result),
        error => runtime.desktopAssistantReply(request.id, null, error instanceof Error ? error.message : String(error)),
      ).catch(() => undefined)
    }).then(unlisten => { if (disposed) unlisten(); else remove = unlisten }).catch(() => undefined)
    return () => { disposed = true; remove?.(); connected.current = false }
  }, [])
  useEffect(() => {
    if (!enabled || !connected.current) return
    const next = snapshot(current.current, 0)
    const serialized = JSON.stringify(next)
    if (serialized === lastState.current) return
    lastState.current = serialized
    void runtime.desktopAssistantState({ ...next, sequence: ++sequence.current }).catch(() => { lastState.current = '' })
  })
}

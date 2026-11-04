import { useEffect, useState, useSyncExternalStore } from 'react'
import { FileArchive, LoaderCircle, X } from 'lucide-react'
import type { ConversationService } from '../../core/conversations/types'
import type { AgentRunService } from '../../core/agent-runs/types'
import type { ProjectDocService } from '../../core/project-docs/types'
import type { ConversationBannerProps, PluginStorage } from '../../extensions/types'
import type { CompactionResult } from '../../features/project-doc/types'
import type { ProjectDocConfig } from './config'
import { compactProject } from './compaction'
import { archiveStore } from './archiveStore'

export interface CompactionState {
  projectId: string; threadId: string; tokens: number; threshold: number
  phase: 'confirm' | 'running' | 'done' | 'error'; result?: CompactionResult; error?: string
}
const listeners = new Set<() => void>()
let cards: ReadonlyMap<string, CompactionState> = new Map()
let completedTurns: ReadonlyMap<string, string> = new Map()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
function publish(card: CompactionState) {
  cards = new Map(cards).set(card.projectId, card)
  listeners.forEach((listener) => listener())
}
function remove(id: string) {
  const next = new Map(cards); next.delete(id); cards = next
  listeners.forEach((listener) => listener())
}
export interface CompactionDeps {
  docs: ProjectDocService; runs: AgentRunService; config: ProjectDocConfig
  instanceId: string; storage: PluginStorage
}
export async function requestCompaction(deps: CompactionDeps, threadId: string, manual: boolean): Promise<void> {
  const projectId = await deps.docs.threadProject(threadId)
  if (!projectId) { if (manual) throw new Error('当前会话未绑定项目'); return }
  const current = cards.get(projectId)
  if (current?.phase === 'running') return
  const measure = await deps.docs.measure(projectId)
  if (!manual) {
    if (measure.tokens <= deps.config.compactionThreshold || cards.has(projectId)) return
    const dismissed = await deps.storage.get<number>(`compaction.dismissed.${projectId}`)
    if (dismissed && Date.now() - dismissed < 86_400_000) return
  }
  // Another request may have advanced while the native count was in flight.
  if (cards.get(projectId)?.phase === 'running') return
  publish({ projectId, threadId, tokens: measure.tokens, threshold: deps.config.compactionThreshold, phase: 'confirm' })
  if (manual) archiveStore.requestSelect(projectId, 'chat')
}
// Events contain no workspace context. Only signal completion here; the resolved
// banner (with the effective workspace/thread plugin settings) decides to prompt.
export function watchCompaction(conversations: ConversationService): () => void {
  return conversations.onTurnCompleted((event) => {
    if (event.status !== 'completed' || completedTurns.get(event.threadId) === event.turnId) return
    completedTurns = new Map(completedTurns).set(event.threadId, event.turnId)
    listeners.forEach((listener) => listener())
  })
}

export function CompactionCard({ state, onConfirm, onDismiss, onOpen }: {
  state: CompactionState; onConfirm: () => void; onDismiss: () => void; onOpen: () => void
}) {
  const number = (value: number) => value.toLocaleString('en-US')
  return <aside className="recap-banner project-compaction-card" aria-label="精简项目文档" role="status">
    {state.phase === 'running' ? <LoaderCircle size={15} className="spin" /> : <FileArchive size={15} />}
    <div className="recap-banner-body">
      <strong>{state.phase === 'done' ? '项目文档已整理' : '精简项目文档'}</strong>
      {state.phase === 'confirm' && <>
        <p>当前 {number(state.tokens)} / 门限 {number(state.threshold)} tokens。</p>
        <p>将完整归档原文并自动精简，可在项目历史中恢复。</p>
        <div className="project-compaction-actions">
          <button type="button" className="primary" onClick={onConfirm}>整理并归档</button>
          <button type="button" onClick={onDismiss}>暂不整理</button>
        </div>
      </>}
      {state.phase === 'running' && <p>正在整理，完成后自动保存。</p>}
      {state.phase === 'done' && <>
        <p>{number(state.result!.beforeTokens)} → {number(state.result!.afterTokens)} tokens</p>
        <div className="project-compaction-actions"><button type="button" onClick={onOpen}>查看项目历史</button></div>
      </>}
      {state.phase === 'error' && <p role="alert">{state.error}</p>}
    </div>
    {state.phase !== 'running' && <button type="button" className="project-compaction-close" onClick={onDismiss} aria-label="关闭精简提醒"><X size={13} /></button>}
  </aside>
}
export function CompactionBanner({ deps, props }: { deps: CompactionDeps; props: ConversationBannerProps }) {
  const current = useSyncExternalStore(subscribe, () => cards)
  const completed = useSyncExternalStore(subscribe, () => completedTurns).get(props.threadId ?? '')
  useEffect(() => {
    if (completed && props.threadId) void requestCompaction(deps, props.threadId, false).catch(() => undefined)
  }, [completed, props.threadId, deps])
  const state = [...current.values()].find((card) => card.threadId === props.threadId)
  if (!state) return null
  const dismiss = () => {
    remove(state.projectId)
    void deps.storage.set(`compaction.dismissed.${state.projectId}`, Date.now()).catch(() => undefined)
  }
  const confirm = async () => {
    if (!props.checkoutRoot || !props.threadId) { publish({ ...state, phase: 'error', error: '会话缺少工作目录，原文未替换。' }); return }
    if (cards.get(state.projectId)?.phase !== 'confirm') return
    publish({ ...state, phase: 'running' })
    try {
      const result = await compactProject(deps, state.projectId, props.threadId, props.checkoutRoot)
      publish({ ...state, phase: 'done', result })
    } catch (error) {
      publish({ ...state, phase: 'error', error: String(error) })
    }
  }
  return <CompactionCard state={state} onConfirm={() => void confirm()} onDismiss={dismiss}
    onOpen={() => archiveStore.requestSelect(state.projectId, 'history')} />
}
export function CompactionButton({ deps, threadId, disabled }: { deps: CompactionDeps; threadId: string | null; disabled: boolean }) {
  const [error, setError] = useState('')
  const request = async () => {
    setError('')
    try { if (threadId) await requestCompaction(deps, threadId, true) }
    catch (error) { setError(String(error)) }
  }
  return <span className="project-archive-action">
    <button type="button" className="composer-icon-button" title="精简项目文档" aria-label="精简项目文档" disabled={disabled || !threadId} onClick={() => void request()}><FileArchive size={15} /></button>
    {error && <span className="project-archive-error" role="alert">{error}</span>}
  </span>
}

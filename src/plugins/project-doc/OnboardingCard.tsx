import { useEffect, useState, useSyncExternalStore } from 'react'
import { ArrowRight, Check, FolderPlus, LoaderCircle, NotebookPen, X } from 'lucide-react'
import type { ConversationBannerProps } from '../../extensions/types'
import type { ProjectDocService } from '../../core/project-docs/types'
import type { OnboardingSettings, OnboardingState, ProjectOnboardingService } from '../../core/project-onboarding/types'
import type { ProjectMeta } from '../../features/project-doc/types'
import { archiveStore } from './archiveStore'

export function OnboardingCard({ state, projects, onConfirm, onDismiss, onOpen }: {
  state: OnboardingState; projects: ProjectMeta[] | null
  onConfirm: (selection: { mode: 'create' | 'join'; name: string; projectId: string }) => void
  onDismiss: () => void; onOpen: () => void
}) {
  const [mode, setMode] = useState(state.mode)
  const [name, setName] = useState(state.name)
  const [projectId, setProjectId] = useState(state.projectId)
  const editing = state.phase === 'confirm' || state.phase === 'error'
  const saved = Boolean(state.receipt)
  const done = state.phase === 'done'
  const selected = projects?.find(p => p.projectId === projectId)
  const title = done ? (state.mode === 'create' ? '项目已建立' : '已加入项目')
    : editing ? '从这段会话建立项目记忆' : '正在整理项目记忆'
  return <aside className={`recap-banner project-onboarding-card phase-${state.phase}`} aria-label="新建或加入项目" role="status">
    <div className="project-onboarding-mark" aria-hidden>{done ? <Check size={18} /> : editing ? <NotebookPen size={18} /> : <LoaderCircle size={18} className="spin" />}</div>
    <div className="recap-banner-body">
      <div className="project-onboarding-heading"><strong>{title}</strong>{state.requestedBy === 'agent' && <span className="project-onboarding-origin">Agent 发起</span>}</div>
      <p className="project-onboarding-source" title={state.source.title}>{state.source.title}</p>
      {editing && !saved && <>
        <div className="project-onboarding-modes" role="group" aria-label="项目操作">
          <button type="button" aria-pressed={mode === 'create'} onClick={() => setMode('create')}>新建项目</button>
          <button type="button" aria-pressed={mode === 'join'} onClick={() => setMode('join')}>加入已有项目</button>
        </div>
        <label className="project-onboarding-field">{mode === 'create' ? '项目名称' : '目标项目'}
          {mode === 'create' ? <input aria-label="项目名称" value={name} onChange={e => setName(e.target.value)} placeholder="给这件持续推进的事起个名字" />
            : <select aria-label="目标项目" value={projectId} onChange={e => setProjectId(e.target.value)} disabled={projects === null}>
              <option value="">{projects === null ? '正在读取项目…' : projects.length ? '选择要加入的项目' : '暂无项目，可以先新建'}</option>
              {projects?.map(p => <option key={p.projectId} value={p.projectId}>{p.name}</option>)}
            </select>}
        </label>
        <p className="project-onboarding-description">{mode === 'create'
          ? '总结此前对话中的目标、决定与待办，生成项目文档。'
          : '对照已有文档补记此前结论，保留原有内容和历史。'}</p>
        <p className="project-onboarding-note">完成后自动保存，本会话将继续维护该项目。</p>
      </>}
      {!editing && !done && <>
        <p className="project-onboarding-description">{state.detail ?? '正在读取会话历史'}</p>
        {state.messages !== undefined && <p className="project-onboarding-note">已读取 {state.messages} 条对话与执行记录{state.chunks && state.chunks > 1 ? ` · 分段整理 ${state.completedChunks ?? 0}/${state.chunks}` : ''}</p>}
      </>}
      {done && <><p className="project-onboarding-result">{state.name}</p><p className="project-onboarding-note">此前结论已保存，后续对话将沿用项目背景。</p></>}
      {state.error && <p role="alert" className="project-onboarding-error">{state.error}</p>}
      {(editing || done) && <div className="project-compaction-actions project-onboarding-actions">
        {done ? <button type="button" className="primary" onClick={onOpen}>查看项目文档 <ArrowRight size={13} /></button> : <>
          <button type="button" className="primary" disabled={!saved && (mode === 'create' ? !name.trim() : !selected)} onClick={() => onConfirm({ mode, name: mode === 'join' ? selected?.name ?? name : name, projectId })}>
            {saved ? '继续完成绑定' : state.phase === 'error' ? '重新整理' : mode === 'create' ? '创建并总结' : '加入并补记'}
          </button>
          {!saved && <button type="button" onClick={onDismiss}>暂不处理</button>}
        </>}
      </div>}
    </div>
    {(done || (editing && !saved)) && <button type="button" className="project-compaction-close" onClick={onDismiss} aria-label="关闭项目确认卡"><X size={14} /></button>}
  </aside>
}

export function OnboardingBanner({ service, settings, props }: {
  service: ProjectOnboardingService; settings: OnboardingSettings; props: ConversationBannerProps
}) {
  const card = useSyncExternalStore(service.subscribe, service.snapshot).get(props.threadId ?? '')
  const [projects, setProjects] = useState<ProjectMeta[] | null>(null)
  useEffect(() => {
    let disposed = false
    if (card) void service.listProjects().then(list => { if (!disposed) setProjects(list) }).catch(() => { if (!disposed) setProjects([]) })
    return () => { disposed = true }
  }, [service, card?.id])
  if (!card) return null
  return <OnboardingCard key={card.id} state={card} projects={projects}
    onConfirm={selection => { void service.confirm(card.source.threadId, selection, settings) }}
    onDismiss={() => service.dismiss(card.source.threadId)} onOpen={() => archiveStore.requestSelect(card.receipt!.projectId)} />
}
export function OnboardingButton({ service, docs, threadId, disabled }: {
  service: ProjectOnboardingService; docs: ProjectDocService; threadId: string | null; disabled: boolean
}) {
  const [bound, setBound] = useState(true), [error, setError] = useState('')
  useEffect(() => {
    let disposed = false
    const refresh = () => {
      if (!threadId) { setBound(true); return }
      void docs.threadBinding(threadId).then(binding => { if (!disposed) setBound(Boolean(binding)) })
        .catch(() => { if (!disposed) setBound(true) })
    }
    refresh(); const unsubscribe = docs.subscribeBindings(refresh)
    return () => { disposed = true; unsubscribe() }
  }, [docs, threadId])
  if (bound || !threadId) return null
  return <span className="project-archive-action">
    <button type="button" className="composer-icon-button" title="从会话新建或加入项目" aria-label="新建或加入项目" disabled={disabled}
      onClick={() => { setError(''); void service.request(threadId).catch(e => setError(String(e))) }}><FolderPlus size={15} /></button>
    {error && <span role="alert" className="project-archive-error">{error}</span>}
  </span>
}

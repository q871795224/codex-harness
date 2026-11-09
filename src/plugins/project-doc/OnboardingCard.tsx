import { useEffect, useState, useSyncExternalStore } from 'react'
import { Check, CircleHelp, FolderPlus, LoaderCircle, X } from 'lucide-react'
import type { ConversationBannerProps } from '../../extensions/types'
import type { ProjectDocService } from '../../core/project-docs/types'
import type { OnboardingSettings, OnboardingState, ProjectOnboardingService } from '../../core/project-onboarding/types'
import type { ProjectMeta } from '../../features/project-doc/types'
import { archiveStore } from './archiveStore'

export function OnboardingCard({ state, projects, onConfirm, onDismiss, onOpen, onDraft }: {
  state: OnboardingState; projects: ProjectMeta[] | null
  onConfirm: (selection: { mode: 'create' | 'join'; name: string; projectId: string }) => void
  onDraft?: (selection: { mode: 'create' | 'join'; name: string; projectId: string }) => void
  onDismiss: () => void; onOpen: () => void
}) {
  const [mode, setMode] = useState(state.mode)
  const [name, setName] = useState(state.name)
  const [projectId, setProjectId] = useState(state.projectId)
  const editing = state.phase === 'confirm' || state.phase === 'error'
  const saved = Boolean(state.receipt), done = state.phase === 'done'
  const selected = projects?.find(p => p.projectId === projectId)
  const title=done ? state.mode === 'create' ? '项目已创建' : '已加入项目'
    : editing ? mode === 'create' ? '创建一个项目' : '加入一个项目'
    : state.phase === 'binding' ? '正在加入项目…' : state.phase === 'saving' ? '正在保存…' : '正在整理…'
  const draft=(next: {mode: 'create' | 'join'; name: string; projectId: string}) => {
    setMode(next.mode); setName(next.name); setProjectId(next.projectId); onDraft?.(next)
  }
  const choose=(next: 'create' | 'join') => draft({mode:next,name,projectId})
  return <article className={`approval-card user-input-card project-onboarding-card phase-${state.phase}`} aria-label="新建或加入项目">
    <div className="approval-icon user-input-icon" aria-hidden>{done ? <Check size={17}/> : editing ? <CircleHelp size={17}/> : <LoaderCircle size={17} className="spin"/>}</div>
    <div className="approval-content user-input-content">
      <div className="user-input-card-head">
        <div className="user-input-question-title"><h3>{title}</h3></div>
        {(done || (editing && !saved)) && <div className="user-input-question-nav"><button type="button" title="取消" onClick={onDismiss} aria-label="取消项目申请"><X size={14}/></button></div>}
      </div>
      {editing && <form onSubmit={event => {event.preventDefault(); if (saved || (mode === 'create' ? name.trim() : selected)) onConfirm({mode,name:mode === 'join' ? selected?.name ?? name : name,projectId})}}>
        {!saved && <fieldset className="user-input-question" aria-label="项目操作">
          <div className="user-input-options">
            <div className={`user-input-option user-input-other project-onboarding-option${mode === 'create' ? ' selected' : ''}`} onClick={event => {if (event.target === event.currentTarget) choose('create')}}>
              <input id={`${state.id}-create`} type="radio" name={`${state.id}-mode`} checked={mode === 'create'} onChange={() => choose('create')}/>
              <label className="user-input-other-label" htmlFor={`${state.id}-create`}>新建项目</label>
              <input className="user-input-other-field" aria-label="项目名称" placeholder="项目名称" value={name} onFocus={() => choose('create')}
                onChange={event => draft({mode:'create',name:event.target.value,projectId})}/>
            </div>
            <div className={`user-input-option user-input-other project-onboarding-option${mode === 'join' ? ' selected' : ''}`} onClick={event => {if (event.target === event.currentTarget) choose('join')}}>
              <input id={`${state.id}-join`} type="radio" name={`${state.id}-mode`} checked={mode === 'join'} onChange={() => choose('join')}/>
              <label className="user-input-other-label" htmlFor={`${state.id}-join`}>加入已有项目</label>
              <select className="user-input-other-field" aria-label="已有项目" value={projectId} onFocus={() => choose('join')}
                onChange={event => draft({mode:'join',name,projectId:event.target.value})} disabled={projects === null}>
                <option value="">{projects === null ? '读取中…' : '选择项目'}</option>
                {projects?.map(p => <option key={p.projectId} value={p.projectId}>{p.name}</option>)}
              </select>
            </div>
          </div>
        </fieldset>}
        {state.error && <p role="alert">{state.error}</p>}
        <div className="approval-actions user-input-actions project-onboarding-actions">
          <button type="submit" className="approve" disabled={!saved && (mode === 'create' ? !name.trim() : !selected)}>确认</button>
        </div>
      </form>}
      {done && <><p className="user-input-unavailable">{state.name}</p><div className="approval-actions user-input-actions project-onboarding-actions"><button type="button" className="approve" onClick={onOpen}>查看</button></div></>}
      {!editing && !done && state.chunks && state.chunks > 1 && <p className="user-input-unavailable">{Math.min((state.completedChunks ?? 0)+1,state.chunks)} / {state.chunks}</p>}
    </div>
  </article>
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
    onDraft={selection => service.updateDraft(card.source.threadId,selection)}
    onConfirm={selection => { void service.confirm(card.source.threadId, selection, settings) }}
    onDismiss={() => service.dismiss(card.source.threadId)} onOpen={() => archiveStore.requestSelect(card.receipt!.projectId)} />
}
export function OnboardingButton({ service, docs, threadId, disabled, instanceId }: {
  service: ProjectOnboardingService; docs: ProjectDocService; threadId: string | null; disabled: boolean; instanceId: string
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
      onClick={() => { setError(''); void service.request(threadId,{instanceId}).catch(e => setError(String(e))) }}><FolderPlus size={15} /></button>
    {error && <span role="alert" className="project-archive-error">{error}</span>}
  </span>
}

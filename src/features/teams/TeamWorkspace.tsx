import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react'
import { ArrowLeft, Bot, Check, ChevronRight, ClipboardList, FolderOpen, Pause, Play, Plus, RefreshCw, Square, Users, X } from 'lucide-react'
import type { ConversationTabProps, TurnActionProps } from '../../extensions/types'
import { DEFAULT_TASK_LIMITS, type AgentMember, type AgentTeam, type TaskLimits, type TeamsService, type TeamStep, type TeamTask } from '../../core/teams/types'
import type { CodexSkill } from '../../core/domain/codex'
import { Markdown } from '../markdown/Markdown'
import './teams.css'

const statusLabels = { draft: '待执行', running: '执行中', paused: '已暂停', review: '待验收', done: '已完成', stopped: '已停止' }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const newMember = (): AgentMember => ({ id: crypto.randomUUID(), name: '', description: '', instructions: '', provider: 'codex', model: '', effort: '', skills: [], access: 'isolated-delivery', archived: false })

function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const perform = async (job: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true); setError('')
    try { await job() } catch (error) { setError(errorText(error)) } finally { setBusy(false) }
  }
  return { busy, error, perform }
}
function ErrorLine({ text }: { text: string | null }) { return text ? <p className="team-error" role="alert">{text}</p> : null }
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="team-field"><span>{label}</span>{children}</label> }
function Modal({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const dialog = useRef<HTMLElement>(null)
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const element = dialog.current
    element?.focus()
    const handler = (event: KeyboardEvent) => {
      if ([...document.querySelectorAll('[role="dialog"]')].at(-1) !== element) return
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return }
      if (event.key !== 'Tab') return
      const controls = [...element!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')]
        .filter((node) => node.offsetParent !== null)
      if (!controls.length) { event.preventDefault(); return }
      const first = controls[0], last = controls.at(-1)!
      if (event.shiftKey && (document.activeElement === first || document.activeElement === element)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === element)) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', handler)
    return () => { document.removeEventListener('keydown', handler); previous?.focus() }
  }, [])
  return <div className="team-modal-backdrop"><section ref={dialog} tabIndex={-1} className="team-modal team-workspace" role="dialog" aria-modal="true" aria-label={title}
    onKeyDownCapture={(e) => { if (e.key === 'Enter' && (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)) { e.preventDefault(); e.stopPropagation() } }}>
    <header><h2>{title}</h2><button type="button" aria-label="关闭" onClick={close}><X size={17} /></button></header>{children}
  </section></div>
}

export function TeamWorkspace({ service, context }: { service: TeamsService; context: ConversationTabProps }) {
  const snapshot = useSyncExternalStore(service.subscribe, service.snapshot)
  const [page, setPage] = useState<'tasks' | 'members' | 'teams'>('tasks')
  const [selected, setSelected] = useState<string | null>(null)
  const [member, setMember] = useState<AgentMember | null>(null)
  const [team, setTeam] = useState<AgentTeam | null>(null)
  const [creatingTask, setCreatingTask] = useState(false)
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const action = useAction()
  const { state } = snapshot
  const task = state.tasks.find((t) => t.id === selected)
  const cwd = context.threadCwd ?? context.workspaceRoot ?? ''
  const tasks = state.tasks.filter((t) => (filter === 'all' || t.status === filter) && `${t.title} ${t.brief}`.toLowerCase().includes(query.toLowerCase()))
  const navigate = (next: typeof page) => { setPage(next); setSelected(null) }
  return <div className="team-workspace">
    <header className="team-header"><div><span className="team-eyebrow">HARNESS / COLLABORATION</span><h2>把工作交给合适的成员</h2><p>直接指派，或让队长组织协作。结果由你验收。</p></div>
      <div className="team-actions"><button aria-label="刷新团队" onClick={() => void action.perform(() => service.refresh())} disabled={action.busy}><RefreshCw size={15} /></button><button className="primary" onClick={() => setCreatingTask(true)} disabled={!state.members.some((m) => !m.archived)}><Plus size={15} />新任务</button></div>
    </header>
    <nav className="team-nav" aria-label="团队导航">
      <button className={page === 'tasks' ? 'selected' : ''} onClick={() => navigate('tasks')}><ClipboardList size={15} />任务 <b>{state.tasks.filter((t) => !['done', 'stopped'].includes(t.status)).length}</b></button>
      <button className={page === 'members' ? 'selected' : ''} onClick={() => navigate('members')}><Bot size={15} />成员 <b>{state.members.filter((m) => !m.archived).length}</b></button>
      <button className={page === 'teams' ? 'selected' : ''} onClick={() => navigate('teams')}><Users size={15} />团队 <b>{state.teams.filter((t) => !t.archived).length}</b></button>
    </nav>
    <ErrorLine text={snapshot.error ?? action.error} />
    {snapshot.loading ? <p className="team-empty">正在读取团队…</p> : page === 'tasks' ? <>
      <div className="team-toolbar"><input aria-label="搜索任务" placeholder="搜索任务" value={query} onChange={(e) => setQuery(e.target.value)} /><select aria-label="任务状态" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">全部状态</option>{Object.entries(statusLabels).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></div>
      <div className={`team-task-layout${task ? ' with-detail' : ''}`}><div className="team-task-list">
        {!tasks.length && <div className="team-empty"><ClipboardList size={30} /><h3>{state.members.length ? '从一项具体工作开始' : '先创建你的第一名成员'}</h3><p>给出目标、上下文和验收要求，执行记录会保留在这里。</p><button onClick={() => state.members.length ? setCreatingTask(true) : setMember(newMember())}><Plus size={14} />{state.members.length ? '创建任务' : '创建成员'}</button></div>}
        {tasks.map((t) => <button key={t.id} className={`team-task-row${t.id === selected ? ' selected' : ''}`} onClick={() => setSelected(t.id)}><span className={`team-status-dot ${t.status}`} /><span><strong>{t.title}</strong><small>{t.team?.name ?? t.members[0]?.name} · {t.workspaceRoot.split('/').at(-1)} · {t.steps.length} 次执行</small></span><span className={`team-badge ${t.status}`}>{statusLabels[t.status]}</span><ChevronRight size={14} /></button>)}
      </div>{task && <TaskDetail key={task.id} task={task} service={service} close={() => setSelected(null)} />}</div>
    </> : page === 'members' ? <div className="team-content"><div className="team-section-title"><p>职责决定工作方式；记忆保留可复用的经验。</p><button onClick={() => setMember(newMember())}><Plus size={15} />创建成员</button></div>
      <div className="team-member-grid">{state.members.map((m) => <button className={`team-member-card${m.archived ? ' archived' : ''}`} key={m.id} onClick={() => setMember(structuredClone(m))}><span className="team-avatar">{m.name.slice(0, 1)}</span><strong>{m.name}</strong><p>{m.description || '尚未填写简介'}</p><footer><span>{m.provider} · {m.model || '默认模型'}</span><span>{m.archived ? '已归档' : m.access === 'read-only' ? '只读' : '隔离开发'}</span></footer></button>)}</div>
      {!state.members.length && <p className="team-empty">例如：开发成员负责实现，审查成员负责检查，队长负责分工与验收。</p>}
    </div> : <div className="team-content"><div className="team-section-title"><p>同一成员可以加入多个团队。队长按任务选择执行者。</p><button disabled={state.members.filter((m) => !m.archived).length < 2} onClick={() => setTeam({ id: crypto.randomUUID(), name: '', leaderId: '', memberIds: [], instructions: '', archived: false })}><Plus size={15} />创建团队</button></div>
      {!state.teams.length && <p className="team-empty">创建至少两名成员，再选择队长并组建团队。</p>}
      {state.teams.map((t) => <button className="team-team-row" key={t.id} onClick={() => setTeam(structuredClone(t))}><Users size={22} /><span><strong>{t.name}{t.archived ? ' · 已归档' : ''}</strong><small>队长：{state.members.find((m) => m.id === t.leaderId)?.name} · {t.memberIds.length} 名成员</small></span><ChevronRight size={15} /></button>)}
    </div>}
    {member && <Modal title={state.members.some((m) => m.id === member.id) ? '成员详情' : '创建成员'} close={() => setMember(null)}><MemberEditor member={member} service={service} cwd={cwd} saved={() => setMember(null)} /></Modal>}
    {team && <Modal title="团队配置" close={() => setTeam(null)}><TeamEditor team={team} service={service} saved={() => setTeam(null)} /></Modal>}
    {creatingTask && <Modal title="创建任务" close={() => setCreatingTask(false)}><TaskForm service={service} cwd={cwd} threadId={context.threadId} created={(id) => { setCreatingTask(false); setPage('tasks'); setSelected(id) }} /></Modal>}
  </div>
}

function MemberEditor({ member, service, cwd, saved }: { member: AgentMember; service: TeamsService; cwd: string; saved: () => void }) {
  const [draft, setDraft] = useState(member)
  const [section, setSection] = useState<'profile' | 'memory'>('profile')
  const [models, setModels] = useState<Awaited<ReturnType<TeamsService['models']>>>([])
  const [skills, setSkills] = useState<CodexSkill[]>([])
  const [loadError, setLoadError] = useState('')
  const action = useAction()
  useEffect(() => { let active = true; service.models().then((m) => { if (active) setModels(m) }).catch((e) => { if (active) setLoadError(errorText(e)) }); return () => { active = false } }, [service])
  const patch = (value: Partial<AgentMember>) => setDraft((old) => ({ ...old, ...value }))
  const submit = (e: FormEvent) => { e.preventDefault(); void action.perform(async () => { await service.saveMember(draft); saved() }) }
  return <><nav className="team-subnav"><button className={section === 'profile' ? 'selected' : ''} onClick={() => setSection('profile')}>职责与配置</button><button className={section === 'memory' ? 'selected' : ''} onClick={() => setSection('memory')}>成员记忆</button></nav>
    {section === 'memory' ? <MemoryEditor memberId={member.id} service={service} cwd={cwd} /> : <form className="team-form" onSubmit={submit}>
      <div className="team-form-pair"><Field label="成员名称"><input autoFocus required maxLength={80} value={draft.name} onChange={(e) => patch({ name: e.target.value })} /></Field><Field label="Provider"><select value={draft.provider} onChange={(e) => patch({ provider: e.target.value as AgentMember['provider'], model: '', effort: '', skills: [] })}><option value="codex">Codex</option><option value="claude">Claude</option></select></Field></div>
      <Field label="简介 · 用于选择成员"><input value={draft.description} maxLength={500} onChange={(e) => patch({ description: e.target.value })} placeholder="例如：负责 React 实现与测试" /></Field>
      <Field label="职责指令 · 每次执行都会提供"><textarea required rows={7} maxLength={16000} value={draft.instructions} onChange={(e) => patch({ instructions: e.target.value })} placeholder="负责什么、如何工作、交付要求，以及遇到什么情况应停止。" /></Field>
      <div className="team-form-pair"><Field label="模型"><select value={draft.model} onChange={(e) => patch({ model: e.target.value, effort: '' })}><option value="">使用 Provider 默认模型</option>{models.filter((m) => m.provider === draft.provider).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}{draft.model && !models.some((m) => m.id === draft.model) && <option value={draft.model}>{draft.model}</option>}</select></Field><Field label="推理强度"><select value={draft.effort} onChange={(e) => patch({ effort: e.target.value })}><option value="">模型默认</option>{(models.find((m) => m.id === draft.model && m.provider === draft.provider)?.efforts ?? []).map((value) => <option key={value}>{value}</option>)}</select></Field></div>
      <Field label="工作区方式"><select value={draft.access} onChange={(e) => patch({ access: e.target.value as AgentMember['access'] })}><option value="isolated-delivery">隔离开发 · 为任务创建 worktree</option><option value="read-only">只读 · 分析、协调、审查</option></select></Field>
      {draft.provider === 'codex' && <fieldset><legend>明确选用的 Skills</legend><button type="button" disabled={!cwd || action.busy} onClick={() => void action.perform(async () => setSkills(await service.skills(cwd)))}>读取当前工作区 Skills</button>{draft.skills.filter((s) => !skills.some((a) => a.path === s.path)).map((s) => <label className="team-check" key={s.path}><input type="checkbox" checked onChange={() => patch({ skills: draft.skills.filter((a) => a.path !== s.path) })} />{s.name}</label>)}{skills.map((s) => <label className="team-check" key={s.path}><input type="checkbox" checked={draft.skills.some((a) => a.path === s.path)} onChange={(e) => patch({ skills: e.target.checked ? [...draft.skills, { name: s.name, path: s.path }] : draft.skills.filter((a) => a.path !== s.path) })} />{s.name}</label>)}</fieldset>}
      <p className="team-help">MCP 沿用共享运行时配置。选择 Skill 不会修改全局启停或授予额外权限。已有任务保留创建时的成员配置。</p>
      <label className="team-check"><input type="checkbox" checked={draft.archived} onChange={(e) => patch({ archived: e.target.checked })} />归档成员（保留记忆和已有任务，停止新任务指派）</label>
      <ErrorLine text={action.error || loadError} /><footer><button type="submit" className="primary" disabled={action.busy}>{action.busy ? '保存中…' : '保存成员'}</button></footer>
    </form>}
  </>
}

function MemoryEditor({ memberId, service, cwd }: { memberId: string; service: TeamsService; cwd: string }) {
  const [scope, setScope] = useState(cwd ? 'workspace' : 'global')
  const workspace = scope === 'workspace' ? cwd : undefined
  const [text, setText] = useState('')
  const [revision, setRevision] = useState<number | null>(null)
  const [saved, setSaved] = useState(false)
  const action = useAction()
  useEffect(() => { let active = true; void action.perform(async () => { const doc = await service.readMemory(memberId, workspace); if (active) { setText(doc.content); setRevision(doc.revision) } }); return () => { active = false } }, [memberId, service, workspace])
  return <div className="team-form"><Field label="记忆范围"><select value={scope} onChange={(e) => { setRevision(null); setSaved(false); setScope(e.target.value) }}><option value="global">成员通用经验 · 跨工作区</option>{cwd && <option value="workspace">当前工作区 · {cwd}</option>}</select></Field><p className="team-help">执行时只读取成员通用经验与来源工作区经验。职责在另一个页签维护，保存会覆盖当前范围的内容。</p><Field label="经验 Markdown"><textarea rows={16} maxLength={32000} disabled={revision === null} value={text} onChange={(e) => { setText(e.target.value); setSaved(false) }} /></Field><ErrorLine text={action.error} />{saved && <p role="status">记忆已保存，下次执行生效。</p>}<footer><button className="primary" disabled={action.busy || revision === null} onClick={() => void action.perform(async () => { const doc = await service.saveMemory(memberId, revision!, text, workspace); setRevision(doc.revision); setSaved(true) })}>保存记忆</button></footer></div>
}

function TeamEditor({ team, service, saved }: { team: AgentTeam; service: TeamsService; saved: () => void }) {
  const { state } = useSyncExternalStore(service.subscribe, service.snapshot)
  const [draft, setDraft] = useState(team)
  const action = useAction()
  const members = state.members.filter((m) => !m.archived)
  return <form className="team-form" onSubmit={(e) => { e.preventDefault(); void action.perform(async () => { await service.saveTeam(draft); saved() }) }}>
    <Field label="团队名称"><input autoFocus required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field><Field label="队长"><select required value={draft.leaderId} onChange={(e) => setDraft({ ...draft, leaderId: e.target.value })}><option value="">选择队长</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
    <fieldset><legend>成员</legend>{members.map((m) => <label className="team-check" key={m.id}><input type="checkbox" disabled={m.id === draft.leaderId} checked={m.id === draft.leaderId || draft.memberIds.includes(m.id)} onChange={(e) => setDraft({ ...draft, memberIds: e.target.checked ? [...draft.memberIds, m.id] : draft.memberIds.filter((id) => id !== m.id) })} />{m.name}<small>{m.description}</small></label>)}</fieldset>
    <Field label="团队协作要求"><textarea rows={5} value={draft.instructions} onChange={(e) => setDraft({ ...draft, instructions: e.target.value })} placeholder="例如：开发完成后交给审查成员检查；测试失败时先修复再提交验收。" /></Field>
    <p className="team-help">队长只负责分工和验收。一次派给一名成员，成员完成后再决定下一步，最终由你验收。</p><label className="team-check"><input type="checkbox" checked={draft.archived} onChange={(e) => setDraft({ ...draft, archived: e.target.checked })} />归档团队</label><ErrorLine text={action.error} /><footer><button className="primary" disabled={action.busy}>保存团队</button></footer>
  </form>
}

function LimitsEditor({ value, change }: { value: TaskLimits; change: (limits: TaskLimits) => void }) {
  return <div className="team-limits">{([['maxRuns', '执行次数', 1, 100], ['maxReworks', '返工次数', 0, 20], ['maxMinutes', '时间预算（分钟）', 1, 1440]] as const).map(([key, label, min, max]) => <Field key={key} label={label}><input required type="number" min={min} max={max} value={value[key]} onChange={(e) => change({ ...value, [key]: Number(e.target.value) })} /></Field>)}</div>
}
function TaskForm({ service, cwd, threadId, initialBrief = '', created }: { service: TeamsService; cwd: string; threadId: string | null; initialBrief?: string; created: (id: string) => void }) {
  const { state } = useSyncExternalStore(service.subscribe, service.snapshot)
  const [title, setTitle] = useState('')
  const [brief, setBrief] = useState(initialBrief)
  const [root, setRoot] = useState(cwd)
  const [target, setTarget] = useState('')
  const [limits, setLimits] = useState(DEFAULT_TASK_LIMITS)
  const action = useAction()
  return <form className="team-form" onSubmit={(e) => { e.preventDefault(); void action.perform(async () => { const [kind, id] = target.split(':'); const taskId = await service.createTask({ title, brief, workspaceRoot: root, parentThreadId: threadId, target: { kind: kind as 'member' | 'team', id }, limits }); created(taskId) }) }}>
    <Field label="任务标题"><input autoFocus required maxLength={160} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="要交付什么？" /></Field>
    <Field label="交给谁"><select required value={target} onChange={(e) => setTarget(e.target.value)}><option value="">选择成员或团队</option><optgroup label="直接指派成员">{state.members.filter((m) => !m.archived).map((m) => <option key={m.id} value={`member:${m.id}`}>{m.name}</option>)}</optgroup><optgroup label="由队长组织协作">{state.teams.filter((t) => !t.archived).map((t) => <option key={t.id} value={`team:${t.id}`}>{t.name}</option>)}</optgroup></select></Field>
    <Field label="工作区"><input required value={root} onChange={(e) => setRoot(e.target.value)} /></Field><Field label="任务说明与验收要求"><textarea required rows={9} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="写清目标、必要背景、相关文件、限制和验收标准。成员不会自动继承来源会话。" /></Field>
    <LimitsEditor value={limits} change={setLimits} /><p className="team-help">预算统计队长与成员的执行总次数和时间窗口，不是 Token 或费用上限。创建后点击启动才会产生模型请求。</p><ErrorLine text={action.error} /><footer><button className="primary" disabled={action.busy}>创建任务</button></footer>
  </form>
}

function TaskDetail({ task, service, close }: { task: TeamTask; service: TeamsService; close: () => void }) {
  const runs = useSyncExternalStore(service.runs.subscribe, service.runs.snapshot)
  const action = useAction()
  const [feedback, setFeedback] = useState('')
  const [limits, setLimits] = useState(task.limits)
  const [showBudget, setShowBudget] = useState(false)
  const [result, setResult] = useState<{ step: TeamStep; text: string } | null>(null)
  const [memoryDraft, setMemoryDraft] = useState<{ memberId: string; revision: number; text: string } | null>(null)
  return <aside className="team-detail"><header><button aria-label="关闭任务详情" onClick={close}><ArrowLeft size={16} /></button><span className={`team-badge ${task.status}`}>{statusLabels[task.status]}</span><h3>{task.title}</h3></header>
    <div className="team-detail-body"><div className="team-actions">
      {(['draft', 'paused'].includes(task.status) || (task.status === 'running' && !service.isCoordinating(task.id))) && <button disabled={action.busy} onClick={() => void action.perform(() => service.startTask(task.id))}><Play size={14} />{task.status === 'running' ? '接管调度' : '启动 / 继续'}</button>}
      {task.status === 'running' && <button disabled={action.busy} onClick={() => void action.perform(() => service.pauseTask(task.id))}><Pause size={14} />暂停</button>}
      {!['done', 'stopped'].includes(task.status) && <button disabled={action.busy} onClick={() => void action.perform(() => service.stopTask(task.id))}><Square size={13} />停止</button>}
      {task.status === 'review' && <button className="primary" disabled={action.busy} onClick={() => void action.perform(() => service.approveTask(task.id))}><Check size={14} />验收通过</button>}
    </div><ErrorLine text={action.error} />{task.note && <p className="team-task-note">{task.note}</p>}{task.status === 'running' && !service.isCoordinating(task.id) && <p className="team-help">该任务由之前的应用实例或其他窗口启动。先检查当前执行；结束后可接管调度。</p>}
    <dl className="team-facts"><dt>负责人</dt><dd>{task.team?.name ?? task.members[0]?.name}</dd><dt>执行预算</dt><dd>{task.steps.length} / {task.limits.maxRuns} 次 · 返工 {task.reworks} / {task.limits.maxReworks} 次</dd><dt>时间窗口</dt><dd>{task.limits.maxMinutes} 分钟{task.deadline ? ` · 截止 ${new Date(task.deadline).toLocaleTimeString()}` : ''}</dd><dt>工作目录</dt><dd>{task.executionRoot ?? task.workspaceRoot}</dd></dl>
    {!['running', 'done', 'stopped'].includes(task.status) && <><button className="team-link" onClick={() => setShowBudget(!showBudget)}>调整预算</button>{showBudget && <div className="team-budget-edit"><LimitsEditor value={limits} change={setLimits} /><button disabled={action.busy} onClick={() => void action.perform(async () => { await service.extendLimits(task.id, limits); setShowBudget(false) })}>保存预算并重新计时</button></div>}</>}
    <details><summary>任务说明与验收要求</summary><Markdown text={task.brief} /></details>
    {task.status === 'review' && <div className="team-review"><Field label="返工意见"><textarea rows={3} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="指出未满足的验收要求" /></Field><button disabled={action.busy || !feedback.trim()} onClick={() => void action.perform(() => service.reworkTask(task.id, feedback))}>保存返工意见</button></div>}
    <h4>执行记录 <small>{task.steps.length}</small></h4>
    {!task.steps.length && <p className="team-help">启动后显示队长和成员的每一次执行。</p>}
    <ol className="team-timeline">{task.steps.map((step, index) => { const run = runs.find((r) => r.runId === step.id); return <li key={step.id}><span className="team-step-number">{index + 1}</span><div><strong>{step.member.name}</strong><span className="team-step-meta">{step.role === 'leader' ? '协调' : '执行'} · {run?.status ?? '待确认'}</span><p>{step.instruction}</p><div className="team-actions"><button disabled={!run?.childThreadId} onClick={() => run?.childThreadId && service.runs.openThread(run.childThreadId)}>查看会话</button><button disabled={action.busy || run?.status !== 'completed'} onClick={() => void action.perform(async () => setResult({ step, text: await service.result(step) }))}>查看结果 / 保存经验</button>{run?.workspaceAccess === 'isolated-delivery' && <button onClick={() => void action.perform(() => service.runs.openWorkspace(run.runId))}><FolderOpen size={13} />工作区</button>}</div></div></li> })}</ol>
    </div>
    {result && <Modal title={`${result.step.member.name} · 执行结果`} close={() => { setResult(null); setMemoryDraft(null) }}><div className="team-form">{memoryDraft ? <><Field label="编辑成员经验 · 保存前请删去临时状态与无关内容"><textarea rows={16} value={memoryDraft.text} maxLength={32000} onChange={(e) => setMemoryDraft({ ...memoryDraft, text: e.target.value })} /></Field><button className="primary" disabled={action.busy} onClick={() => void action.perform(async () => { await service.saveMemory(memoryDraft.memberId, memoryDraft.revision, memoryDraft.text, task.workspaceRoot); setMemoryDraft(null); setResult(null) })}>确认保存到成员记忆</button></> : <><div className="team-result"><Markdown text={result.text} /></div><button disabled={action.busy} onClick={() => void action.perform(async () => { const doc = await service.readMemory(result.step.member.id, task.workspaceRoot); setMemoryDraft({ memberId: result.step.member.id, revision: doc.revision, text: doc.content + `\n\n## ${task.title}\n\n来源任务：${task.id}\n来源执行：${result.step.runId}\n适用工作区：${task.workspaceRoot}\n时间：${new Date().toISOString()}\n\n${result.text}` }) })}>编辑后保存为成员经验</button></>}<ErrorLine text={action.error} /></div></Modal>}
  </aside>
}

export function AssignAction({ service, context }: { service: TeamsService; context: TurnActionProps }) {
  const [open, setOpen] = useState(false)
  const [created, setCreated] = useState<string | null>(null)
  const action = useAction()
  const brief = context.items.filter((entry) => entry.turnId === context.turnId && entry.item.type === 'agentMessage').map((entry) => entry.item.text ?? '').join('\n\n')
  return <><button type="button" disabled={context.disabled} title="把这条回复作为任务说明，交给成员或团队" onClick={() => { setCreated(null); setOpen(true) }}><Users size={13} /></button>{open && <Modal title="交给成员或团队" close={() => setOpen(false)}>{created ? <div className="team-form"><p>任务已创建。启动后可在「团队」页查看进展。</p><ErrorLine text={action.error} /><button className="primary" disabled={action.busy} onClick={() => void action.perform(async () => { await service.startTask(created); setOpen(false) })}>启动任务</button></div> : <TaskForm service={service} cwd={context.checkoutRoot ?? ''} threadId={context.threadId} initialBrief={brief} created={setCreated} />}</Modal>}</>
}

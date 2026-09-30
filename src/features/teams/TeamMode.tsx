import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { ArrowLeft, Bell, Bot, CheckCircle2, Circle, CircleDot, ClipboardList, Clock3, Plus, Search, Settings2, Users } from 'lucide-react'
import type { Workspace } from '../../core/domain/codex'
import type { AgentMember, AgentTeam, TeamsService, TeamTask } from '../../core/teams/types'
import { activeRun } from '../../core/teams/types'
import { MemberEditor, TaskDetail, TaskForm, TeamEditor } from './TeamWorkspace'
import './TeamMode.css'

type Page = 'tasks' | 'members' | 'teams'
type Selection = { kind: 'task'; id: string } | { kind: 'member'; member: AgentMember } | { kind: 'team'; team: AgentTeam } | { kind: 'new-task'; target: string } | null
const labels: Record<TeamTask['status'], string> = { draft: '待执行', running: '执行中', paused: '已暂停', review: '待验收', done: '已完成', stopped: '已停止' }
const pages = { tasks: '任务', members: '成员', teams: '团队设置' }
const freshMember = (): AgentMember => ({ id: crypto.randomUUID(), name: '', description: '', instructions: '', provider: 'codex', model: '', effort: '', skills: [], access: 'isolated-delivery', archived: false })

interface Props {
  service: TeamsService
  workspaces: Workspace[]
  initialWorkspace: string | null
  onOpenConversation(threadId: string): void
  onSettings(): void
  onNotifications(): void
  unreadNotifications: number
}

/** A core application surface. The plugin tab is only an alternative view of the same service. */
export function TeamMode({ service, workspaces, initialWorkspace, onOpenConversation, onSettings, onNotifications, unreadNotifications }: Props) {
  const { state, loading, error } = useSyncExternalStore(service.subscribe, service.snapshot)
  const runs = useSyncExternalStore(service.runs.subscribe, service.runs.snapshot)
  const [page, setPage] = useState<Page>('tasks')
  const [teamId, setTeamId] = useState('all')
  const [workspaceRoot, setWorkspaceRoot] = useState(initialWorkspace ?? workspaces[0]?.root ?? '')
  const [selection, setSelection] = useState<Selection>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('active')
  const [saveError, setSaveError] = useState('')
  const selectedTeam = state.teams.find((t) => t.id === teamId)
  const task = selection?.kind === 'task' ? state.tasks.find((t) => t.id === selection.id) : undefined
  const workspaceChoices = [...new Set([...workspaces.map((w) => w.root), ...(initialWorkspace ? [initialWorkspace] : []), ...(workspaceRoot ? [workspaceRoot] : [])])]
  const cwd = workspaceRoot || initialWorkspace || workspaces[0]?.root || ''
  const scopedTasks = state.tasks.filter((t) => (!workspaceRoot || t.workspaceRoot === workspaceRoot) && (teamId === 'all' || (teamId === 'direct' ? t.target.kind === 'member' : t.team?.id === teamId)))
  const shownTasks = scopedTasks.filter((t) => (status === 'all' || (status === 'active' ? !['done', 'stopped'].includes(t.status) : t.status === status)) && `${t.title} ${t.team?.name ?? t.members[0]?.name}`.toLowerCase().includes(query.toLowerCase()))
  const roster = state.members.filter((m) => !selectedTeam || selectedTeam.memberIds.includes(m.id))
  const runningMembers = useMemo(() => {
    const activeIds = new Set(runs.filter(activeRun).map((r) => r.runId))
    return new Set(state.tasks.flatMap((t) => t.steps.filter((s) => activeIds.has(s.id)).map((s) => s.member.id)))
  }, [runs, state.tasks])
  // If a previously selected team was removed externally, return to the shared task view.
  useEffect(() => { if (!['all', 'direct'].includes(teamId) && !selectedTeam) setTeamId('all') }, [teamId, selectedTeam])
  const navigate = (next: Page) => { setPage(next); setSelection(null); setQuery(''); setSaveError('') }
  const createTask = (target = selectedTeam && !selectedTeam.archived ? `team:${selectedTeam.id}` : '') => { setPage('tasks'); setSelection({ kind: 'new-task', target }) }
  const refresh = () => { void service.refresh().catch((e) => setSaveError(String(e))) }
  const heading = selection?.kind === 'new-task' ? '新任务' : selection?.kind === 'member' ? selection.member.name || '新成员' : selection?.kind === 'team' ? selection.team.name || '新团队' : task?.title ?? pages[page]
  return <div className="team-mode team-workspace">
    <main className="team-mode-main" aria-label="团队工作区">
      <header className="team-mode-header">
        <div className="team-mode-breadcrumb">{selection && <button aria-label="返回列表" onClick={() => setSelection(null)}><ArrowLeft size={15} /></button>}<span>{selectedTeam?.name ?? (teamId === 'direct' ? '直接派活' : '全部团队')}</span><span>/</span><strong>{heading}</strong></div>
        {!selection && <button className="primary" disabled={page === 'tasks' && !state.members.some((m) => !m.archived)} onClick={() => page === 'tasks' ? createTask() : page === 'members' ? setSelection({ kind: 'member', member: freshMember() }) : setSelection({ kind: 'team', team: { id: crypto.randomUUID(), name: '', leaderId: '', memberIds: [], instructions: '', archived: false } })}><Plus size={14} />{page === 'tasks' ? '新任务' : page === 'members' ? '新成员' : '新团队'}</button>}
      </header>
      {(error || saveError) && <p className="team-error" role="alert">{error || saveError}</p>}
      <div className="team-mode-body">
        {loading ? <p className="team-empty">正在加载…</p> : selection?.kind === 'new-task' ? <TaskForm service={service} cwd={cwd} threadId={null} initialTarget={selection.target} created={(id) => setSelection({ kind: 'task', id })} />
          : selection?.kind === 'member' ? <MemberEditor key={selection.member.id} member={selection.member} service={service} cwd={cwd} saved={refresh} />
          : selection?.kind === 'team' ? <TeamEditor key={selection.team.id} team={selection.team} service={service} saved={refresh} />
          : task ? <TaskDetail key={task.id} task={task} service={service} onOpenConversation={onOpenConversation} />
          : page === 'tasks' ? <>
            <div className="team-mode-filters"><div className="team-mode-statuses" aria-label="筛选任务">{(['active', 'running', 'review', 'all'] as const).map((value) => <button key={value} aria-pressed={status === value} className={status === value ? 'selected' : ''} onClick={() => setStatus(value)}>{value === 'active' ? '未完成' : value === 'all' ? '全部' : labels[value]}</button>)}</div><label className="team-mode-search"><Search size={14} /><input aria-label="搜索团队任务" placeholder="搜索任务" value={query} onChange={(e) => setQuery(e.target.value)} /></label></div>
            <div className="team-mode-table" role="table" aria-label="团队任务"><div className="team-mode-table-head" role="row"><span role="columnheader">任务</span><span role="columnheader">负责人</span><span role="columnheader">状态</span><span role="columnheader">执行</span></div>
              {shownTasks.map((t) => <div role="row" key={t.id} className="team-mode-task-row"><span role="cell"><button className="team-mode-task-title" onClick={() => setSelection({ kind: 'task', id: t.id })}>{t.status === 'done' ? <CheckCircle2 size={15} /> : t.status === 'running' ? <CircleDot size={15} /> : <Circle size={15} />}<strong>{t.title}</strong></button></span><span role="cell" className="team-mode-owner">{t.team?.name ?? t.members[0]?.name}</span><span role="cell"><span className={`team-badge ${t.status}`}>{labels[t.status]}</span></span><span role="cell" className="team-mode-run-count">{t.steps.length}</span></div>)}
            </div>{!shownTasks.length && <p className="team-empty">{state.members.length ? '暂无匹配任务' : '先在右侧「成员」中创建成员'}</p>}
          </> : page === 'members' ? <div className="team-mode-roster">{roster.map((m) => <div className="team-mode-member-row" key={m.id}><button className="team-mode-member-name" onClick={() => setSelection({ kind: 'member', member: structuredClone(m) })}><span className="team-mode-avatar">{m.name.slice(0, 1)}</span><span><strong>{m.name}</strong><small>{m.description || m.provider}</small></span></button><span className="team-mode-member-status">{m.archived ? '已归档' : runningMembers.has(m.id) ? '执行中' : '空闲'}</span><button disabled={m.archived} onClick={() => createTask(`member:${m.id}`)}>派活</button></div>)}{!roster.length && <p className="team-empty">暂无成员</p>}</div>
          : <div className="team-mode-roster">{state.teams.map((t) => <button className="team-mode-team-row" key={t.id} onClick={() => setSelection({ kind: 'team', team: structuredClone(t) })}><Users size={17} /><span><strong>{t.name}</strong><small>队长 {state.members.find((m) => m.id === t.leaderId)?.name ?? '未设置'} · {t.memberIds.length} 人{t.archived ? ' · 已归档' : ''}</small></span></button>)}{!state.teams.length && <p className="team-empty">暂无团队，可先创建成员直接派活</p>}</div>}
      </div>
    </main>
    <aside className="team-mode-sidebar" aria-label="团队导航侧栏">
      <div className="team-mode-brand"><Bot size={20} /><strong>Harness</strong><span>团队</span></div>
      <label className="team-mode-picker"><span>团队</span><select aria-label="选择团队" value={teamId} onChange={(e) => { setTeamId(e.target.value); setSelection(null) }}><option value="all">全部团队</option><option value="direct">直接派活</option>{state.teams.map((t) => <option key={t.id} value={t.id}>{t.name}{t.archived ? '（归档）' : ''}</option>)}</select></label>
      <label className="team-mode-picker"><span>工作区</span><select aria-label="团队模式工作区" value={workspaceRoot} onChange={(e) => { setWorkspaceRoot(e.target.value); setSelection(null) }}><option value="">所有工作区</option>{workspaceChoices.map((root) => <option key={root} value={root}>{workspaces.find((w) => w.root === root)?.name ?? root.split('/').at(-1)}</option>)}</select></label>
      <nav className="team-mode-nav" aria-label="团队页面">{([{ id: 'tasks', icon: ClipboardList }, { id: 'members', icon: Bot }, { id: 'teams', icon: Users }] as const).map(({ id, icon: Icon }) => <button key={id} aria-current={page === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon size={16} />{pages[id]}<b>{id === 'tasks' ? scopedTasks.filter((t) => !['done', 'stopped'].includes(t.status)).length : id === 'members' ? roster.filter((m) => !m.archived).length : state.teams.filter((t) => !t.archived).length}</b></button>)}</nav>
      <section className="team-mode-activity"><h3><Clock3 size={13} />进行中</h3>{scopedTasks.filter((t) => ['running', 'review', 'paused'].includes(t.status)).slice(0, 8).map((t) => <button key={t.id} onClick={() => { setPage('tasks'); setSelection({ kind: 'task', id: t.id }) }}><span className={`team-status-dot ${t.status}`} /><span>{t.title}</span><small>{labels[t.status]}</small></button>)}{!scopedTasks.some((t) => ['running', 'review', 'paused'].includes(t.status)) && <p>暂无执行</p>}</section>
      <footer className="team-mode-footer"><button onClick={onNotifications}><Bell size={15} />通知{unreadNotifications > 0 && <b>{unreadNotifications}</b>}</button><button onClick={onSettings}><Settings2 size={15} />设置</button></footer>
    </aside>
  </div>
}

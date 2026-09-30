import { TeamTaskCollection } from './TeamTaskCollection'
import { TeamEntityDetail } from './TeamEntityDetail'
import { BrandRow } from '../navigation/BrandRow'
import type { CSSProperties } from 'react'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { ArrowLeft, Bell, Bot, ClipboardList, Plus, Search, Settings2, Users } from 'lucide-react'
import type { Workspace } from '../../core/domain/codex'
import type { AgentMember, AgentTeam, TeamsService } from '../../core/teams/types'
import { activeRun } from '../../core/teams/types'
import { MemberEditor, TaskDetail, TaskForm, TeamEditor } from './TeamWorkspace'
import './TeamMode.css'

type Page = 'tasks' | 'members' | 'teams'
type Selection = { kind: 'task'; id: string } | { kind: 'member'; member: AgentMember } | { kind: 'team'; team: AgentTeam } | { kind: 'new-task'; target: string } | null
const pages = { tasks: '任务', members: '成员', teams: '团队' }
const freshMember = (): AgentMember => ({ id: crypto.randomUUID(), name: '', description: '', instructions: '', provider: 'codex', model: '', effort: '', skills: [], access: 'isolated-delivery', archived: false })

interface Props {
  onSwitchView?: () => void
  sidebarWidth?: number
  service: TeamsService
  workspaces: Workspace[]
  initialWorkspace: string | null
  onOpenConversation(threadId: string): void
  onSettings(): void
  onNotifications(): void
  unreadNotifications: number
}

/** A core application surface. The plugin tab is only an alternative view of the same service. */
export function TeamMode({ onSwitchView, sidebarWidth = 284, service, workspaces, initialWorkspace, onOpenConversation, onSettings, onNotifications, unreadNotifications }: Props) {
  const { state, loading, error } = useSyncExternalStore(service.subscribe, service.snapshot)
  const runs = useSyncExternalStore(service.runs.subscribe, service.runs.snapshot)
  const [page, setPage] = useState<Page>('tasks')
  const [teamId, setTeamId] = useState('all')
  const [workspaceRoot, setWorkspaceRoot] = useState(initialWorkspace ?? workspaces[0]?.root ?? '')
  const [selection, setSelection] = useState<Selection>(null)
  const [query, setQuery] = useState('')
  const [archiveFilter, setArchiveFilter] = useState('active')
  const [saveError, setSaveError] = useState('')
  const selectedTeam = state.teams.find((t) => t.id === teamId)
  const task = selection?.kind === 'task' ? state.tasks.find((t) => t.id === selection.id) : undefined
  const workspaceChoices = [...new Set([...workspaces.map((w) => w.root), ...(initialWorkspace ? [initialWorkspace] : []), ...(workspaceRoot ? [workspaceRoot] : [])])]
  const cwd = workspaceRoot || initialWorkspace || workspaces[0]?.root || ''
  const scopedTasks = state.tasks.filter((t) => (!workspaceRoot || t.workspaceRoot === workspaceRoot) && (teamId === 'all' || (teamId === 'direct' ? t.target.kind === 'member' : t.team?.id === teamId)))
  const roster = state.members.filter((m) => !selectedTeam || selectedTeam.memberIds.includes(m.id))
  const matches = (item: { name: string; archived: boolean }) => (archiveFilter === 'all' || item.archived === (archiveFilter === 'archived')) && item.name.toLowerCase().includes(query.toLowerCase())
  const shownMembers = roster.filter(matches).sort((a, b) => a.name.localeCompare(b.name))
  const shownTeams = state.teams.filter(matches).sort((a, b) => a.name.localeCompare(b.name))
  const runningMembers = useMemo(() => {
    const activeIds = new Set(runs.filter(activeRun).map((r) => r.runId))
    return new Set(state.tasks.flatMap((t) => t.steps.filter((s) => activeIds.has(s.id)).map((s) => s.member.id)))
  }, [runs, state.tasks])
  // If a previously selected team was removed externally, return to the shared task view.
  useEffect(() => { if (!['all', 'direct'].includes(teamId) && !selectedTeam) setTeamId('all') }, [teamId, selectedTeam])
  const navigate = (next: Page) => { setPage(next); setSelection(null); setQuery(''); setSaveError('') }
  const createTask = (target = selectedTeam && !selectedTeam.archived ? `team:${selectedTeam.id}` : '') => { setPage('tasks'); setSelection({ kind: 'new-task', target }) }
  const refresh = () => { void service.refresh().catch((e) => setSaveError(String(e))) }
  const openTask = (id: string) => { setPage('tasks'); setSelection({ kind: 'task', id }) }
  const heading = selection?.kind === 'new-task' ? '新任务' : selection?.kind === 'member' ? state.members.find((m) => m.id === selection.member.id)?.name || selection.member.name || '新成员' : selection?.kind === 'team' ? state.teams.find((t) => t.id === selection.team.id)?.name || selection.team.name || '新团队' : task?.title ?? pages[page]
  return <div className="team-mode" style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
    <aside className="sidebar team-mode-sidebar" aria-label="团队导航侧栏">
      <BrandRow view="team" onSwitchView={onSwitchView} />
      <div className="new-chat-split"><button className="new-chat-button solo" disabled={!state.members.some((m) => !m.archived)} onClick={() => createTask()}><Plus size={17} />新任务</button></div>
      <div className="team-mode-sidebar-header">
        <label className="team-mode-workspace"><span className="team-mode-workspace-icon"><Bot size={17} /></span><select aria-label="团队模式工作区" value={workspaceRoot} onChange={(e) => { setWorkspaceRoot(e.target.value); setSelection(null) }}><option value="">所有工作区</option>{workspaceChoices.map((root) => <option key={root} value={root}>{workspaces.find((w) => w.root === root)?.name ?? root.split('/').at(-1)}</option>)}</select></label>
      </div>
      <div className="team-mode-sidebar-content">
        <nav className="team-mode-nav" aria-label="团队页面">
          <section><h3 className="sidebar-section-heading">工作</h3><button className={`thread-row ${page === 'tasks' ? 'selected' : ''}`} aria-current={page === 'tasks' ? 'page' : undefined} onClick={() => navigate('tasks')}><ClipboardList size={16} />任务<b>{scopedTasks.filter((t) => !['done', 'stopped'].includes(t.status)).length}</b></button></section>
          <section><h3 className="sidebar-section-heading">AI 团队</h3>{([{ id: 'members', icon: Bot }, { id: 'teams', icon: Users }] as const).map(({ id, icon: Icon }) => <button key={id} className={`thread-row ${page === id ? 'selected' : ''}`} aria-current={page === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon size={16} />{pages[id]}<b>{id === 'members' ? roster.filter((m) => !m.archived).length : state.teams.filter((t) => !t.archived).length}</b></button>)}</section>
        </nav>
      </div>
      <footer className="sidebar-footer"><div className="notification-nav-split"><button className="notification-nav solo" onClick={onNotifications}><Bell size={16} />通知中心{unreadNotifications > 0 && <b>{unreadNotifications}</b>}</button></div><div className="settings-split"><button className="settings-toggle solo" onClick={onSettings}><Settings2 size={16} />设置</button></div></footer>
    </aside>
    <main className="main-pane team-workspace team-mode-main" aria-label="团队工作区">
      <header className="team-mode-header">
        <div className="team-mode-breadcrumb">{selection && <button aria-label="返回列表" onClick={() => setSelection(null)}><ArrowLeft size={15} /></button>}<span>{selectedTeam?.name ?? (teamId === 'direct' ? '直接派活' : '全部团队')}</span><span>/</span><strong>{heading}</strong></div>
        {!selection && page !== 'tasks' && <button className="primary" onClick={() => page === 'members' ? setSelection({ kind: 'member', member: freshMember() }) : setSelection({ kind: 'team', team: { id: crypto.randomUUID(), name: '', leaderId: '', memberIds: [], instructions: '', archived: false } })}><Plus size={14} />{page === 'members' ? '新成员' : '新团队'}</button>}
      </header>
      {(error || saveError) && <p className="team-error" role="alert">{error || saveError}</p>}
      {!selection && page !== 'teams' && <div className="team-mode-scope"><select aria-label="选择团队" value={teamId} onChange={(e) => setTeamId(e.target.value)}><option value="all">全部团队</option><option value="direct">直接派活</option>{state.teams.map((t) => <option key={t.id} value={t.id}>{t.name}{t.archived ? '（归档）' : ''}</option>)}</select><span>{page === 'tasks' ? `${scopedTasks.length} 个任务` : `${roster.length} 位成员`}</span></div>}
      {!selection && page !== 'tasks' && <div className="team-collection-toolbar team-directory-toolbar"><label className="team-mode-search"><Search size={14} /><input aria-label="搜索成员或团队" placeholder={page === 'members' ? '搜索成员' : '搜索团队'} value={query} onChange={(e) => setQuery(e.target.value)} /></label><select aria-label="归档筛选" value={archiveFilter} onChange={(e) => setArchiveFilter(e.target.value)}><option value="active">可用</option><option value="archived">已归档</option><option value="all">全部</option></select></div>}
      <div className={`team-mode-body ${selection ? 'team-mode-editing' : ''}`}>
        <div hidden={!!selection || page !== 'tasks'}><TeamTaskCollection tasks={scopedTasks} open={openTask} /></div>
        {loading ? <p className="team-empty">正在加载…</p> : selection?.kind === 'new-task' ? <TaskForm service={service} cwd={cwd} threadId={null} initialTarget={selection.target} created={(id) => setSelection({ kind: 'task', id })} />
          : selection?.kind === 'member' ? (state.members.some((m) => m.id === selection.member.id) ? <TeamEntityDetail key={selection.member.id} kind="member" entity={selection.member} service={service} cwd={cwd} saved={refresh} assign={createTask} openTask={openTask} /> : <MemberEditor key={selection.member.id} member={selection.member} service={service} cwd={cwd} saved={refresh} />)
          : selection?.kind === 'team' ? (state.teams.some((t) => t.id === selection.team.id) ? <TeamEntityDetail key={selection.team.id} kind="team" entity={selection.team} service={service} cwd={cwd} saved={refresh} assign={createTask} openTask={openTask} /> : <TeamEditor key={selection.team.id} team={selection.team} service={service} saved={refresh} />)
          : task ? <TaskDetail key={task.id} task={task} service={service} onOpenConversation={onOpenConversation} />
          : page === 'tasks' ? null
          : page === 'members' ? <div className="team-mode-roster">{shownMembers.map((m) => <div className="team-mode-member-row" key={m.id}><button className="team-mode-member-name" onClick={() => setSelection({ kind: 'member', member: structuredClone(m) })}><span className="team-mode-avatar">{m.name.slice(0, 1)}</span><span><strong>{m.name}</strong><small>{m.description || m.provider}</small></span></button><span className="team-mode-member-status">{m.archived ? '已归档' : runningMembers.has(m.id) ? '执行中' : '空闲'}</span><button disabled={m.archived} onClick={() => createTask(`member:${m.id}`)}>派活</button></div>)}{!shownMembers.length && <p className="team-empty">暂无成员</p>}</div>
          : <div className="team-mode-roster">{shownTeams.map((t) => <button className="team-mode-team-row" key={t.id} onClick={() => setSelection({ kind: 'team', team: structuredClone(t) })}><Users size={17} /><span><strong>{t.name}</strong><small>队长 {state.members.find((m) => m.id === t.leaderId)?.name ?? '未设置'} · {t.memberIds.length} 人{t.archived ? ' · 已归档' : ''}</small></span></button>)}{!shownTeams.length && <p className="team-empty">暂无团队，可先创建成员直接派活</p>}</div>}
      </div>
    </main>
  </div>
}

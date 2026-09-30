import { useState, useSyncExternalStore } from 'react'
import type { AgentMember, AgentTeam, TeamsService } from '../../core/teams/types'
import { MemberEditor, MemoryEditor, TeamEditor } from './TeamWorkspace'
import { TeamTaskCollection } from './TeamTaskCollection'
import { Markdown } from '../markdown/Markdown'

export function TeamEntityDetail({ entity, kind, service, cwd, saved, assign, openTask }: { entity: AgentMember | AgentTeam; kind: 'member' | 'team'; service: TeamsService; cwd: string; saved: () => void; assign: (target: string) => void; openTask: (id: string) => void }) {
  const { state } = useSyncExternalStore(service.subscribe, service.snapshot)
  const runs = useSyncExternalStore(service.runs.subscribe, service.runs.snapshot)
  const [tab, setTab] = useState<'overview' | 'tasks' | 'config' | 'memory'>('overview')
  const current = (kind === 'member' ? state.members.find((m) => m.id === entity.id) : state.teams.find((t) => t.id === entity.id)) ?? entity
  const member = kind === 'member' ? current as AgentMember : null
  const team = kind === 'team' ? current as AgentTeam : null
  const tasks = state.tasks.filter((t) => (!cwd || t.workspaceRoot === cwd) && (team ? t.team?.id === team.id : (t.target.kind === 'member' && t.target.id === entity.id) || t.steps.some((s) => s.member.id === entity.id)))
  const stepIds = new Set(tasks.flatMap((t) => t.steps.filter((s) => !member || s.member.id === member.id).map((s) => s.id)))
  const history = runs.filter((r) => stepIds.has(r.runId))
  return <div className="team-editor-page team-entity-detail">
    <header className="team-entity-heading"><span className="team-entity-avatar">{current.name.slice(0, 1)}</span><div><h2>{current.name}</h2><p>{member?.description || (team ? `队长 ${state.members.find((m) => m.id === team.leaderId)?.name ?? '未设置'} · ${team.memberIds.length} 人` : member?.provider)}</p></div><span className="team-badge">{current.archived ? '已归档' : '可用'}</span><button className="primary" disabled={current.archived} onClick={() => assign(`${kind}:${entity.id}`)}>派活</button></header>
    <nav className="team-subnav">{(['overview', 'tasks', 'config', ...(member ? ['memory' as const] : [])] as const).map((key) => <button key={key} className={tab === key ? 'selected' : ''} onClick={() => setTab(key)}>{key === 'overview' ? '概览' : key === 'tasks' ? `任务 ${tasks.length}` : key === 'config' ? '配置' : '成员记忆'}</button>)}</nav>
    <div className="team-entity-overview" hidden={tab !== 'overview'}><div className="team-entity-summary"><section><h3>工作要求</h3><Markdown text={current.instructions || '尚未填写'} /></section><section><h3>执行记录 <small>{history.length}</small></h3>{history.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 20).map((run) => { const task = tasks.find((t) => t.steps.some((s) => s.id === run.runId)); return <button className="team-history-row" key={run.runId} onClick={() => task && openTask(task.id)}><span>{run.title}</span><small>{run.status} · {new Date(run.createdAt).toLocaleString()}</small></button> })}{!history.length && <p className="team-help">暂无执行记录</p>}</section></div><aside className="team-entity-properties"><h3>{member ? '成员配置' : '团队成员'}</h3>{member ? <dl className="team-facts"><dt>Provider</dt><dd>{member.provider}</dd><dt>模型</dt><dd>{member.model || '默认模型'}</dd><dt>工作区</dt><dd>{member.access === 'read-only' ? '只读' : '隔离开发'}</dd><dt>Skills</dt><dd>{member.skills.map((s) => s.name).join('、') || '未指定'}</dd><dt>已完成</dt><dd>{tasks.filter((t) => t.status === 'done').length} 个任务</dd></dl> : team?.memberIds.map((id) => <p key={id}>{state.members.find((m) => m.id === id)?.name ?? '已移除成员'}{id === team.leaderId ? ' · 队长' : ''}</p>)}</aside></div>
    <div className="team-entity-tasks" hidden={tab !== 'tasks'}><TeamTaskCollection tasks={tasks} open={openTask} /></div>
    {member && <div className="team-memory-page" hidden={tab !== 'memory'}><MemoryEditor memberId={member.id} service={service} cwd={cwd} /></div>}
    <div className="team-memory-page" hidden={tab !== 'config'}>{member ? <MemberEditor profileOnly member={member} service={service} cwd={cwd} saved={saved} /> : <TeamEditor team={current as AgentTeam} service={service} saved={saved} />}</div>
  </div>
}

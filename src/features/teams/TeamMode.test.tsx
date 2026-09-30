// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TeamMode } from './TeamMode'
import type { AgentMember, TeamsService, TeamState } from '../../core/teams/types'
vi.mock('../markdown/Markdown', () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }))
afterEach(cleanup)
function fixture() {
  const member: AgentMember = { id: 'dev', name: '开发成员', description: '实现与测试', instructions: '完成任务', provider: 'codex', model: '', effort: '', skills: [], access: 'isolated-delivery', archived: false }
  const leader = { ...member, id: 'lead', name: '队长' }
  const team = { id: 'team', name: '交付团队', leaderId: 'lead', memberIds: ['dev', 'lead'], instructions: '', archived: false }
  const state: TeamState = { schemaVersion: 1, members: [member, leader], teams: [team], tasks: [{ id: 'task', title: '检查登录', brief: '验证登录', workspaceRoot: '/repo', executionRoot: null, parentThreadId: null, target: { kind: 'team', id: 'team' }, members: [member, leader], team, status: 'review', owner: null, limits: { maxRuns: 12, maxReworks: 2, maxMinutes: 60 }, reworks: 0, steps: [{ id: 'step', runId: 'step', member, role: 'worker', instruction: '检查登录', consumed: true, createdAt: 1 }], note: '', createdAt: 1, updatedAt: 1, deadline: null }] }
  const snapshot = { state, loading: false, error: null }
  const runs = [{ runId: 'step', childThreadId: 'child', status: 'completed' }]
  const service = { snapshot: () => snapshot, subscribe: () => () => {}, refresh: vi.fn(async () => {}), models: vi.fn(async () => []), skills: vi.fn(async () => []), createTask: vi.fn(async () => 'new-task'), startTask: vi.fn(), isCoordinating: () => false, readMemory: vi.fn(async () => ({ revision: 0, content: '' })), saveMember: vi.fn(async () => {}), runs: { snapshot: () => runs, subscribe: () => () => {}, cancel: vi.fn(), openThread: vi.fn() } } as unknown as TeamsService
  const props = { service, workspaces: [], initialWorkspace: '/repo', onOpenConversation: vi.fn(), onSettings: vi.fn(), onNotifications: vi.fn(), unreadNotifications: 0 }
  return { service, state, props }
}
it('works without a plugin host or selected conversation and creates leader assignments', async () => {
  const { props, service } = fixture(); render(<TeamMode {...props} />)
  fireEvent.change(screen.getByLabelText('选择团队'), { target: { value: 'team' } })
  fireEvent.click(screen.getByRole('button', { name: '新任务' }))
  expect((screen.getByLabelText('交给谁') as HTMLSelectElement).value).toBe('team:team')
  fireEvent.change(screen.getByLabelText('任务标题'), { target: { value: '新功能' } })
  fireEvent.change(screen.getByLabelText('任务说明与验收要求'), { target: { value: '实现新功能' } })
  fireEvent.click(screen.getByRole('button', { name: '创建任务' }))
  await waitFor(() => expect(service.createTask).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: 'team', id: 'team' }, parentThreadId: null, workspaceRoot: '/repo' })))
  expect(service.startTask).not.toHaveBeenCalled()
})
it('direct member assignment bypasses the captain without duplicating the task service', () => {
  const { props } = fixture(); render(<TeamMode {...props} />)
  fireEvent.click(within(screen.getByRole('navigation', { name: '团队页面' })).getByRole('button', { name: /成员/ }))
  const row = screen.getByText('开发成员').closest('.team-mode-member-row') as HTMLElement
  fireEvent.click(within(row).getByRole('button', { name: '派活' }))
  expect((screen.getByLabelText('交给谁') as HTMLSelectElement).value).toBe('member:dev')
})
it('opens the exact child conversation through the core navigation callback', () => {
  const { props, service } = fixture(); render(<TeamMode {...props} />)
  fireEvent.click(within(screen.getByRole('table', { name: '团队任务' })).getByRole('button', { name: '检查登录' }))
  fireEvent.click(screen.getByRole('button', { name: '查看会话' }))
  expect(props.onOpenConversation).toHaveBeenCalledWith('child')
  expect(service.runs.openThread).not.toHaveBeenCalled()
})
it('retains an unsent task draft when the mounted core surface is hidden and shown', async () => {
  const { props, service } = fixture()
  const view = render(<div hidden={false}><TeamMode {...props} /></div>)
  fireEvent.click(screen.getByRole('button', { name: '新任务' }))
  fireEvent.change(screen.getByLabelText('任务标题'), { target: { value: '保留草稿' } })
  await act(async () => view.rerender(<div hidden><TeamMode {...props} /></div>))
  await act(async () => view.rerender(<div hidden={false}><TeamMode {...props} /></div>))
  expect((screen.getByLabelText('任务标题') as HTMLInputElement).value).toBe('保留草稿')
  expect(service.runs.cancel).not.toHaveBeenCalled()
  expect(service.startTask).not.toHaveBeenCalled()
})

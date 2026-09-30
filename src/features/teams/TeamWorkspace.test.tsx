// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AssignAction, TeamWorkspace } from './TeamWorkspace'
import type { TeamsService, TeamSnapshot, AgentMember, TeamTask } from '../../core/teams/types'
import type { ConversationTabProps } from '../../extensions/types'
vi.mock('../markdown/Markdown', () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }))
afterEach(cleanup)
const member: AgentMember = { id: 'member', name: '开发成员', description: '实现功能', instructions: '先读代码再实现', provider: 'codex', model: '', effort: '', access: 'isolated-delivery', skills: [], archived: false }
const context: ConversationTabProps = { threadId: 'origin', threadCwd: '/repo', workspaceRoot: '/repo', items: [], workspaces: [], threads: [] }
function fixture() {
  const snapshot: TeamSnapshot = { state: { schemaVersion: 1, members: [member], teams: [], tasks: [] }, loading: false, error: null }
  const service = {
    snapshot: () => snapshot, subscribe: () => () => {},
    saveMember: vi.fn(async () => {}), saveTeam: vi.fn(async () => {}),
    models: vi.fn(async () => [{ id: 'test-model', name: 'Test model', provider: 'codex', efforts: ['low'] }]),
    skills: vi.fn(async () => []), createTask: vi.fn(async () => 'task'), startTask: vi.fn(async () => {}), refresh: vi.fn(async () => {}),
    readMemory: vi.fn(async () => ({ revision: 3, content: '# 当前经验' })), saveMemory: vi.fn(async () => ({ revision: 4, content: '' })),
    runs: { subscribe: () => () => {}, snapshot: () => [] },
  } as unknown as TeamsService
  return { service, snapshot }
}
describe('team workspace', () => {
  it('creates an explicit task without starting a model request', async () => {
    const { service } = fixture(); render(<TeamWorkspace service={service} context={context} />)
    fireEvent.click(screen.getByRole('button', { name: '新任务' }))
    fireEvent.change(screen.getByLabelText('任务标题'), { target: { value: '实现登录' } })
    fireEvent.change(screen.getByLabelText('交给谁'), { target: { value: 'member:member' } })
    fireEvent.change(screen.getByLabelText('任务说明与验收要求'), { target: { value: '实现登录并补测试' } })
    fireEvent.click(within(screen.getByRole('region', { name: '详情' })).getByRole('button', { name: '创建任务' }))
    await waitFor(() => expect(service.createTask).toHaveBeenCalledWith(expect.objectContaining({ title: '实现登录', brief: '实现登录并补测试', workspaceRoot: '/repo', parentThreadId: 'origin', target: { kind: 'member', id: 'member' } })))
    expect(service.startTask).not.toHaveBeenCalled()
  })
  it('edits members and clears provider-specific settings when switching provider', async () => {
    const { service } = fixture(); render(<TeamWorkspace service={service} context={context} />)
    fireEvent.click(screen.getByRole('button', { name: '成员 1' }))
    fireEvent.click(screen.getByRole('button', { name: /开发成员.*实现功能/ }))
    await screen.findByRole('option', { name: 'Test model' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('region', { name: '成员列表' })).toBeNull()
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'claude' } })
    fireEvent.click(screen.getByRole('button', { name: '保存成员' }))
    await waitFor(() => expect(service.saveMember).toHaveBeenCalledWith(expect.objectContaining({ provider: 'claude', model: '', skills: [], effort: '' })))
  })
  it('retains the memory draft after a version conflict and uses the selected workspace scope', async () => {
    const { service } = fixture()
    vi.mocked(service.saveMemory).mockRejectedValueOnce(new Error('文档已被其他窗口修改'))
    render(<TeamWorkspace service={service} context={context} />)
    fireEvent.click(screen.getByRole('button', { name: '成员 1' }))
    fireEvent.click(screen.getByRole('button', { name: /开发成员.*实现功能/ }))
    fireEvent.click(screen.getByRole('button', { name: '成员记忆' }))
    await waitFor(() => expect((screen.getByLabelText('经验 Markdown') as HTMLTextAreaElement).value).toBe('# 当前经验'))
    fireEvent.change(screen.getByLabelText('经验 Markdown'), { target: { value: '不能丢失的编辑' } })
    fireEvent.click(screen.getByRole('button', { name: '保存记忆' }))
    await screen.findByRole('alert')
    expect(service.saveMemory).toHaveBeenCalledWith('member', 3, '不能丢失的编辑', '/repo')
    expect((screen.getByLabelText('经验 Markdown') as HTMLTextAreaElement).value).toBe('不能丢失的编辑')
  })
  it('keeps editing in the main pane and returns to the member list', async () => {
    const { service } = fixture(); render(<TeamWorkspace service={service} context={context} />)
    fireEvent.click(screen.getByRole('button', { name: '成员 1' }))
    fireEvent.click(screen.getByRole('button', { name: /开发成员.*实现功能/ }))
    expect(screen.queryByRole('navigation', { name: '团队导航' })).toBeNull()
    expect(screen.queryByRole('region', { name: '成员列表' })).toBeNull()
    expect(screen.getByRole('region', { name: '详情' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '成员' }))
    expect(screen.getByRole('region', { name: '成员列表' })).toBeTruthy()
    expect(screen.queryByLabelText('成员名称')).toBeNull()
  })
  it('defaults to tasks from the selected workspace and can show all workspaces', () => {
    const { service, snapshot } = fixture()
    const task = { id: 'local', title: '本项目任务', brief: '说明', workspaceRoot: '/repo', members: [member], steps: [], status: 'draft', team: null } as unknown as TeamTask
    snapshot.state.tasks = [task, { ...task, id: 'other', title: '其他项目任务', workspaceRoot: '/elsewhere' }]
    render(<TeamWorkspace service={service} context={context} />)
    expect(screen.getByText('本项目任务')).toBeTruthy()
    expect(screen.queryByText('其他项目任务')).toBeNull()
    fireEvent.change(screen.getByLabelText('任务范围'), { target: { value: 'all' } })
    expect(screen.getByText('其他项目任务')).toBeTruthy()
  })
  it('uses the selected reply as the assignment brief instead of assuming inherited context', async () => {
    const { service } = fixture()
    render(<AssignAction service={service} context={{ threadId: 'origin', threadCwd: '/repo', workspaceRoot: '/repo', checkoutRoot: '/repo', disabled: false, turnId: 'turn', items: [{ turnId: 'turn', item: { type: 'agentMessage', text: '实施方案：增加登录校验' } }] as never }} />)
    fireEvent.click(screen.getByTitle('把这条回复作为任务说明，交给成员或团队'))
    expect((screen.getByLabelText('任务说明与验收要求') as HTMLTextAreaElement).value).toBe('实施方案：增加登录校验')
  })
})

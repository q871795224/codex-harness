// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkspaceSettings } from './WorkspaceSettings'
import { runtime } from '../../core/runtime/bridge'
vi.mock('../../core/runtime/bridge', () => ({ runtime: { memoryDomainSettings: vi.fn(), memoryCreateDomain: vi.fn(), memoryDeleteDomain: vi.fn(), memorySetDomainBinding: vi.fn() } }))
beforeEach(() => { vi.resetAllMocks(); vi.mocked(runtime.memoryDomainSettings).mockResolvedValue({ domains: [], bindings: [] }) })

afterEach(cleanup)
const workspace = { root: '/repo/中文 project', checkoutRoot: '/repo/中文 project', name: 'project', branch: null, sha: null, createdAt: 1, lastOpenedAt: 1 }

it('shows workspace paths and removes the selected root', async () => {
  const remove = vi.fn()
  render(<WorkspaceSettings workspaces={[workspace]} onAdd={vi.fn()} onRemove={remove} />)
  expect(screen.getByText(workspace.root)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '移除工作区 project' }))
  expect(remove).toHaveBeenCalledWith(workspace.root)
  await waitFor(() => expect(screen.getByText('还没有领域标签')).toBeTruthy())
})

it('prevents repeated add clicks while the picker is open and reports errors', async () => {
  let reject!: (error: Error) => void
  const add = vi.fn(() => new Promise((_resolve, fail) => { reject = fail }))
  render(<WorkspaceSettings workspaces={[]} onAdd={add} onRemove={vi.fn()} />)
  const button = screen.getByRole('button', { name: '添加工作区' }) as HTMLButtonElement
  fireEvent.click(button)
  expect(button.disabled).toBe(true)
  fireEvent.click(button)
  expect(add).toHaveBeenCalledTimes(1)
  await act(async () => { reject(new Error('无法打开目录')) })
  expect(button.disabled).toBe(false)
  expect(screen.getByRole('alert').textContent).toBe('无法打开目录')
})

it('keeps creation separate from per-workspace association and removal, including other', async () => {
  let domains = ['DNS', 'ADR']
  const second = { ...workspace, name: 'second', root: '/repo/second' }
  const bindings = [
    { workspaceName: 'project', workspaceRoot: workspace.root as string | null, domains: ['DNS'] },
    { workspaceName: 'second', workspaceRoot: second.root as string | null, domains: ['DNS'] },
  ]
  vi.mocked(runtime.memoryDomainSettings).mockImplementation(async () => ({ domains: [...domains], bindings: bindings.map((binding) => ({ ...binding, domains: [...binding.domains] })) }))
  vi.mocked(runtime.memoryCreateDomain).mockImplementation(async (name) => { domains = [...domains, name] })
  vi.mocked(runtime.memorySetDomainBinding).mockImplementation(async (root, domain, linked) => {
    let binding = bindings.find((item) => item.workspaceRoot === root)
    if (!binding) { binding = { workspaceName: 'other', workspaceRoot: null, domains: [] }; bindings.push(binding) }
    binding.domains = linked ? [...binding.domains, domain] : binding.domains.filter((name) => name !== domain)
  })
  render(<WorkspaceSettings workspaces={[workspace, second]} onAdd={vi.fn()} onRemove={vi.fn()} />)
  await screen.findByRole('button', { name: '从 project 移除领域 DNS' })
  const projectTags = within(screen.getByRole('group', { name: 'project 的领域' }))
  expect(projectTags.queryByText('ADR')).toBeNull()
  fireEvent.change(screen.getByLabelText('领域名称'), { target: { value: ' 工程经验 ' } })
  fireEvent.click(screen.getByRole('button', { name: '创建领域' }))
  await waitFor(() => expect(within(screen.getByRole('list', { name: '所有领域' })).getByText('工程经验')).toBeTruthy())
  expect(runtime.memoryCreateDomain).toHaveBeenCalledWith('工程经验')
  expect(runtime.memorySetDomainBinding).not.toHaveBeenCalled()
  for (const name of ['project', 'second', 'other']) {
    expect(within(screen.getByRole('group', { name: `${name} 的领域` })).queryByText('工程经验')).toBeNull()
  }
  fireEvent.click(screen.getByRole('button', { name: '为 project 添加领域' }))
  const picker = screen.getByRole('combobox', { name: '为 project 选择领域' })
  expect(within(picker).queryByRole('option', { name: 'DNS' })).toBeNull()
  fireEvent.change(picker, { target: { value: 'ADR' } })
  await screen.findByRole('button', { name: '从 project 移除领域 ADR' })
  expect(runtime.memorySetDomainBinding).toHaveBeenLastCalledWith(workspace.root, 'ADR', true)
  expect(screen.queryByRole('button', { name: '从 second 移除领域 ADR' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '从 project 移除领域 DNS' }))
  await waitFor(() => expect(projectTags.queryByText('DNS')).toBeNull())
  expect(runtime.memorySetDomainBinding).toHaveBeenLastCalledWith(workspace.root, 'DNS', false)
  expect(screen.getByRole('button', { name: '从 second 移除领域 DNS' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '删除领域 DNS' })).toBeTruthy()
  expect(runtime.memoryDeleteDomain).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '为 other 添加领域' }))
  fireEvent.change(screen.getByRole('combobox', { name: '为 other 选择领域' }), { target: { value: 'DNS' } })
  await screen.findByRole('button', { name: '从 other 移除领域 DNS' })
  expect(runtime.memorySetDomainBinding).toHaveBeenLastCalledWith(null, 'DNS', true)
})

it('allows cancelling a picker and keeps associations unchanged when a write fails', async () => {
  vi.mocked(runtime.memoryDomainSettings).mockResolvedValue({ domains: ['DNS', 'ADR'], bindings: [{ workspaceName: 'project', workspaceRoot: workspace.root, domains: ['DNS'] }] })
  vi.mocked(runtime.memorySetDomainBinding).mockRejectedValue(new Error('写入失败'))
  render(<WorkspaceSettings workspaces={[workspace]} onAdd={vi.fn()} onRemove={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: '从 project 移除领域 DNS' }))
  await screen.findByText('写入失败')
  expect(screen.getByRole('button', { name: '从 project 移除领域 DNS' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '为 project 添加领域' }))
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
  expect(screen.queryByRole('combobox')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '为 project 添加领域' }))
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ADR' } })
  await screen.findByText('写入失败')
  expect(screen.queryByRole('button', { name: '从 project 移除领域 ADR' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '取消为 project 添加领域' }))
  expect(screen.queryByRole('combobox')).toBeNull()
})

it('requires a second click to delete a domain and preserves the UI on backend failure', async () => {
  vi.mocked(runtime.memoryDomainSettings).mockResolvedValue({ domains: ['DNS'], bindings: [{ workspaceName: 'project', workspaceRoot: workspace.root, domains: ['DNS'] }] })
  vi.mocked(runtime.memoryDeleteDomain).mockRejectedValueOnce(new Error('数据库忙'))
  render(<WorkspaceSettings workspaces={[workspace]} onAdd={vi.fn()} onRemove={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: '删除领域 DNS' }))
  expect(runtime.memoryDeleteDomain).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '确认删除领域 DNS' }))
  await screen.findByText('数据库忙')
  expect(screen.getByRole('button', { name: '从 project 移除领域 DNS' })).toBeTruthy()
  vi.mocked(runtime.memoryDeleteDomain).mockImplementationOnce(async () => { vi.mocked(runtime.memoryDomainSettings).mockResolvedValue({ domains: [], bindings: [] }) })
  fireEvent.click(screen.getByRole('button', { name: '确认删除领域 DNS' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: '从 project 移除领域 DNS' })).toBeNull())
})

it('does not submit during Chinese input composition or repeat an in-flight mutation', async () => {
  let complete!: () => void
  vi.mocked(runtime.memoryCreateDomain).mockImplementation(() => new Promise<void>((resolve) => { complete = resolve }))
  render(<WorkspaceSettings workspaces={[]} onAdd={vi.fn()} onRemove={vi.fn()} />)
  const input = screen.getByLabelText('领域名称') as HTMLInputElement
  await waitFor(() => expect(input.disabled).toBe(false))
  fireEvent.change(input, { target: { value: '数据面' } })
  fireEvent.compositionStart(input)
  fireEvent.submit(input.closest('form')!)
  expect(runtime.memoryCreateDomain).not.toHaveBeenCalled()
  fireEvent.compositionEnd(input)
  fireEvent.submit(input.closest('form')!)
  fireEvent.submit(input.closest('form')!)
  expect(runtime.memoryCreateDomain).toHaveBeenCalledTimes(1)
  await act(async () => complete())
})

it('reloads after a failed list read instead of offering uninitialized tag controls', async () => {
  vi.mocked(runtime.memoryDomainSettings).mockRejectedValueOnce(new Error('读取失败'))
  render(<WorkspaceSettings workspaces={[workspace]} onAdd={vi.fn()} onRemove={vi.fn()} />)
  await screen.findByText('读取失败')
  expect((screen.getByLabelText('领域名称') as HTMLInputElement).disabled).toBe(true)
  vi.mocked(runtime.memoryDomainSettings).mockResolvedValue({ domains: ['DNS'], bindings: [] })
  fireEvent.click(screen.getByRole('button', { name: '刷新领域' }))
  await waitFor(() => expect((screen.getByRole('button', { name: '为 project 添加领域' }) as HTMLButtonElement).disabled).toBe(false))
  expect(screen.queryByRole('button', { name: '从 project 移除领域 DNS' })).toBeNull()
})

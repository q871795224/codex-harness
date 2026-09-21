// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

it('creates domains and toggles multiple workspace tags, including other', async () => {
  let domains = ['DNS', 'ADR']
  const bindings = [{ workspaceName: 'project', workspaceRoot: workspace.root as string | null, domains: ['DNS'] }]
  vi.mocked(runtime.memoryDomainSettings).mockImplementation(async () => ({ domains: [...domains], bindings: bindings.map((binding) => ({ ...binding, domains: [...binding.domains] })) }))
  vi.mocked(runtime.memoryCreateDomain).mockImplementation(async (name) => { domains = [...domains, name] })
  vi.mocked(runtime.memorySetDomainBinding).mockImplementation(async (root, domain, linked) => {
    let binding = bindings.find((item) => item.workspaceRoot === root)
    if (!binding) { binding = { workspaceName: 'other', workspaceRoot: null, domains: [] }; bindings.push(binding) }
    binding.domains = linked ? [...binding.domains, domain] : binding.domains.filter((name) => name !== domain)
  })
  render(<WorkspaceSettings workspaces={[workspace]} onAdd={vi.fn()} onRemove={vi.fn()} />)
  const dns = await screen.findByRole('button', { name: 'project 领域 DNS' })
  expect(dns.getAttribute('aria-pressed')).toBe('true')
  const adr = screen.getByRole('button', { name: 'project 领域 ADR' })
  fireEvent.click(adr)
  await waitFor(() => expect(adr.getAttribute('aria-pressed')).toBe('true'))
  expect(dns.getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(dns)
  await waitFor(() => expect(dns.getAttribute('aria-pressed')).toBe('false'))
  fireEvent.click(screen.getByRole('button', { name: 'other 领域 DNS' }))
  await waitFor(() => expect(runtime.memorySetDomainBinding).toHaveBeenLastCalledWith(null, 'DNS', true))
  await waitFor(() => expect((screen.getByLabelText('领域名称') as HTMLInputElement).disabled).toBe(false))
  fireEvent.change(screen.getByLabelText('领域名称'), { target: { value: ' 工程经验 ' } })
  fireEvent.click(screen.getByRole('button', { name: '创建领域' }))
  await screen.findByRole('button', { name: 'project 领域 工程经验' })
  expect(runtime.memoryCreateDomain).toHaveBeenCalledWith('工程经验')
})

it('requires a second click to delete a domain and preserves the UI on backend failure', async () => {
  vi.mocked(runtime.memoryDomainSettings).mockResolvedValue({ domains: ['DNS'], bindings: [] })
  vi.mocked(runtime.memoryDeleteDomain).mockRejectedValueOnce(new Error('数据库忙'))
  render(<WorkspaceSettings workspaces={[workspace]} onAdd={vi.fn()} onRemove={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: '删除领域 DNS' }))
  expect(runtime.memoryDeleteDomain).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '确认删除领域 DNS' }))
  await screen.findByText('数据库忙')
  expect(screen.getByRole('button', { name: 'project 领域 DNS' })).toBeTruthy()
  vi.mocked(runtime.memoryDeleteDomain).mockImplementationOnce(async () => { vi.mocked(runtime.memoryDomainSettings).mockResolvedValue({ domains: [], bindings: [] }) })
  fireEvent.click(screen.getByRole('button', { name: '确认删除领域 DNS' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'project 领域 DNS' })).toBeNull())
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
  await screen.findByRole('button', { name: 'project 领域 DNS' })
})

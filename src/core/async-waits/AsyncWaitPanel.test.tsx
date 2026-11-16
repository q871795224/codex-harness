// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AsyncWaitPanel } from './AsyncWaitPanel'
import { runtime } from '../runtime/bridge'
import type { AsyncWaitTask } from './types'
vi.mock('../runtime/bridge', () => ({ runtime: { listAsyncWaits: vi.fn(), listenAsyncWaits: vi.fn(async () => () => {}), asyncWaitAction: vi.fn(), reviewAsyncWait: vi.fn() } }))
beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)
it('lets users find waits in other conversations and resume paused checks without sending chat input', async () => {
  const task = { id: 'cert', threadId: 'origin', status: 'paused', title: 'Certificate', summary: 'login expired', continuation: 'Verify HTTPS', deadline: 1000, lastCheckedAt: null } as AsyncWaitTask
  vi.mocked(runtime.listAsyncWaits).mockResolvedValue({ data: [task], schedulerError: null })
  const open = vi.fn()
  render(<AsyncWaitPanel threadId="other" onOpenThread={open} />)
  await waitFor(() => expect(screen.getByText('当前会话没有异步等待。')).toBeTruthy())
  fireEvent.click(screen.getByLabelText('查看所有会话'))
  expect(screen.getByText('login expired')).toBeTruthy()
  fireEvent.click(screen.getByText('打开来源会话')); expect(open).toHaveBeenCalledWith('origin')
  await act(async () => fireEvent.click(screen.getByText('重新检查并继续')))
  expect(runtime.asyncWaitAction).toHaveBeenCalledWith('cert', 'resume')
})

it('opens the dedicated page across conversations and filters completed tasks', async () => {
  const make = (id: string, status: AsyncWaitTask['status']) => ({ id, threadId: 'origin', status, title: id, summary: status, continuation: 'Review', deadline: 1000, lastCheckedAt: null }) as AsyncWaitTask
  vi.mocked(runtime.listAsyncWaits).mockResolvedValue({ data: [make('Waiting certificate', 'waiting'), make('Finished bot', 'delivered')], schedulerError: null })
  const open = vi.fn()
  render(<AsyncWaitPanel threadId="another" view="page" onOpenThread={open} />)
  await waitFor(() => expect(screen.getByText('Waiting certificate')).toBeTruthy())
  expect(screen.getByRole('heading', { name: '异步任务' })).toBeTruthy()
  expect((screen.getByLabelText('查看所有会话') as HTMLInputElement).checked).toBe(true)
  expect(screen.queryByText('Finished bot')).toBeNull()
  fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'pending' } })
  expect(screen.queryByText('Finished bot')).toBeNull()
  fireEvent.click(screen.getByText('打开来源会话'))
  expect(open).toHaveBeenCalledWith('origin')
  fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'ended' } })
  expect(screen.queryByText('Waiting certificate')).toBeNull()
  expect(screen.getByText('Finished bot')).toBeTruthy()
})
it('keeps the dedicated page visible when no asynchronous tasks exist', async () => {
  vi.mocked(runtime.listAsyncWaits).mockResolvedValue({ data: [], schedulerError: null })
  render(<AsyncWaitPanel threadId="origin" view="page" />)
  await waitFor(() => expect(runtime.listAsyncWaits).toHaveBeenCalled())
  expect(screen.getByRole('region', { name: '异步任务' })).toBeTruthy()
  expect(screen.getByText('没有符合条件的异步任务。任务由 Agent 创建后会显示在这里。')).toBeTruthy()
})

it('keeps continuation and observations collapsed while showing checks alongside the task title', async () => {
  vi.mocked(runtime.listAsyncWaits).mockResolvedValue({ data: [{ id: 'reply', threadId: 'origin', status: 'waiting', title: '等待回复', summary: '尚无回复', lastObservation: 'previous observation', continuation: 'Internal continuation instructions', lastCheckedAt: 1700000000, deadline: 1700000300 } as AsyncWaitTask], schedulerError: null })
  render(<AsyncWaitPanel threadId="origin" view="page" />)
  await screen.findByText('等待回复')
  const details = screen.getByText('详情').closest('details')!
  expect(details.open).toBe(false)
  expect(details.textContent).toContain('Internal continuation instructions')
  const heading = screen.getByText('等待回复').parentElement!
  expect(heading.querySelectorAll('time')).toHaveLength(2)
  expect(screen.getByRole('status').className).toContain('waiting')
})

it('requires an explicit user decision for a custom proposal and passes its revision', async () => {
  const task = { id: 'custom', threadId: 'origin', status: 'awaitingApproval', title: '远端实验', summary: 'pending', condition: '结果文件生成', continuation: '分析结果', checkerSource: 'print("readonly")', revision: 7, deadline: 1000 } as AsyncWaitTask
  vi.mocked(runtime.listAsyncWaits).mockResolvedValue({ data: [task], schedulerError: null })
  render(<AsyncWaitPanel threadId="origin" view="page" />)
  await screen.findByText('同意创建')
  expect(runtime.reviewAsyncWait).not.toHaveBeenCalled()
  expect(screen.getByText('就绪条件：结果文件生成')).toBeTruthy()
  expect(screen.getByText('print("readonly")')).toBeTruthy()
  await act(async () => fireEvent.click(screen.getByText('同意创建')))
  expect(runtime.reviewAsyncWait).toHaveBeenCalledWith('custom', 7, true)
})

const dockTask = (patch: Partial<AsyncWaitTask> = {}): AsyncWaitTask => ({
  id: 'reply', threadId: 'origin', status: 'waiting', title: '等待审批回复',
  summary: '暂未收到新回复', condition: '审批人回复后继续', continuation: '读取任务后继续处理',
  cwd: '/test', revision: 1, createdAt: 1700000000, updatedAt: 1700000000,
  deadline: 1700600000, nextCheckAt: 1700000300, lastCheckedAt: 1700000000,
  failures: 0, lastObservation: null, deliveryFailures: 0, nextDeliveryAt: 0,
  turnId: null, deliveryId: null, ...patch,
})

it('shows only unfinished tasks from the current conversation in collapsed rows', async () => {
  const tasks = [
    dockTask(), dockTask({ id: 'other', threadId: 'other', title: '其他会话任务' }),
    ...(['delivered', 'notified', 'cancelled', 'closed'] as const).map(status => dockTask({ id: status, status, title: `结束任务 ${status}` })),
  ]
  vi.mocked(runtime.listAsyncWaits).mockResolvedValue({ data: tasks, schedulerError: null })
  const openTasks = vi.fn()
  render(<AsyncWaitPanel threadId="origin" view="dock" onOpenTasks={openTasks} />)
  const toggle = await screen.findByRole('button', { name: '展开异步任务：等待审批回复' })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(screen.getByText('暂未收到新回复')).toBeTruthy()
  expect(screen.getByRole('status').textContent).toBe('等待外部结果')
  expect(screen.queryByText('其他会话任务')).toBeNull()
  expect(screen.queryAllByText(/结束任务/)).toHaveLength(0)
  expect(screen.queryByText('等待条件：审批人回复后继续')).toBeNull()
  fireEvent.click(toggle)
  expect(screen.getByText('等待条件：审批人回复后继续')).toBeTruthy()
  expect(screen.getByText(/^最近检查：/)).toBeTruthy()
  expect(screen.getByText(/^下次检查：/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '查看异步任务' }))
  expect(openTasks).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: '收起异步任务：等待审批回复' }))
  expect(screen.queryByText('等待条件：审批人回复后继续')).toBeNull()
  expect(runtime.asyncWaitAction).not.toHaveBeenCalled()
})

it('updates conversation rows on native events and removes tasks after continuation starts', async () => {
  let changed = () => {}
  const stop = vi.fn()
  vi.mocked(runtime.listenAsyncWaits).mockImplementation(async listener => { changed = listener; return stop })
  vi.mocked(runtime.listAsyncWaits).mockResolvedValue({ data: [dockTask()], schedulerError: null })
  const { unmount } = render(<AsyncWaitPanel threadId="origin" view="dock" />)
  await screen.findByText('等待审批回复')
  vi.mocked(runtime.listAsyncWaits).mockResolvedValue({ data: [dockTask({ status: 'ready', summary: '已收到回复' })], schedulerError: null })
  await act(async () => changed())
  expect(screen.getByRole('status').textContent).toBe('已就绪，等待会话空闲')
  expect(screen.getByText('已收到回复')).toBeTruthy()
  vi.mocked(runtime.listAsyncWaits).mockResolvedValue({ data: [dockTask({ status: 'delivered' })], schedulerError: null })
  await act(async () => changed())
  expect(screen.queryByRole('region', { name: '当前会话的异步任务' })).toBeNull()
  unmount()
  expect(stop).toHaveBeenCalledOnce()
})

it('switches the task scope immediately when changing conversations', async () => {
  vi.mocked(runtime.listAsyncWaits).mockResolvedValue({ data: [dockTask(), dockTask({ id: 'paused', threadId: 'other', status: 'paused', title: '等待构建' })], schedulerError: null })
  const { rerender } = render(<AsyncWaitPanel threadId="origin" view="dock" />)
  const toggle = await screen.findByRole('button', { name: '展开异步任务：等待审批回复' })
  fireEvent.click(toggle)
  rerender(<AsyncWaitPanel threadId="other" view="dock" />)
  expect(screen.queryByText('等待审批回复')).toBeNull()
  expect(screen.getByRole('status').textContent).toBe('已暂停')
  rerender(<AsyncWaitPanel threadId="origin" view="dock" />)
  expect(screen.getByRole('button', { name: '展开异步任务：等待审批回复' }).getAttribute('aria-expanded')).toBe('false')
})

it('shows sleep wake time and keeps paused, expired and uncertain tasks visible', async () => {
  const statuses = ['awaitingApproval', 'paused', 'expired', 'dispatching', 'uncertain'] as const
  vi.mocked(runtime.listAsyncWaits).mockResolvedValue({ data: [
    dockTask({ target: { type: 'sleep', wakeAt: 1700000900 } }),
    ...statuses.map(status => dockTask({ id: status, status, title: status })),
  ], schedulerError: null })
  render(<AsyncWaitPanel threadId="origin" view="dock" />)
  fireEvent.click(await screen.findByRole('button', { name: '展开异步任务：等待审批回复' }))
  expect(screen.getByText(/^唤醒时间：/)).toBeTruthy()
  expect(screen.queryByText(/^下次检查：/)).toBeNull()
  expect(screen.getAllByRole('status').map(element => element.textContent)).toEqual([
    '等待外部结果', '等待用户确认', '已暂停', '等待已到期', '提交中／待核对', '提交结果待核对',
  ])
  expect(runtime.reviewAsyncWait).not.toHaveBeenCalled()
})

it('hides an empty conversation dock and surfaces errors without claiming checks are healthy', async () => {
  let changed = () => {}
  vi.mocked(runtime.listenAsyncWaits).mockImplementation(async listener => { changed = listener; return () => {} })
  vi.mocked(runtime.listAsyncWaits).mockResolvedValue({ data: [dockTask({ threadId: 'other' })], schedulerError: 'scheduler unavailable' })
  render(<AsyncWaitPanel threadId="origin" view="dock" />)
  await waitFor(() => expect(runtime.listAsyncWaits).toHaveBeenCalled())
  expect(screen.queryByRole('region')).toBeNull()
  vi.mocked(runtime.listAsyncWaits).mockResolvedValue({ data: [dockTask()], schedulerError: 'scheduler unavailable' })
  await act(async () => changed())
  expect(screen.getByRole('alert').textContent).toContain('scheduler unavailable')
  vi.mocked(runtime.listAsyncWaits).mockRejectedValue(new Error('offline'))
  await act(async () => changed())
  expect(screen.getByRole('alert').textContent).toContain('offline')
  expect(screen.getByText('等待审批回复')).toBeTruthy()
})

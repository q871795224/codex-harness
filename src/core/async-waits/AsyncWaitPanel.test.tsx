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

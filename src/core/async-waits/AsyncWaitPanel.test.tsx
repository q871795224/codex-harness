// @vitest-environment jsdom
import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { AsyncWaitPanel } from './AsyncWaitPanel'
import { runtime } from '../runtime/bridge'
import type { AsyncWaitTask } from './types'
vi.mock('../runtime/bridge', () => ({ runtime: { listAsyncWaits: vi.fn(), listenAsyncWaits: vi.fn(async () => () => {}), asyncWaitAction: vi.fn() } }))
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

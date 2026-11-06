// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { RouterFeedbackPanel } from './RouterFeedbackPanel'
import { readRouterFeedback } from '../../core/workspace-router/examples'
vi.mock('../../core/workspace-router/examples', () => ({ readRouterFeedback: vi.fn() }))
afterEach(cleanup)
it('shows individual feedback and can load the next page without loading inactive panels', async () => {
  const row = { id: 'one', threadId: 'thread', sourceTurnId: null, sourceMessageId: null, chosen: '/dns-agent', correct: '/dns-api', feedback: 'inaccurate', at: 1, request: '查看DNS API内存', hasAttachments: false }
  vi.mocked(readRouterFeedback).mockResolvedValueOnce({ data: [row], hasMore: true } as never).mockResolvedValueOnce({ data: [{ ...row, id: 'two', request: null }], hasMore: false } as never)
  const { rerender } = render(<RouterFeedbackPanel workspaces={[]} active={false} />)
  expect(readRouterFeedback).not.toHaveBeenCalled()
  rerender(<RouterFeedbackPanel workspaces={[]} active />)
  await screen.findByText('查看DNS API内存')
  expect(screen.getByText('/dns-agent → /dns-api')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
  await waitFor(() => expect(readRouterFeedback).toHaveBeenLastCalledWith(1))
  await screen.findByText('来源消息不可用')
})

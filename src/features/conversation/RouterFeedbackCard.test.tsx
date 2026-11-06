// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { RouteRecord } from '../../core/workspace-router/service'
import { RouterFeedbackCard } from './RouterFeedbackCard'
afterEach(cleanup)
const record: RouteRecord = {
  id: 'attempt', threadId: 'thread', sourceMessageId: 'message', sourceTurnId: 'turn', createdAt: 1, completedAt: 2, durationMs: 1,
  model: 'gpt-6.1-terra', effort: 'medium', promptVersion: 1,
  candidates: [{ root: '/a', checkoutRoot: '/a', name: 'A', description: '' }, { root: '/b', checkoutRoot: '/b', name: 'B', description: '' }],
  choice: { primary: '/a', related: ['/b'] }, status: 'started', feedback: 'pending', actualWorkspace: null, history: [],
}
it('saves a correction only after choosing the actual workspace and submitting', async () => {
  const save = vi.fn().mockResolvedValue(undefined)
  render(<RouterFeedbackCard record={record} onFeedback={save} />)
  expect(screen.getByText('已自动选择 A · 可能涉及 B')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '不准' }))
  expect(save).not.toHaveBeenCalled()
  expect(screen.getByText('仅保存反馈，当前工作继续。')).toBeTruthy()
  fireEvent.change(screen.getByRole('combobox', { name: '实际工作区' }), { target: { value: '/b' } })
  fireEvent.click(screen.getByRole('button', { name: '保存反馈' }))
  await waitFor(() => expect(save).toHaveBeenCalledWith(false, '/b'))
})
it('hides feedback after the next message, including restored legacy implicit acceptance', () => {
  const { rerender } = render(<RouterFeedbackCard record={{ ...record, feedback: 'implicit-accurate' }} onFeedback={vi.fn()} />)
  expect(screen.queryByText('工作区路由')).toBeNull()
  rerender(<RouterFeedbackCard record={{ ...record, feedback: 'accurate', feedbackDismissedAt: 10 }} onFeedback={vi.fn()} />)
  expect(screen.queryByText('工作区路由')).toBeNull()
})
it('marks only the saved vote as selected without an extra confirmation line', () => {
  const { rerender } = render(<RouterFeedbackCard record={{ ...record, feedback: 'accurate' }} onFeedback={vi.fn()} />)
  expect(screen.getByRole('button', { name: '准' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('button', { name: '不准' }).getAttribute('aria-pressed')).toBe('false')
  expect(screen.queryByRole('status')).toBeNull()
  rerender(<RouterFeedbackCard record={{ ...record, feedback: 'inaccurate', actualWorkspace: '/b' }} onFeedback={vi.fn()} />)
  expect(screen.getByRole('button', { name: '不准' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByText('实际工作区：B')).toBeTruthy()
})
it('keeps the vote unselected when saving fails', async () => {
  render(<RouterFeedbackCard record={record} onFeedback={vi.fn().mockRejectedValue(new Error('disk unavailable'))} />)
  fireEvent.click(screen.getByRole('button', { name: '准' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('disk unavailable'))
  expect(screen.getByRole('button', { name: '准' }).getAttribute('aria-pressed')).toBe('false')
})
it('cancelling a correction records nothing', () => {
  const save = vi.fn()
  render(<RouterFeedbackCard record={record} onFeedback={save} />)
  fireEvent.click(screen.getByRole('button', { name: '不准' }))
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  expect(save).not.toHaveBeenCalled()
  expect(screen.queryByRole('combobox')).toBeNull()
})

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MemoryButton } from './MemoryButton'
import type { MemoryService } from '../../core/memory/types'
afterEach(cleanup)
it('shows the requested hover text and saves the current conversation without project binding', async () => {
  const service: MemoryService = { subscribe: () => () => {}, isRunning: () => false, saveConversation: vi.fn(async () => []) }
  render(<MemoryButton service={service} threadId="current" cwd="/repo" disabled={false} />)
  const button = screen.getByRole('button', { name: '保存到记忆' })
  expect(button.getAttribute('title')).toBe('保存到记忆')
  fireEvent.click(button)
  await waitFor(() => expect(service.saveConversation).toHaveBeenCalledWith({ threadId: 'current', cwd: '/repo' }))
})
it('disables saving while extraction is active', () => {
  const service: MemoryService = { subscribe: () => () => {}, isRunning: () => true, saveConversation: vi.fn(async () => []) }
  render(<MemoryButton service={service} threadId="current" cwd="/repo" disabled={false} />)
  expect((screen.getByRole('button', { name: '保存到记忆' }) as HTMLButtonElement).disabled).toBe(true)
})

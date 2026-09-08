// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PluginStorage } from '../../extensions/types'
import { TasksTab, todoCreatedTime, type TodoItem } from './index'

afterEach(cleanup)
it('shows only saved creation timestamps and preserves them on edits', async () => {
  const items: TodoItem[] = [1787883625921, 1788856515249].map((createdAt, index) => ({ id: `${index}`, content: `todo ${index}`, completed: false, dueAt: null, scope: 'global', workspaceRoot: null, threadId: null, createdAt, updatedAt: createdAt }))
  const set = vi.fn(async () => undefined)
  const storage: PluginStorage = { get: async <T,>(key: string) => (key === 'items' ? items : '') as T, set }
  const { container } = render(<TasksTab storage={storage} context={{ threadId: null, threadCwd: null, workspaceRoot: null, items: [], workspaces: [], threads: [] }} />)
  for (const item of items) expect(await screen.findByText(todoCreatedTime(item.createdAt))).toBeTruthy()
  expect(container.querySelectorAll('input[type="datetime-local"]')).toHaveLength(0)
  expect(container.textContent).not.toContain('计划')
  expect(container.textContent).not.toContain('创建：')
  fireEvent.click(screen.getAllByRole('checkbox')[0])
  await waitFor(() => expect(set).toHaveBeenCalledWith('items', [expect.objectContaining({ completed: true, createdAt: items[0].createdAt }), items[1]]))
  expect(todoCreatedTime(undefined as unknown as number)).toBe('未知')
})

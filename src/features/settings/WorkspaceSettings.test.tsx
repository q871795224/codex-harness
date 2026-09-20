// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceSettings } from './WorkspaceSettings'

afterEach(cleanup)
const workspace = { root: '/repo/中文 project', checkoutRoot: '/repo/中文 project', name: 'project', branch: null, sha: null, createdAt: 1, lastOpenedAt: 1 }

it('shows workspace paths and removes the selected root', () => {
  const remove = vi.fn()
  render(<WorkspaceSettings workspaces={[workspace]} onAdd={vi.fn()} onRemove={remove} />)
  expect(screen.getByText(workspace.root)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '移除工作区 project' }))
  expect(remove).toHaveBeenCalledWith(workspace.root)
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

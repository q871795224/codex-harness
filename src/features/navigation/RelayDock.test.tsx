// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Thread } from '../../core/domain/codex'
import { RelayDock } from './RelayDock'
afterEach(cleanup)

const make = (id: string, extra: Partial<Thread> = {}): Thread => ({ id, name: id, preview: '', cwd: '/repo', createdAt: 1, updatedAt: 1, recencyAt: 1,
  status: { type: 'idle' }, ephemeral: false, canAcceptDirectInput: false, ...extra })

it('lists children with unread state in a relay and jumps back from a child', () => {
  const relay = make('relay', { name: '发布协调', harnessRelay: true })
  const child = make('child', { name: 'ADR 发布单', harnessRelayParent: 'relay' })
  const threads = [relay, child, make('plain')]
  const onOpen = vi.fn()
  const { rerender, container } = render(<RelayDock current={relay} threads={threads} threadStates={{ child: { threadId: 'child', lastReadAt: null, badge: 'success' } }} workingThreadIds={{}} onOpen={onOpen} />)
  expect(screen.getByText('子会话 1')).toBeTruthy()
  expect(screen.getByLabelText('有新回复')).toBeTruthy()
  fireEvent.click(screen.getByText('ADR 发布单'))
  expect(onOpen).toHaveBeenLastCalledWith('child')
  rerender(<RelayDock current={child} threads={threads} threadStates={{}} workingThreadIds={{}} onOpen={onOpen} />)
  fireEvent.click(screen.getByTitle('返回路由会话：发布协调'))
  expect(onOpen).toHaveBeenLastCalledWith('relay')
  rerender(<RelayDock current={threads[2]} threads={threads} threadStates={{}} workingThreadIds={{}} onOpen={onOpen} />)
  expect(container.querySelector('.relay-dock')).toBeNull()
})

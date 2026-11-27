// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { ConversationView } from './ConversationView'
import { writeClipboard } from '../markdown/clipboard'

vi.mock('../markdown/clipboard', () => ({ writeClipboard: vi.fn(async () => {}) }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

function props(rawMode = false): ComponentProps<typeof ConversationView> {
  const items = [
    { turnId: 'turn', item: { id: 'user', type: 'userMessage', content: [{ type: 'text' as const, text: '问题', text_elements: [] }] } },
    { turnId: 'turn', item: { id: 'answer', type: 'agentMessage', text: '答案', phase: 'final_answer' as const } },
  ]
  return { threadId: 'origin', cwd: '/repo', provider: 'codex', items,
    turns: [{ id: 'turn', items: items.map(e => e.item), status: 'completed', error: null, startedAt: 1, completedAt: 2, durationMs: 1 }],
    approvals: [], workspace: null, workspaces: [], workspaceChanging: false,
    initialScrollTop: null, scrollToLatestRequest: 0, hasOlderTurns: false, loadingOlderTurns: false,
    onAnswerApproval: vi.fn(), onLoadOlderTurns: vi.fn(), onScrollPosition: vi.fn(),
    onWorkspaceChange: vi.fn(), onChooseWorkspace: vi.fn(), onRawModeToggle: vi.fn(),
    rawMode, working: false, workingTurnId: null, workingStartedAt: null }
}

it.each([false, true])('copies exact user and assistant identities alongside text copy (raw=%s)', async raw => {
  render(<ConversationView {...props(raw)} />)
  const buttons = screen.getAllByRole('button', { name: '复制消息引用' })
  expect(buttons).toHaveLength(2)
  fireEvent.click(buttons[0])
  await waitFor(() => expect(writeClipboard).toHaveBeenLastCalledWith('harness-message://codex/origin/turn/user'))
  fireEvent.click(buttons[1])
  await waitFor(() => expect(writeClipboard).toHaveBeenLastCalledWith('harness-message://codex/origin/turn/answer'))
  fireEvent.click(screen.getAllByRole('button', { name: '复制消息' })[0])
  await waitFor(() => expect(writeClipboard).toHaveBeenLastCalledWith('问题'))
})

it('does not invent identifiers for unpersisted messages or unsupported providers', () => {
  const options = props()
  delete options.items[0].item.id
  const { rerender } = render(<ConversationView {...options} />)
  expect(screen.getAllByRole('button', { name: '复制消息引用' })).toHaveLength(1)
  rerender(<ConversationView {...props()} threadId="claude:session" provider="claude" />)
  expect(screen.queryByRole('button', { name: '复制消息引用' })).toBeNull()
})

it('copies stable Claude user and assistant UUIDs', async () => {
  const options = props()
  const items = options.items.map((entry, index) => ({ ...entry, item: { ...entry.item,
    providerTurnId: 'native-user', providerMessageId: index ? 'native-answer' : 'native-user' } }))
  render(<ConversationView {...options} items={items} turns={options.turns.map(turn => ({ ...turn, items: items.map(entry => entry.item) }))} threadId="claude:origin" provider="claude" />)
  const buttons = screen.getAllByRole('button', { name: '复制消息引用' })
  fireEvent.click(buttons[0])
  await waitFor(() => expect(writeClipboard).toHaveBeenLastCalledWith('harness-message://claude/claude%3Aorigin/native-user/native-user'))
  fireEvent.click(buttons[1])
  await waitFor(() => expect(writeClipboard).toHaveBeenLastCalledWith('harness-message://claude/claude%3Aorigin/native-user/native-answer'))
})

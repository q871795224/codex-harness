// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { ConversationView } from './ConversationView'

afterEach(cleanup)

it.each([false, true])('shows Claude background work without reopening the completed answer (raw=%s)', rawMode => {
  const answer = { type: 'agentMessage', id: 'answer', text: '前台已完成', phase: 'final_answer' as const }
  const props: ComponentProps<typeof ConversationView> = {
    threadId: 'claude:fixture', provider: 'claude', cwd: '/fixture',
    items: [{ turnId: 'first', item: answer }],
    turns: [{ id: 'first', status: 'completed', items: [answer], error: null,
      startedAt: 1, completedAt: 2, durationMs: 1 }],
    approvals: [], workspace: null, workspaces: [], workspaceChanging: false,
    initialScrollTop: null, scrollToLatestRequest: 0, hasOlderTurns: false, loadingOlderTurns: false,
    onAnswerApproval: vi.fn(), onLoadOlderTurns: vi.fn(), onScrollPosition: vi.fn(),
    onWorkspaceChange: vi.fn(), onChooseWorkspace: vi.fn(), onRawModeToggle: vi.fn(),
    rawMode, working: true, backgroundWorking: true, workingTurnId: null, workingStartedAt: null,
  }
  const { container, rerender } = render(<ConversationView {...props} />)
  expect(screen.getByText('前台已完成')).toBeTruthy()
  expect(screen.getByText('后台执行中')).toBeTruthy()
  expect(container.querySelector('.conversation-turn.running')).toBeNull()
  rerender(<ConversationView {...props} working={false} backgroundWorking={false} />)
  expect(screen.queryByText('后台执行中')).toBeNull()
})

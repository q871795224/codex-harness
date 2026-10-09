// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { ConversationView } from './ConversationView'
import { asyncUserInputAnswer, asyncUserInputRequest } from './asyncUserInput'
import { textInput } from '../../core/domain/codex'

afterEach(cleanup)

const question = {
  type: 'agentMessage', id: 'async-1', delivery: 'async' as const, phase: 'final_answer' as const,
  text: '如何分发？\n- 安装包\n- 远程服务', questions: [{ title: '如何分发？', options: ['安装包', '远程服务'] }],
}
function props(): ComponentProps<typeof ConversationView> {
  return {
    threadId: 'thread-1', items: [{ turnId: 'turn-1', item: question }],
    turns: [{ id: 'turn-1', status: 'inProgress', items: [question], error: null, startedAt: null, completedAt: null, durationMs: null }],
    cwd: '/repo', approvals: [], workspace: null, workspaces: [], workspaceChanging: false,
    initialScrollTop: null, scrollToLatestRequest: 0, hasOlderTurns: false, loadingOlderTurns: false,
    onAnswerApproval: vi.fn(), onLoadOlderTurns: vi.fn(), onScrollPosition: vi.fn(),
    onWorkspaceChange: vi.fn(), onChooseWorkspace: vi.fn(), rawMode: false,
    working: true, workingTurnId: 'turn-1', workingStartedAt: Date.now(), onRawModeToggle: vi.fn(),
  }
}

describe('async question cards in the conversation', () => {
  it.each([false, true])('renders an actionable card in raw mode %s without a final-answer label', async (rawMode) => {
    const options = { ...props(), rawMode }
    render(<ConversationView {...options} />)
    expect(screen.queryByText('最终回答')).toBeNull()
    expect((screen.getByRole('button', { name: '提交回答' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /远程服务/ }))
    expect(options.onAnswerApproval).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }))
    await waitFor(() => expect(options.onAnswerApproval).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'async-1', threadId: 'thread-1' }),
      { answers: { 'question-0': { answers: ['远程服务'] } } },
    ))
    await waitFor(() => expect(screen.queryByRole('button', { name: '提交回答' })).toBeNull())
    expect(screen.queryByText('已处理 Codex 提问')).toBeNull()
  })

  it('keeps a failed submission editable and supports retry', async () => {
    const options = props()
    const submit = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
    render(<ConversationView {...options} onAnswerApproval={submit} />)
    fireEvent.click(screen.getByRole('button', { name: /安装包/ }))
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.queryByText('已处理 Codex 提问')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '提交回答' })).toBeNull())
    expect(screen.queryByText('已处理 Codex 提问')).toBeNull()
  })

  it('does not reopen an answered question after remount while its interjection is pending', () => {
    const options = props()
    const answer = asyncUserInputAnswer(asyncUserInputRequest('thread-1', question)!, { answers: { 'question-0': { answers: ['远程服务'] } } })
    options.pendingSteers = [{ clientUserMessageId: 'answer-1', text: answer, input: [textInput(answer)], createdAt: 1 }]
    const first = render(<ConversationView {...options} />)
    expect(screen.queryByRole('button', { name: '提交回答' })).toBeNull()
    first.unmount()
    render(<ConversationView {...options} />)
    expect(screen.queryByRole('button', { name: '提交回答' })).toBeNull()
    expect(screen.queryByText('已处理 Codex 提问')).toBeNull()
  })

  it('keeps submitted questions out of the prompt area while preserving answer history and a later final answer', () => {
    const options = props()
    const answer = asyncUserInputAnswer(asyncUserInputRequest('thread-1', question)!, { answers: {} })
    options.items.push(
      { turnId: 'turn-2', item: { type: 'userMessage', content: [textInput(answer)] } },
      { turnId: 'turn-2', item: { type: 'agentMessage', id: 'final-2', phase: 'final_answer', text: '已完成评估。' } },
    )
    render(<ConversationView {...options} working={false} workingTurnId={null} />)
    expect(screen.queryByRole('button', { name: '提交回答' })).toBeNull()
    expect(screen.queryByText('已处理 Codex 提问')).toBeNull()
    expect(screen.getByText('已完成评估。')).toBeTruthy()
  })

  it.each(['completed', 'failed', 'interrupted'] as const)('removes unanswered cards when the turn is %s, including restored history', (status) => {
    const options = props()
    const { rerender } = render(<ConversationView {...options} />)
    expect(screen.getByRole('button', { name: '提交回答' })).toBeTruthy()
    options.turns = options.turns.map((turn) => ({ ...turn, status }))
    rerender(<ConversationView {...options} working={false} workingTurnId={null} />)
    expect(screen.queryByRole('button', { name: '提交回答' })).toBeNull()
    expect(screen.queryByText('已处理 Codex 提问')).toBeNull()
    rerender(<ConversationView {...options} working workingTurnId="turn-2" />)
    expect(screen.queryByRole('button', { name: '提交回答' })).toBeNull()
  })
})

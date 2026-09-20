// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ThreadItem, Turn } from '../../core/domain/codex'
import { ConversationView } from './ConversationView'

afterEach(cleanup)
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })

function showItem(item: ThreadItem) {
  const turn: Turn = { id: 't', items: [item], status: 'completed', startedAt: null, completedAt: null, durationMs: null, error: null }
  const noop = () => {}
  return render(<ConversationView items={[{ turnId: 't', item }]} turns={[turn]} cwd="/repo" approvals={[]} workspace={null} workspaces={[]} workspaceChanging={false} initialScrollTop={null} scrollToLatestRequest={0} hasOlderTurns={false} loadingOlderTurns={false} onAnswerApproval={noop} onLoadOlderTurns={noop} onScrollPosition={noop} onWorkspaceChange={noop} onChooseWorkspace={noop} rawMode={false} working={false} workingTurnId={null} workingStartedAt={null} onRawModeToggle={noop} />)
}

it('reveals a long original shell command when the conversation card is expanded', () => {
  const command = `/bin/zsh -lc '${'echo argument; '.repeat(30)} echo FINAL-ARGUMENT'`
  showItem({ id: 'c', type: 'commandExecution', command, status: 'completed', aggregatedOutput: 'TOOL-RESULT', exitCode: 0 })
  fireEvent.click(screen.getByRole('button', { name: /echo argument/ }))
  expect(screen.getByText(command, { normalizer: (text) => text }).textContent).toBe(command)
  expect(screen.getByText('TOOL-RESULT')).toBeTruthy()
})

it.each(['mcpToolCall', 'dynamicToolCall'])('reveals structured arguments and errors for %s', (type) => {
  showItem({ id: 'm', type, server: 'example', tool: 'lookup', status: 'failed', arguments: { query: 'COMPLETE-ARGUMENT' }, error: { message: 'MCP-ERROR' }, contentItems: [{ type: 'inputText', text: 'DYNAMIC-ERROR' }], success: false })
  fireEvent.click(screen.getByRole('button', { name: /lookup/ }))
  expect(screen.getByText('"COMPLETE-ARGUMENT"')).toBeTruthy()
  fireEvent.click(screen.getAllByRole('button', { name: '原文' })[1])
  expect(screen.getByText(type === 'mcpToolCall' ? /MCP-ERROR/ : /DYNAMIC-ERROR/, { selector: 'code' })).toBeTruthy()
})

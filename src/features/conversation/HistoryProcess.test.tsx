// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ThreadItemEntry, Turn } from '../../core/domain/codex'
import { appServer } from '../../core/runtime/appServerClient'
import { runtime } from '../../core/runtime/bridge'
import { ConversationView } from './ConversationView'

vi.mock('../../core/runtime/appServerClient', () => ({ appServer: { listItems: vi.fn() } }))
vi.mock('../../core/runtime/bridge', () => ({ runtime: { readMarkdownImage: vi.fn() } }))
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const final = { turnId: 'turn', item: { id: 'final', type: 'agentMessage', text: 'Final answer', phase: 'final_answer' as const } }
const image = { turnId: 'turn', item: { id: 'image', type: 'imageGeneration', status: 'completed', result: 'aGVsbG8=' } }
const command = { turnId: 'turn', item: { id: 'command', type: 'commandExecution', command: 'echo fixture', status: 'completed', aggregatedOutput: 'complete output' } }
function show(rawMode = false) {
  const turn: Turn = { id: 'turn', items: [final.item], itemsView: 'summary', status: 'completed', startedAt: null, completedAt: null, durationMs: null, error: null }
  const noop = () => {}
  return render(<ConversationView threadId="thread" items={[final]} turns={[turn]} cwd="/repo" approvals={[]} workspace={null} workspaces={[]} workspaceChanging={false} initialScrollTop={null} scrollToLatestRequest={0} hasOlderTurns={false} loadingOlderTurns={false} onAnswerApproval={noop} onLoadOlderTurns={noop} onScrollPosition={noop} onWorkspaceChange={noop} onChooseWorkspace={noop} rawMode={rawMode} working={false} workingTurnId={null} workingStartedAt={null} onRawModeToggle={noop} />)
}

it.each([false, true])('loads process details only after expansion, including in raw mode (%s)', async (rawMode) => {
  vi.mocked(appServer.listItems).mockResolvedValueOnce({ data: [image], nextCursor: 'next' }).mockResolvedValueOnce({ data: [command, final], nextCursor: null })
  show(rawMode)
  expect(screen.getByText('Final answer')).toBeTruthy()
  expect(appServer.listItems).not.toHaveBeenCalled()
  expect(screen.queryByRole('img')).toBeNull()
  const toggle = screen.getByRole('button', { name: /执行过程/ })
  fireEvent.click(toggle)
  const generated = await screen.findByRole('button', { name: /生成图片/ })
  expect(screen.queryByRole('img')).toBeNull()
  expect(runtime.readMarkdownImage).not.toHaveBeenCalled()
  fireEvent.click(generated)
  expect((await screen.findByRole('img', { name: '生成的图片' })).getAttribute('src')).toBe('data:image/png;base64,aGVsbG8=')
  fireEvent.click(screen.getByRole('button', { name: /echo fixture/ }))
  expect(screen.getByText('complete output')).toBeTruthy()
  fireEvent.click(toggle); fireEvent.click(toggle)
  expect(appServer.listItems).toHaveBeenCalledTimes(2)
})

it('keeps the answer visible when detail loading fails and allows an explicit retry', async () => {
  vi.mocked(appServer.listItems).mockRejectedValueOnce(new Error('history unavailable')).mockResolvedValueOnce({ data: [image], nextCursor: null })
  show()
  fireEvent.click(screen.getByRole('button', { name: /执行过程/ }))
  expect((await screen.findByRole('alert')).textContent).toContain('history unavailable')
  expect(screen.getByText('Final answer')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '重试加载过程' }))
  expect(await screen.findByRole('button', { name: /生成图片/ })).toBeTruthy()
})

it('stops requesting more items if the user collapses a loading process', async () => {
  let resolve!: (page: { data: ThreadItemEntry[]; nextCursor: string | null }) => void
  vi.mocked(appServer.listItems).mockImplementationOnce(() => new Promise((done) => { resolve = done }))
  show()
  const toggle = screen.getByRole('button', { name: /执行过程/ })
  fireEvent.click(toggle)
  await waitFor(() => expect(appServer.listItems).toHaveBeenCalledTimes(1))
  fireEvent.click(toggle)
  await act(async () => { resolve({ data: [image], nextCursor: 'more' }) })
  expect(appServer.listItems).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('img')).toBeNull()
})

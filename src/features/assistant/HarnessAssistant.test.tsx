// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HarnessAssistant } from './HarnessAssistant'
import { interpretSessionRequest, queryAssistantSessions, type AssistantSession } from './sessionAssistant'

vi.mock('./sessionAssistant', () => ({ interpretSessionRequest: vi.fn(), queryAssistantSessions: vi.fn() }))
const session: AssistantSession = { id: 'test', title: 'Router 调研', cwd: '/work/router', provider: 'codex', updatedAt: 0, archived: false }

beforeEach(() => {
  vi.resetAllMocks()
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', '') } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open') } },
  })
  vi.mocked(queryAssistantSessions).mockResolvedValue({ rows: [session], unavailable: [] })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
})

it('opens a dialog, suggests the requested action and waits for explicit confirmation', async () => {
  const onMutate = vi.fn().mockResolvedValue(undefined)
  vi.mocked(interpretSessionRequest).mockResolvedValue({ action: 'archive', provider: 'codex', scope: 'active', query: 'Router', recentDays: null, previousRows: [] })
  render(<HarnessAssistant sendShortcut="mod-enter" disabled={false} pinned={[]} onMutate={onMutate} />)
  const launcher = screen.getByRole('button', { name: '助理' })
  fireEvent.click(launcher)
  screen.getByRole('dialog', { name: 'Harness 助理' })
  fireEvent.change(screen.getByRole('textbox', { name: '给助理发消息' }), { target: { value: '归档 Router' } })
  fireEvent.click(screen.getByRole('button', { name: '发送给助理' }))
  fireEvent.click(await screen.findByRole('button', { name: '归档Router 调研' }))
  expect(onMutate).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '确认归档' }))
  await waitFor(() => expect(onMutate).toHaveBeenCalledWith(session, 'archive'))
  await screen.findByText('已归档「Router 调研」。')
  expect(screen.queryByRole('button', { name: '归档Router 调研' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '关闭 Harness 助理' }))
  expect(document.activeElement).toBe(launcher)
})

it('keeps a failed operation visible and offers a retry', async () => {
  const onMutate = vi.fn().mockRejectedValue(new Error('会话仍在运行'))
  render(<HarnessAssistant sendShortcut="mod-enter" disabled={false} pinned={[]} onMutate={onMutate} />)
  fireEvent.click(screen.getByRole('button', { name: '助理' }))
  fireEvent.click(screen.getByRole('button', { name: '最近会话' }))
  fireEvent.click(await screen.findByRole('button', { name: '置顶Router 调研' }))
  fireEvent.click(screen.getByRole('button', { name: '确认置顶' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: '置顶Router 调研' })).toBeDefined()
})


it('uses the shared multiline composer and honors the Harness send shortcut', async () => {
  vi.mocked(interpretSessionRequest).mockResolvedValue({ action: 'list', provider: 'all', scope: 'active', query: '', recentDays: null, previousRows: [] })
  render(<HarnessAssistant sendShortcut="mod-enter" disabled={false} pinned={[]} onMutate={vi.fn()} />)
  const launcher = screen.getByRole('button', { name: '助理' })
  fireEvent.click(launcher)
  const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '给助理发消息' })
  expect(input.tagName).toBe('TEXTAREA')
  expect(document.activeElement).toBe(input)
  const message = '查一下 Router 会话\n只看最近一周'
  fireEvent.change(input, { target: { value: message } })
  fireEvent.keyDown(input, { key: 'Enter' })
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, isComposing: true })
  expect(interpretSessionRequest).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: '添加图片或文件' })).toBeNull()
  expect(screen.queryByRole('combobox')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: '关闭 Harness 助理' }))
  fireEvent.click(launcher)
  expect(input.value).toBe(message)
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
  await waitFor(() => expect(interpretSessionRequest).toHaveBeenCalledExactlyOnceWith(message, []))
  expect(input.value).toBe('')
})

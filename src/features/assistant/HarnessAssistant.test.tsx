// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { emptyThreadDetail, textInput, type Thread, type Turn } from '../../core/domain/codex'
import { runtime } from '../../core/runtime/bridge'
import { defaultKeyboardPreferences } from '../conversation/harnessBootstrap'
import { HarnessAssistant } from './HarnessAssistant'
import { queryAssistantSessions, type AssistantSession, type SessionRequest } from './sessionAssistant'

vi.mock('./sessionAssistant', async importOriginal => ({
  ...await importOriginal<typeof import('./sessionAssistant')>(),
  queryAssistantSessions: vi.fn(),
}))
vi.mock('../../core/runtime/bridge', () => ({
  runtime: {
    getAppState: vi.fn().mockResolvedValue(null),
    chooseComposerFiles: vi.fn().mockResolvedValue(['/example.txt']),
  },
}))
const session: AssistantSession = { id: 'test', title: 'Router 调研', cwd: '/work/router', provider: 'codex', updatedAt: 0, archived: false }
const thread: Thread = {
  id: 'assistant', cwd: '/assistant', name: null, preview: '', ephemeral: true, createdAt: 0, updatedAt: 0, recencyAt: null,
  status: { type: 'idle' }, canAcceptDirectInput: true,
}
const request: SessionRequest = { action: 'archive', provider: 'codex', scope: 'active', query: 'Router', recentDays: null, referenceIds: [] }
const settings = { model: 'test', effort: 'high', serviceTier: null, approvalPolicy: 'never' as const, approvalsReviewer: 'user' as const, sandboxMode: 'danger-full-access' as const }

function fixture(): ComponentProps<typeof HarnessAssistant> {
  return {
    disabled: false, pinned: [], onMutate: vi.fn().mockResolvedValue(undefined),
    harness: {
      assistantThread: {
        submitting: false,
        create: vi.fn().mockResolvedValue(thread.id), send: vi.fn().mockResolvedValue(undefined), stop: vi.fn(),
        removeQueue: vi.fn(), promoteQueue: vi.fn(), startQueue: vi.fn(),
      },
      details: { [thread.id]: emptyThreadDetail(thread) },
      busy: {}, keyboard: defaultKeyboardPreferences, pendingSteers: {}, queues: {}, threadTokenUsages: {}, workingThreadIds: {},
      setFollowUpMode: vi.fn(),
    },
    codex: {
      models: [], loading: false, settingsForThread: () => settings,
      syncThreadSettings: vi.fn(), updateThreadSettings: vi.fn().mockResolvedValue(undefined),
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
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

it('uses a model result to suggest the operation and waits for explicit confirmation', async () => {
  const props = fixture()
  const { rerender } = render(<HarnessAssistant {...props} />)
  const launcher = screen.getByRole('button', { name: '助理' })
  fireEvent.click(launcher)
  const input = await screen.findByRole('textbox', { name: '给助理发消息' })
  fireEvent.change(input, { target: { value: '归档 Router' } })
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
  await waitFor(() => expect(props.harness.assistantThread.send).toHaveBeenCalledExactlyOnceWith(thread.id, [
    textInput('归档 Router'), textInput('界面会话引用：[]'),
  ], 'interject', []))
  const turn: Turn = { id: 'turn', status: 'completed', error: null, startedAt: 1, completedAt: 2, durationMs: 1, items: [
    { id: 'result', type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(request) },
  ] }
  rerender(<HarnessAssistant {...props} harness={{ ...props.harness, details: { [thread.id]: { ...emptyThreadDetail(thread), turns: [turn] } } }} />)
  fireEvent.click(await screen.findByRole('button', { name: '归档Router 调研' }))
  expect(props.onMutate).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '确认归档' }))
  await waitFor(() => expect(props.onMutate).toHaveBeenCalledExactlyOnceWith(session, 'archive'))
  await screen.findByText('已归档「Router 调研」。')
  fireEvent.click(screen.getByRole('button', { name: '关闭 Harness 助理' }))
  expect(document.activeElement).toBe(launcher)
})

it('shares the composer controls and passes attachments to the assistant conversation', async () => {
  const props = fixture()
  render(<HarnessAssistant {...props} />)
  const launcher = screen.getByRole('button', { name: '助理' })
  fireEvent.click(launcher)
  const input = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: '给助理发消息' })
  expect(input.tagName).toBe('TEXTAREA')
  expect(document.activeElement).toBe(input)
  expect(screen.getByRole('combobox', { name: '模型' })).toBeDefined()
  expect(screen.getByLabelText('等待 App Server 提供上下文窗口用量')).toBeDefined()
  expect(screen.queryByRole('button', { name: '切换 YOLO 模式' })).toBeNull()
  const message = '查一下 Router 会话\n只看最近一周'
  fireEvent.change(input, { target: { value: message } })
  fireEvent.keyDown(input, { key: 'Enter' })
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, isComposing: true })
  expect(props.harness.assistantThread.send).not.toHaveBeenCalled()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '添加图片或文件' })) })
  expect(runtime.chooseComposerFiles).toHaveBeenCalled()
  expect(screen.getByText('example.txt')).toBeDefined()
  fireEvent.contextMenu(screen.getByRole('button', { name: '发送消息' }))
  expect(screen.getByRole('menu')).toBeDefined()
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  fireEvent.click(screen.getByRole('button', { name: '关闭 Harness 助理' }))
  fireEvent.click(launcher)
  expect(input.value).toBe(message)
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
  await waitFor(() => expect(props.harness.assistantThread.send).toHaveBeenCalledTimes(1))
  expect(vi.mocked(props.harness.assistantThread.send).mock.calls[0][1][0]).toMatchObject({ type: 'text', text: expect.stringContaining('/example.txt') })
  expect(props.harness.assistantThread.create).toHaveBeenCalledTimes(1)
  await waitFor(() => expect(input.value).toBe(''))
})


it('sends working-turn input using the selected interject or queue mode', async () => {
  const props = fixture()
  const runningHarness = { ...props.harness, workingThreadIds: { [thread.id]: true } }
  const { rerender } = render(<HarnessAssistant {...props} harness={runningHarness} />)
  fireEvent.click(screen.getByRole('button', { name: '助理' }))
  const input = await screen.findByRole('textbox', { name: '给助理发消息' })
  fireEvent.change(input, { target: { value: '只看今天' } })
  fireEvent.click(screen.getByRole('button', { name: '插话' }))
  await waitFor(() => expect(props.harness.assistantThread.send).toHaveBeenLastCalledWith(thread.id, expect.any(Array), 'interject', []))
  rerender(<HarnessAssistant {...props} harness={{ ...runningHarness, keyboard: { ...runningHarness.keyboard, followUpMode: 'queue' } }} />)
  fireEvent.change(input, { target: { value: '查一下置顶会话' } })
  fireEvent.click(screen.getByRole('button', { name: '排队消息' }))
  await waitFor(() => expect(props.harness.assistantThread.send).toHaveBeenLastCalledWith(thread.id, expect.any(Array), 'queue', []))
})

it('keeps a scheduled assistant send alive after the dialog closes', async () => {
  const props = fixture()
  render(<HarnessAssistant {...props} />)
  fireEvent.click(screen.getByRole('button', { name: '助理' }))
  const input = await screen.findByRole('textbox', { name: '给助理发消息' })
  vi.useFakeTimers()
  try {
    fireEvent.change(input, { target: { value: '稍后整理会话' } })
    fireEvent.contextMenu(screen.getByRole('button', { name: '发送消息' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /1 分钟/ }))
    fireEvent.click(screen.getByRole('button', { name: '关闭 Harness 助理' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(59_999) })
    expect(props.harness.assistantThread.send).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(props.harness.assistantThread.send).toHaveBeenCalledExactlyOnceWith(thread.id, [
      textInput('稍后整理会话'), textInput('界面会话引用：[]'),
    ], 'interject', [])
  } finally {
    vi.useRealTimers()
  }
})

it('drags from the title bar, stays inside the viewport, and keeps the position when reopened', async () => {
  render(<HarnessAssistant {...fixture()} />)
  const launcher = screen.getByRole('button', { name: '助理' })
  fireEvent.click(launcher)
  await screen.findByRole('textbox', { name: '给助理发消息' })
  const floatingWindow = screen.getByRole<HTMLDialogElement>('dialog', { name: 'Harness 助理' })
  const titlebar = screen.getByRole('heading', { name: 'Harness 助理' }).closest('header')!
  const capture = vi.fn()
  Object.defineProperty(floatingWindow, 'setPointerCapture', { value: capture })
  vi.spyOn(floatingWindow, 'getBoundingClientRect').mockReturnValue(new DOMRect(420, 170, 510, 560))

  const closeButton = screen.getByRole('button', { name: '关闭 Harness 助理' })
  fireEvent.pointerDown(closeButton, { pointerId: 7, button: 0, clientX: 900, clientY: 195 })
  expect(capture).not.toHaveBeenCalled()

  fireEvent.pointerDown(titlebar, { pointerId: 7, button: 0, clientX: 470, clientY: 195 })
  expect(capture).toHaveBeenCalledExactlyOnceWith(7)
  fireEvent.pointerMove(titlebar, { pointerId: 7, clientX: 230, clientY: 120 })
  expect(floatingWindow.style.left).toBe('180px')
  expect(floatingWindow.style.top).toBe('95px')

  fireEvent.pointerMove(titlebar, { pointerId: 7, clientX: window.innerWidth + 150, clientY: 0 })
  expect(floatingWindow.style.left).toBe(`${window.innerWidth - 510}px`)
  expect(floatingWindow.style.top).toBe('0px')
  fireEvent.lostPointerCapture(floatingWindow, { pointerId: 7 })
  fireEvent.click(floatingWindow, { clientX: 0, clientY: 0 })
  expect(floatingWindow.open).toBe(true)
  fireEvent.pointerMove(titlebar, { pointerId: 7, clientX: 310, clientY: 160 })
  expect(floatingWindow.style.left).toBe(`${window.innerWidth - 510}px`)

  fireEvent.click(closeButton)
  fireEvent.click(launcher)
  expect(floatingWindow.style.left).toBe(`${window.innerWidth - 510}px`)
  expect(floatingWindow.style.top).toBe('0px')
})

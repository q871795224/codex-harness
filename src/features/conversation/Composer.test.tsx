// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Composer, type ComposerDraft } from './Composer'
import { expandCollapsedPastes } from './composerInput'

afterEach(cleanup)
const props = {
  disabled: false, working: false, foreignActive: false, busy: false, contextUsage: null,
  workspaceRoot: null, sendShortcut: 'enter' as const, focusRequest: 0, models: [],
  settings: { model: 'test', effort: 'high', serviceTier: null, approvalPolicy: 'never' as const, approvalsReviewer: 'user' as const, sandboxMode: 'danger-full-access' as const },
  rawMode: false, followUpMode: 'queue' as const, onSettingsChange: vi.fn(), onFollowUpModeChange: vi.fn(), onSend: vi.fn(), onCommand: vi.fn(), onStop: vi.fn(),
}
it('highlights the project label, separates the prompt and positions the caret without duplicating newlines on refresh', () => {
  let draft: ComposerDraft | undefined
  const card = { projectId: 'one', name: '项目', seq: 1, content: '背景正文' }
  const onDraftChange = (next: ComposerDraft) => { draft = next }
  const dismissed = vi.fn()
  const { rerender, container } = render(<Composer {...props} projectCard={card} initialDraft={{ text: '我的问题', collapsedPastes: [], attachments: [] }} onDraftChange={onDraftChange} onProjectCardDismissed={dismissed} />)
  const input = screen.getByPlaceholderText('给 Codex 发送消息') as HTMLTextAreaElement
  expect(input.value).toBe('[项目: 项目 (seq 1)]\n我的问题')
  expect(input.selectionStart).toBe(input.value.indexOf('\n') + 1)
  expect(container.querySelector('.composer-project-label')?.textContent).toBe('[项目: 项目 (seq 1)]')
  expect(expandCollapsedPastes(draft!.text, draft!.collapsedPastes)).toBe('背景正文\n我的问题')
  rerender(<Composer {...props} projectCard={{ ...card, seq: 2 }} onDraftChange={onDraftChange} onProjectCardDismissed={dismissed} />)
  expect(input.value).toBe('[项目: 项目 (seq 2)]\n我的问题')
  expect(dismissed).not.toHaveBeenCalled()
  fireEvent.change(input, { target: { value: '我的问题' } })
  expect(dismissed).toHaveBeenCalled()
})

it('consumes the sent project card without dismissing its binding while the pending spec remains', async () => {
  const dismissed = vi.fn()
  let finish!: () => void
  const onSend = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
  render(<Composer {...props} projectCard={{ projectId: 'one', name: '项目', seq: 1, content: '背景正文' }} onSend={onSend} onProjectCardDismissed={dismissed} />)
  const input = screen.getByPlaceholderText('给 Codex 发送消息') as HTMLTextAreaElement
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(onSend).toHaveBeenCalledTimes(1)
  expect(input.value).toContain('[项目:')
  expect(input.disabled).toBe(true)
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(onSend).toHaveBeenCalledTimes(1)
  await act(async () => { finish() })
  expect(input.value).toBe('')
  expect(dismissed).not.toHaveBeenCalled()
})

it('keeps the project draft and binding when sending fails', async () => {
  const dismissed = vi.fn()
  render(<Composer {...props} projectCard={{ projectId: 'one', name: '项目', seq: 1, content: '背景正文' }} onSend={vi.fn().mockRejectedValue(new Error('send failed'))} onProjectCardDismissed={dismissed} />)
  const input = screen.getByPlaceholderText('给 Codex 发送消息') as HTMLTextAreaElement
  await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
  expect(input.value).toContain('[项目:')
  expect(dismissed).not.toHaveBeenCalled()
})

it('does not dismiss on programmatic removal, but does dismiss when pasting over the card', () => {
  const dismissed = vi.fn()
  const card = { projectId: 'one', name: '项目', seq: 1, content: '背景正文' }
  const { rerender } = render(<Composer {...props} projectCard={card} onProjectCardDismissed={dismissed} />)
  rerender(<Composer {...props} projectCard={null} onProjectCardDismissed={dismissed} />)
  expect(dismissed).not.toHaveBeenCalled()
  rerender(<Composer {...props} projectCard={card} onProjectCardDismissed={dismissed} />)
  const input = screen.getByPlaceholderText('给 Codex 发送消息') as HTMLTextAreaElement
  input.setSelectionRange(0, input.value.length)
  fireEvent.paste(input, { clipboardData: { types: ['text/plain'], getData: () => 'replacement\n'.repeat(200) } })
  expect(dismissed).toHaveBeenCalledTimes(1)
})

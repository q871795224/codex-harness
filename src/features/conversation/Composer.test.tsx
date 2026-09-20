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

it('tracks only picker-selected files through the draft, highlight and send paths', async () => {
  const { appServer } = await import('../../core/runtime/appServerClient')
  const search = vi.spyOn(appServer, 'fuzzyFileSearch').mockResolvedValue({ files: [{ root: '/repo', path: 'dir/文件.txt', file_name: '文件.txt', match_type: 'file' }] })
  const onSend = vi.fn().mockResolvedValue(undefined)
  let draft: ComposerDraft | undefined
  const { container } = render(<Composer {...props} workspaceRoot="/repo" onSend={onSend} onDraftChange={(value) => { draft = value }} />)
  const input = screen.getByPlaceholderText('给 Codex 发送消息') as HTMLTextAreaElement
  fireEvent.change(input, { target: { value: '手写 dir/文件.txt @文件', selectionStart: 17 } })
  const option = await screen.findByRole('option', { name: /文件.txt/ })
  await act(async () => { fireEvent.click(option) })
  expect(input.value).toBe('手写 dir/文件.txt [文件.txt] ')
  expect(container.querySelectorAll('.composer-reference-label')).toHaveLength(1)
  expect(draft?.collapsedPastes[0].reference?.path).toBe('/repo/dir/文件.txt')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '发送消息' })) })
  expect(onSend.mock.calls[0][0]).toEqual([{ type: 'text', text: '手写 dir/文件.txt dir/文件.txt', text_elements: [] }])
  expect(onSend.mock.calls[0][2]).toEqual([{ kind: 'file', start: 14, end: 24, path: '/repo/dir/文件.txt' }])
  search.mockRestore()
})

it('removing a selected Skill leaves a manually typed marker plain and sends no skill attachment', async () => {
  const onSend = vi.fn().mockResolvedValue(undefined)
  const selected = { start: 0, end: 5, label: '$demo', content: '$demo', reference: { kind: 'skill' as const, name: 'demo', path: '/skill/SKILL.md' } }
  render(<Composer {...props} onSend={onSend} initialDraft={{ text: '$demo manual $demo', collapsedPastes: [selected], attachments: [{ kind: 'skill', name: 'demo', path: '/skill/SKILL.md' }] }} />)
  const input = screen.getByPlaceholderText('给 Codex 发送消息')
  fireEvent.change(input, { target: { value: 'manual $demo' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '发送消息' })) })
  expect(onSend.mock.calls[0][0]).toEqual([{ type: 'text', text: 'manual $demo', text_elements: [] }])
})

it('colors selected local commands and pasted blocks while keeping local command execution', async () => {
  const onCommand = vi.fn()
  const onSend = vi.fn()
  const { container } = render(<Composer {...props} onCommand={onCommand} onSend={onSend} />)
  const input = screen.getByPlaceholderText('给 Codex 发送消息') as HTMLTextAreaElement
  fireEvent.change(input, { target: { value: '/raw', selectionStart: 4 } })
  fireEvent.click(screen.getByRole('option', { name: /raw/ }))
  expect(container.querySelector('.composer-reference-label')?.textContent).toBe('/raw')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '发送消息' })) })
  expect(onCommand).toHaveBeenCalledWith({ name: 'raw' })
  expect(onSend).not.toHaveBeenCalled()
  fireEvent.paste(input, { clipboardData: { types: ['text/plain'], getData: () => 'long paste\n'.repeat(200) } })
  expect(container.querySelector('.composer-reference-label')?.textContent).toContain('[Pasted Content')
})

it('deletes the selected occurrence atomically when two files have identical names', () => {
  let draft: ComposerDraft | undefined
  const makeFile = (start: number, path: string) => ({ start, end: start + 6, label: '[a.ts]', content: path, reference: { kind: 'file' as const, name: 'a.ts', path } })
  render(<Composer {...props} initialDraft={{ text: '[a.ts] [a.ts]', attachments: [], collapsedPastes: [makeFile(0, '/first/a.ts'), makeFile(7, '/second/a.ts')] }} onDraftChange={(value) => { draft = value }} />)
  const input = screen.getByPlaceholderText('给 Codex 发送消息') as HTMLTextAreaElement
  input.setSelectionRange(6, 6)
  fireEvent.keyDown(input, { key: 'Backspace' })
  expect(input.value).toBe(' [a.ts]')
  expect(draft?.collapsedPastes).toHaveLength(1)
  expect(draft?.collapsedPastes[0].reference?.path).toBe('/second/a.ts')
  expect(expandCollapsedPastes(draft!.text, draft!.collapsedPastes)).toBe(' /second/a.ts')
})

it('replaces the selected command label when completing an argument without overlapping tags', () => {
  let draft: ComposerDraft | undefined
  const { container } = render(<Composer {...props} onDraftChange={(value) => { draft = value }} />)
  const input = screen.getByPlaceholderText('给 Codex 发送消息') as HTMLTextAreaElement
  fireEvent.change(input, { target: { value: '/permissions', selectionStart: 12 } })
  fireEvent.click(screen.getByRole('option', { name: /permissions/ }))
  fireEvent.click(screen.getByRole('option', { name: /Never.*审批策略/ }))
  expect(input.value).toBe('/permissions never ')
  expect(draft?.collapsedPastes).toHaveLength(1)
  expect(container.querySelector('.composer-reference-label')?.textContent).toBe('/permissions never')
})

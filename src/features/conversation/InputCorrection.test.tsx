// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Composer, type ComposerDraft } from './Composer'
const { settings, addReplacement } = vi.hoisted(() => ({ settings: { enabled: true, quotes: true, rules: [{ from: '绘画', to: '会话' }, { from: '哈尼斯', to: 'Harness' }] }, addReplacement: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../core/input-correction/settings', () => ({ useCorrectionSettings: () => settings, loadCorrectionSettings: vi.fn().mockResolvedValue(undefined), addReplacement }))
const props = {
  disabled: false, working: false, foreignActive: false, busy: false, contextUsage: null,
  workspaceRoot: null, sendShortcut: 'enter' as const, focusRequest: 0, models: [],
  settings: { model: 'test', effort: 'high', serviceTier: null, approvalPolicy: 'never' as const, approvalsReviewer: 'user' as const, sandboxMode: 'danger-full-access' as const },
  rawMode: false, followUpMode: 'queue' as const, onSettingsChange: vi.fn(), onFollowUpModeChange: vi.fn(), onSend: vi.fn(), onCommand: vi.fn(), onStop: vi.fn(),
}
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks() })
afterEach(() => { cleanup(); vi.useRealTimers() })
async function settle() { await act(async () => { vi.advanceTimersByTime(650) }) }
const input = () => screen.getByPlaceholderText('给 Codex 发送消息') as HTMLTextAreaElement
it('shows only the generic notice and undoes all corrections while retaining later typing', async () => {
  await act(async () => { render(<Composer {...props} />) })
  fireEvent.change(input(), { target: { value: '哈尼斯绘画绘画' } })
  await settle()
  expect(input().value).toBe('Harness会话会话')
  expect(screen.getByText('已自动纠正')).toBeTruthy()
  expect(screen.queryByText('绘画 → 会话')).toBeNull()
  fireEvent.change(input(), { target: { value: input().value + '，继续' } })
  fireEvent.click(screen.getByRole('button', { name: '撤回' }))
  expect(input().value).toBe('哈尼斯绘画绘画，继续')
  await settle()
  expect(input().value).toBe('哈尼斯绘画绘画，继续')
  fireEvent.change(input(), { target: { value: input().value + '输入' } })
  await settle()
  expect(input().value).toBe('哈尼斯绘画绘画，继续输入')
})
it('waits for composition to end', async () => {
  await act(async () => { render(<Composer {...props} />) })
  fireEvent.compositionStart(input())
  fireEvent.change(input(), { target: { value: '绘画' } })
  await settle()
  expect(input().value).toBe('绘画')
  fireEvent.compositionEnd(input())
  await settle()
  expect(input().value).toBe('会话')
})
it('preserves every correction across successive batches and supports quote continuation', async () => {
  await act(async () => { render(<Composer {...props} />) })
  fireEvent.change(input(), { target: { value: '打开”绘画' } })
  await settle()
  expect(input().value).toBe('打开“会话')
  fireEvent.change(input(), { target: { value: '哈尼斯' + input().value } })
  fireEvent.change(input(), { target: { value: input().value + '”' } })
  await settle()
  expect(input().value).toBe('Harness打开“会话”')
  fireEvent.click(screen.getByRole('button', { name: '撤回' }))
  expect(input().value).toBe('哈尼斯打开”绘画”')
})
it('does not correct pasted text when more words are typed later', async () => {
  await act(async () => { render(<Composer {...props} />) })
  fireEvent.paste(input(), { clipboardData: { types: ['text/plain'], getData: () => '绘画' } })
  fireEvent.change(input(), { target: { value: '绘画' } })
  await settle()
  fireEvent.change(input(), { target: { value: '绘画，然后哈尼斯' } })
  await settle()
  expect(input().value).toBe('绘画，然后Harness')
})
it('keeps file reference ranges valid through different-length replacements and undo', async () => {
  let draft: ComposerDraft | undefined
  await act(async () => { render(<Composer {...props} initialDraft={{ text: '哈尼斯[文件]绘画', attachments: [], collapsedPastes: [{ label: '[文件]', content: '/tmp/a', start: 3, end: 7, reference: { kind: 'file', path: '/tmp/a', name: '文件' } }] }} onDraftChange={(value) => { draft = value }} />) })
  fireEvent.change(input(), { target: { value: '哈尼斯[文件]绘画。' } })
  await settle()
  expect(input().value).toBe('Harness[文件]会话。')
  expect(draft?.collapsedPastes[0].start).toBe(7)
  fireEvent.click(screen.getByRole('button', { name: '撤回' }))
  expect(input().value).toBe('哈尼斯[文件]绘画。')
  expect(draft?.collapsedPastes[0].start).toBe(3)
})
it('saves feedback without submitting a chat message and respects IME confirmation', async () => {
  await act(async () => { render(<Composer {...props} />) })
  const feedback = screen.getByRole('textbox', { name: '纠正反馈' })
  fireEvent.change(feedback, { target: { value: '绘画 → 会话' } })
  fireEvent.keyDown(feedback, { key: 'Enter', isComposing: true, keyCode: 229 })
  expect(addReplacement).not.toHaveBeenCalled()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
  expect(addReplacement).toHaveBeenCalledWith('绘画 → 会话')
  expect(props.onSend).not.toHaveBeenCalled()
})
it('marks each corrected occurrence, shows its original on hover and removes marks after undo', async () => {
  const { container } = await act(async () => render(<Composer {...props} />))
  fireEvent.change(input(), { target: { value: '哈尼斯绘画绘画' } })
  await settle()
  const marks = container.querySelectorAll<HTMLElement>('.composer-corrected-text')
  expect([...marks].map((mark) => [mark.textContent, mark.dataset.correctionOriginal])).toEqual([['Harness', '哈尼斯'], ['会话', '绘画'], ['会话', '绘画']])
  // A word may wrap onto two visual lines; both rectangles must be hoverable.
  vi.spyOn(marks[1], 'getClientRects').mockReturnValue([{ left: 80, right: 100, top: 20, bottom: 44 }, { left: 0, right: 20, top: 44, bottom: 68 }] as unknown as DOMRectList)
  fireEvent.mouseMove(input(), { clientX: 10, clientY: 50 })
  expect(screen.getByRole('tooltip', { name: '纠正前的原文' }).textContent).toBe('原文：绘画')
  fireEvent.scroll(input())
  expect(screen.queryByRole('tooltip', { name: '纠正前的原文' })).toBeNull()
  fireEvent.mouseMove(input(), { clientX: 90, clientY: 30 })
  expect(screen.getByRole('tooltip', { name: '纠正前的原文' }).textContent).toBe('原文：绘画')
  fireEvent.mouseDown(input())
  expect(screen.queryByRole('tooltip', { name: '纠正前的原文' })).toBeNull()
  expect(input().value).toBe('Harness会话会话')
  fireEvent.click(screen.getByRole('button', { name: '撤回' }))
  expect(container.querySelectorAll('.composer-corrected-text').length).toBe(0)
})
it('keeps highlight positions after typing and drops the mark when corrected text is manually edited', async () => {
  const { container } = await act(async () => render(<Composer {...props} />))
  fireEvent.change(input(), { target: { value: '绘画' } })
  await settle()
  fireEvent.change(input(), { target: { value: '前缀会话' } })
  expect(container.querySelector('.composer-corrected-text')?.textContent).toBe('会话')
  fireEvent.change(input(), { target: { value: '前缀对话' } })
  expect(container.querySelector('.composer-corrected-text')).toBeNull()
  expect(container.querySelector('.has-corrections')).toBeNull()
})

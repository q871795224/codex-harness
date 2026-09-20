import { describe, expect, it } from 'vitest'
import { composerSubmission, insertCollapsedPaste, reconcileCollapsedPastes, type CollapsedPaste } from './composerInput'
import { restoreComposerDrafts, storedComposerDraft } from './composerDraftStorage'

function file(text: string, start: number, label = '[文件.txt]'): CollapsedPaste {
  return { start, end: start + label.length, label, content: text, reference: { kind: 'file', name: '文件.txt', path: `/repo/${text}` } }
}

describe('selected references', () => {
  it('keeps manual paths plain and sends selected paths without UI labels or mention', () => {
    const text = ' 手写 dir/文件.txt 看 [文件.txt] '
    const selected = file('dir/文件.txt', text.indexOf('['))
    const result = composerSubmission(text, [selected], [])
    expect(result.input).toEqual([{ type: 'text', text: '手写 dir/文件.txt 看 dir/文件.txt', text_elements: [] }])
    expect(result.references).toEqual([{ kind: 'file', start: 16, end: 26, path: '/repo/dir/文件.txt' }])
  })

  it('rebases selected files across Chinese text, duplicate labels, and long paste expansion', () => {
    const text = '[文件.txt] 和 [文件.txt]'
    const pastes = [file('a/文件.txt', 0), file('空 格/文件.txt', text.lastIndexOf('['))]
    const edit = insertCollapsedPaste(text, 0, 0, '😀背景\n'.repeat(220), pastes)
    const { input, references } = composerSubmission(edit.text, edit.pastes, [])
    const body = input.find((item) => item.type === 'text')!
    expect(body.text_elements).toEqual([])
    expect(references.map((reference) => body.text.slice(reference.start, reference.end))).toEqual(['😀背景\n'.repeat(220), 'a/文件.txt', '空 格/文件.txt'])
    expect(references.map((reference) => reference.kind)).toEqual(['paste', 'file', 'file'])
  })

  it('drops selection metadata when editing or deleting a label, and never recognizes typed replacements', () => {
    const before = '[文件.txt] manual'
    expect(reconcileCollapsedPastes(before, '[文件.md] manual', [file('dir/文件.txt', 0)])).toEqual([])
    expect(composerSubmission('/repo/文件.txt', [], []).references).toEqual([])
  })

  it('uses byte ranges for the selected Skill occurrence only', () => {
    const text = '😀 $demo 手写 $demo'
    const start = text.indexOf('$')
    const paste: CollapsedPaste = { start, end: start + 5, label: '$demo', content: '$demo', reference: { kind: 'skill', name: 'demo', path: '/skills/demo/SKILL.md' } }
    const result = composerSubmission(text, [paste], [{ kind: 'skill', name: 'demo', path: '/skills/demo/SKILL.md' }])
    expect(result.input).toEqual([
      { type: 'text', text, text_elements: [{ byteRange: { start: 5, end: 10 }, placeholder: '$demo' }] },
      { type: 'skill', name: 'demo', path: '/skills/demo/SKILL.md' },
    ])
    expect(result.references).toHaveLength(1)
  })

  it('sends CLI image placeholders and preserves image ordering with files and Skills', () => {
    const { input, references } = composerSubmission('$demo', [{ start: 0, end: 5, content: '$demo', label: '$demo', reference: { kind: 'skill', name: 'demo', path: '/skills/demo/SKILL.md' } }], [
      { kind: 'image', name: 'a.png', path: '/tmp/a.png' },
      { kind: 'image', name: 'b.png', path: '/tmp/b.png' },
      { kind: 'file', name: 'a.txt', path: '/tmp/a.txt' },
      { kind: 'skill', name: 'demo', path: '/skills/demo/SKILL.md' },
    ])
    const body = input.find((item) => item.type === 'text')!
    expect(body).toEqual({ type: 'text', text: '[Image #1] [Image #2] $demo\n/tmp/a.txt', text_elements: [
      { byteRange: { start: 0, end: 10 }, placeholder: '[Image #1]' },
      { byteRange: { start: 11, end: 21 }, placeholder: '[Image #2]' },
      { byteRange: { start: 22, end: 27 }, placeholder: '$demo' },
    ] })
    expect(references.map((reference) => body.text.slice(reference.start, reference.end))).toEqual(['[Image #1]', '[Image #2]', '$demo', '/tmp/a.txt'])
  })

  it('round-trips reference selections in drafts without changing long paste contents', () => {
    const draft = { text: '[文件.txt]', attachments: [], collapsedPastes: [file('dir/文件.txt', 0)] }
    expect(restoreComposerDrafts([{ conversationId: 'one', draft: storedComposerDraft(draft), updatedAt: 0 }])).toEqual({ one: draft })
    const edit = insertCollapsedPaste('', 0, 0, '\nlong paste\n', [])
    expect(composerSubmission(edit.text, edit.pastes, []).input).toEqual([{ type: 'text', text: '\nlong paste\n', text_elements: [] }])
  })
})

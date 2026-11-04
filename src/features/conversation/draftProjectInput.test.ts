import { expect, it } from 'vitest'
import { textInput } from '../../core/domain/codex'
import { retargetDraftProjectInput } from './draftProjectInput'
it('retargets a bound project marker and preserves UTF-8 input elements and UTF-16 display references', () => {
  const marker = '<!-- project-doc: project_id=project thread_id=old -->'
  const prefix = `中文 ${marker}\n`
  const text = `${prefix}附件.txt`
  const byteStart = new TextEncoder().encode(prefix).length
  const input = [{ ...textInput(text), text_elements: [{ byteRange: { start: byteStart, end: byteStart + 10 }, placeholder: 'file' }] }]
  const result = retargetDraftProjectInput(input, [{ kind: 'file', start: prefix.length, end: text.length, path: '/附件.txt' }], 'project', 'old', 'replacement')
  expect(result.input[0]).toEqual({ ...input[0], text: text.replace('thread_id=old', 'thread_id=replacement'), text_elements: [{ byteRange: { start: byteStart + 8, end: byteStart + 18 }, placeholder: 'file' }] })
  expect(result.references).toEqual([{ kind: 'file', start: prefix.length + 8, end: text.length + 8, path: '/附件.txt' }])
})
it('does not rewrite user text with a different project identity', () => {
  const input = [textInput('<!-- project-doc: project_id=other thread_id=old -->')]
  expect(retargetDraftProjectInput(input, [], 'project', 'old', 'new').input).toEqual(input)
})

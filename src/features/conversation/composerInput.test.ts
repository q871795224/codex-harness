import { describe, expect, it } from 'vitest'
import {
  LONG_PASTE_THRESHOLD,
  absoluteMentionPath,
  activeComposerTrigger,
  clipboardHasImage,
  composerInputs,
  composerTextInput,
  expandCollapsedPastes,
  hasSkillMarker,
  insertComposerPrompt,
  insertCollapsedPaste,
  isSupportedImagePath,
  matchesSendShortcut,
  pastedCharacterCount,
  reconcileCollapsedPastes,
  reasoningEffortTone,
  replaceComposerTrigger,
  shouldCollapsePaste,
} from './composerInput'

describe('image attachments', () => {
  it('detects clipboard image data ahead of plain text paste handling', () => {
    expect(clipboardHasImage({ items: [{ type: 'text/plain' }, { type: 'image/png' }] })).toBe(true)
    expect(clipboardHasImage({ files: [{ type: 'image/jpeg' }] })).toBe(true)
    expect(clipboardHasImage({ items: [{ type: 'text/plain' }] })).toBe(false)
  })

  it('matches the image formats supported by the Codex CLI attachment flow', () => {
    expect(isSupportedImagePath('/tmp/screenshot.PNG')).toBe(true)
    expect(isSupportedImagePath('/tmp/photo.jpeg')).toBe(true)
    expect(isSupportedImagePath('/tmp/animation.gif')).toBe(true)
    expect(isSupportedImagePath('/tmp/mock.webp')).toBe(true)
    expect(isSupportedImagePath('/tmp/photo.heic')).toBe(false)
    expect(isSupportedImagePath('/tmp/image.png.txt')).toBe(false)
  })

  it('sends local images before text and structured references like the CLI', () => {
    expect(composerInputs(' inspect ', [
      { kind: 'file', name: 'README.md', path: '/repo/README.md' },
      { kind: 'image', name: 'shot.png', path: '/tmp/shot.png' },
      { kind: 'skill', name: 'tdd', path: '/skills/tdd/SKILL.md' },
    ])).toEqual([
      { type: 'localImage', path: '/tmp/shot.png' },
      { type: 'text', text: 'inspect', text_elements: [] },
      { type: 'mention', name: 'README.md', path: '/repo/README.md' },
      { type: 'skill', name: 'tdd', path: '/skills/tdd/SKILL.md' },
    ])
  })
})

describe('reasoningEffortTone', () => {
  it('maps supported and future effort names onto the visual scale', () => {
    expect(reasoningEffortTone('low')).toBe('low')
    expect(reasoningEffortTone('medium')).toBe('medium')
    expect(reasoningEffortTone('high')).toBe('high')
    expect(reasoningEffortTone('xhigh')).toBe('xhigh')
    expect(reasoningEffortTone('max')).toBe('max')
    expect(reasoningEffortTone('ultra')).toBe('ultra')
  })
})

describe('activeComposerTrigger', () => {
  it('finds file and skill triggers at the cursor', () => {
    expect(activeComposerTrigger('检查 @src/App', 11)).toEqual({ kind: 'file', query: 'src/App', start: 3, end: 11 })
    expect(activeComposerTrigger('$tdd 修复', 4)).toEqual({ kind: 'skill', query: 'tdd', start: 0, end: 4 })
    expect(activeComposerTrigger('/model gpt-5', 12)).toEqual({ kind: 'command', query: 'model gpt-5', start: 0, end: 12 })
  })

  it('ignores completed markers and embedded email-like text', () => {
    expect(activeComposerTrigger('检查 @src/App 后续', 14)).toBeNull()
    expect(activeComposerTrigger('name@example.com', 16)).toBeNull()
  })

  it('replaces only the active token and returns the next cursor', () => {
    const trigger = activeComposerTrigger('使用 $td', 6)
    expect(trigger && replaceComposerTrigger('使用 $td', trigger, '$tdd')).toEqual({ text: '使用 $tdd ', cursor: 8 })
    const fileTrigger = activeComposerTrigger('检查 @App 后续', 7)
    expect(fileTrigger && replaceComposerTrigger('检查 @App 后续', fileTrigger, '')).toEqual({ text: '检查 后续', cursor: 3 })
  })

  it('detects plugin triggers only when their char is registered', () => {
    expect(activeComposerTrigger('参考 #背', 5, '#')).toEqual({ kind: 'plugin', query: '背', start: 3, end: 5, triggerChar: '#' })
    expect(activeComposerTrigger('参考 #背', 5)).toBeNull()
    expect(activeComposerTrigger('markdown # 标题', 11, '#')).toBeNull()
  })

  it('escapes regex-special trigger chars safely', () => {
    expect(activeComposerTrigger('看 +abc', 6, '+')).toEqual({ kind: 'plugin', query: 'abc', start: 2, end: 6, triggerChar: '+' })
    expect(activeComposerTrigger('看 a+b', 5, '+')).toBeNull()
  })

  it('replaces a plugin trigger token with the chosen text', () => {
    const trigger = activeComposerTrigger('参考 #背 继续', 5, '#')
    expect(trigger && replaceComposerTrigger('参考 #背 继续', trigger, '背景正文')).toEqual({ text: '参考 背景正文 继续', cursor: 7 })
  })
})

describe('matchesSendShortcut', () => {
  const event = { key: 'Enter', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, isComposing: false, keyCode: 13 }

  it('supports modifier-enter and plain-enter modes', () => {
    expect(matchesSendShortcut({ ...event, metaKey: true }, 'mod-enter')).toBe(true)
    expect(matchesSendShortcut({ ...event, ctrlKey: true }, 'mod-enter')).toBe(true)
    expect(matchesSendShortcut(event, 'enter')).toBe(true)
    expect(matchesSendShortcut({ ...event, shiftKey: true }, 'enter')).toBe(false)
  })

  it('never submits while an IME composition is active', () => {
    expect(matchesSendShortcut({ ...event, isComposing: true }, 'enter')).toBe(false)
    expect(matchesSendShortcut({ ...event, metaKey: true, keyCode: 229 }, 'mod-enter')).toBe(false)
  })
})

describe('structured references', () => {
  it('detects selected skill markers and resolves relative file matches', () => {
    expect(hasSkillMarker('$tdd 修复测试', 'tdd')).toBe(true)
    expect(hasSkillMarker('$tdd-extra 修复测试', 'tdd')).toBe(false)
    expect(absoluteMentionPath('/repo', 'src/App.tsx')).toBe('/repo/src/App.tsx')
    expect(absoluteMentionPath('/repo', '/tmp/file.txt')).toBe('/tmp/file.txt')
  })

  it('inserts a skill prompt without discarding an existing draft', () => {
    expect(insertComposerPrompt('', '$plan-delegate 交给 Luna')).toBe('$plan-delegate 交给 Luna')
    expect(insertComposerPrompt('保留这段补充', '$plan-delegate 交给 Luna'))
      .toBe('$plan-delegate 交给 Luna\n\n保留这段补充')
  })

  it('emits CLI-compatible skill placeholders with UTF-8 byte ranges', () => {
    expect(composerTextInput('检查 $tdd 和 $tdd', ['tdd'])).toEqual({
      type: 'text',
      text: '检查 $tdd 和 $tdd',
      text_elements: [
        { byteRange: { start: 7, end: 11 }, placeholder: '$tdd' },
        { byteRange: { start: 16, end: 20 }, placeholder: '$tdd' },
      ],
    })
    expect(composerTextInput('前缀 $中文 后缀', ['中文'])).toEqual({
      type: 'text',
      text: '前缀 $中文 后缀',
      text_elements: [{ byteRange: { start: 7, end: 14 }, placeholder: '$中文' }],
    })
  })

  it('only marks complete skill tokens and ignores unavailable markers', () => {
    expect(composerTextInput('$tdd-extra $tdd/x $tdd', ['tdd'])).toEqual({
      type: 'text',
      text: '$tdd-extra $tdd/x $tdd',
      text_elements: [{ byteRange: { start: 18, end: 22 }, placeholder: '$tdd' }],
    })
    expect(composerTextInput('$tdd', ['missing'])).toEqual({ type: 'text', text: '$tdd', text_elements: [] })
  })
})

describe('collapsed pastes', () => {
  it('collapses text at the threshold and counts Unicode characters', () => {
    expect(shouldCollapsePaste('a'.repeat(LONG_PASTE_THRESHOLD - 1))).toBe(false)
    expect(shouldCollapsePaste('a'.repeat(LONG_PASTE_THRESHOLD))).toBe(true)
    expect(pastedCharacterCount('a😀中')).toBe(3)
  })

  it('shows a compact label but expands the original content for sending', () => {
    const content = `first\n${'x'.repeat(LONG_PASTE_THRESHOLD)}\nlast`
    const draft = insertCollapsedPaste('before  after', 7, 7, content, [])

    expect(draft.text).toBe(`before [Pasted Content ${pastedCharacterCount(content)} chars] after`)
    expect(expandCollapsedPastes(draft.text, draft.pastes)).toBe(`before ${content} after`)
    expect(draft.cursor).toBe(draft.pastes[0].end)
  })

  it('uses a label override as the visible placeholder', () => {
    const content = 'x'.repeat(LONG_PASTE_THRESHOLD)
    const draft = insertCollapsedPaste('前缀 ', 3, 3, content, [], '[Prompt: 任务背景]')

    expect(draft.text).toBe('前缀 [Prompt: 任务背景]')
    expect(expandCollapsedPastes(draft.text, draft.pastes)).toBe(`前缀 ${content}`)
  })

  it('keeps multiple long pastes aligned while editing around them', () => {
    const first = insertCollapsedPaste('AB', 1, 1, 'x'.repeat(1_000), [])
    const second = insertCollapsedPaste(first.text, first.text.length, first.text.length, 'y'.repeat(1_001), first.pastes)
    const editedText = `>${second.text}`
    const editedPastes = reconcileCollapsedPastes(second.text, editedText, second.pastes)

    expect(expandCollapsedPastes(editedText, editedPastes)).toBe(`>A${'x'.repeat(1_000)}B${'y'.repeat(1_001)}`)
  })

  it('drops the preserved content when its visible label is edited or deleted', () => {
    const draft = insertCollapsedPaste('', 0, 0, 'x'.repeat(1_000), [])
    const editedText = draft.text.replace('Content', 'text')
    const editedPastes = reconcileCollapsedPastes(draft.text, editedText, draft.pastes)

    expect(editedPastes).toEqual([])
    expect(expandCollapsedPastes(editedText, editedPastes)).toBe('[Pasted text 1000 chars]')
  })
})

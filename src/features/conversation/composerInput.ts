import type { SendShortcut, UserInput } from '../../core/domain/codex'

export const LONG_PASTE_THRESHOLD = 1_000

export interface CollapsedPaste {
  start: number
  end: number
  content: string
  label: string
}

export interface CollapsedPasteEdit {
  text: string
  pastes: CollapsedPaste[]
  cursor: number
}

export interface ActiveComposerTrigger {
  kind: 'file' | 'skill' | 'command'
  query: string
  start: number
  end: number
}

export interface ComposerKeyEvent {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  isComposing: boolean
  keyCode: number
}

export type ReasoningEffortTone = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

export function reasoningEffortTone(effort: string): ReasoningEffortTone {
  const normalized = effort.toLowerCase()
  if (normalized === 'ultra') return 'ultra'
  if (normalized === 'max') return 'max'
  if (normalized === 'xhigh') return 'xhigh'
  if (normalized === 'high') return 'high'
  if (normalized === 'medium') return 'medium'
  return 'low'
}

export function pastedCharacterCount(content: string): number {
  return Array.from(content).length
}

export function shouldCollapsePaste(content: string): boolean {
  return pastedCharacterCount(content) >= LONG_PASTE_THRESHOLD
}

export function insertCollapsedPaste(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  content: string,
  pastes: CollapsedPaste[],
): CollapsedPasteEdit {
  const characterCount = pastedCharacterCount(content)
  const label = `[Pasted Content ${characterCount} chars]`
  const nextText = `${text.slice(0, selectionStart)}${label}${text.slice(selectionEnd)}`
  const nextPastes = reconcileCollapsedPastes(text, nextText, pastes)
  nextPastes.push({
    start: selectionStart,
    end: selectionStart + label.length,
    content,
    label,
  })
  nextPastes.sort((left, right) => left.start - right.start)
  return { text: nextText, pastes: nextPastes, cursor: selectionStart + label.length }
}

export function reconcileCollapsedPastes(previousText: string, nextText: string, pastes: CollapsedPaste[]): CollapsedPaste[] {
  if (previousText === nextText || pastes.length === 0) return pastes

  let editStart = 0
  while (editStart < previousText.length && editStart < nextText.length && previousText[editStart] === nextText[editStart]) editStart += 1

  let sharedSuffix = 0
  const maximumSuffix = Math.min(previousText.length - editStart, nextText.length - editStart)
  while (
    sharedSuffix < maximumSuffix
    && previousText[previousText.length - 1 - sharedSuffix] === nextText[nextText.length - 1 - sharedSuffix]
  ) sharedSuffix += 1

  const previousEditEnd = previousText.length - sharedSuffix
  const offset = nextText.length - previousText.length
  const insertionOnly = editStart === previousEditEnd

  return pastes.flatMap((paste) => {
    if (insertionOnly) {
      if (editStart <= paste.start) return [{ ...paste, start: paste.start + offset, end: paste.end + offset }]
      if (editStart >= paste.end) return [paste]
      return []
    }
    if (paste.end <= editStart) return [paste]
    if (paste.start >= previousEditEnd) return [{ ...paste, start: paste.start + offset, end: paste.end + offset }]
    return []
  })
}

export function expandCollapsedPastes(text: string, pastes: CollapsedPaste[]): string {
  if (pastes.length === 0) return text
  let cursor = 0
  let expanded = ''
  for (const paste of [...pastes].sort((left, right) => left.start - right.start)) {
    if (paste.start < cursor || text.slice(paste.start, paste.end) !== paste.label) continue
    expanded += text.slice(cursor, paste.start)
    expanded += paste.content
    cursor = paste.end
  }
  return expanded + text.slice(cursor)
}

export function activeComposerTrigger(text: string, cursor: number | null): ActiveComposerTrigger | null {
  if (cursor === null || cursor < 0) return null
  const beforeCursor = text.slice(0, cursor)
  const command = beforeCursor.match(/^\s*\/([^\n]*)$/)
  if (command) {
    const start = beforeCursor.indexOf('/')
    return { kind: 'command', query: command[1], start, end: cursor }
  }
  const match = beforeCursor.match(/(?:^|\s)([@$])([^\s@$]*)$/)
  if (!match || match.index === undefined) return null
  const triggerOffset = match[0].lastIndexOf(match[1])
  const start = match.index + triggerOffset
  return {
    kind: match[1] === '@' ? 'file' : 'skill',
    query: match[2],
    start,
    end: cursor,
  }
}

export function replaceComposerTrigger(text: string, trigger: ActiveComposerTrigger, replacement: string): { text: string; cursor: number } {
  const prefix = text.slice(0, trigger.start)
  let suffix = text.slice(trigger.end)
  if (!replacement && prefix.endsWith(' ') && suffix.startsWith(' ')) suffix = suffix.slice(1)
  const separator = suffix.startsWith(' ') || replacement.endsWith(' ') ? '' : ' '
  const inserted = replacement ? `${replacement}${separator}` : ''
  return {
    text: `${prefix}${inserted}${suffix}`,
    cursor: trigger.start + inserted.length,
  }
}

export function matchesSendShortcut(event: ComposerKeyEvent, shortcut: SendShortcut): boolean {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return false
  if (shortcut === 'enter') return !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey
  return (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey
}

export function hasSkillMarker(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|\\s)\\$${escaped}(?=\\s|$)`).test(text)
}

/**
 * Build the text part of a composer submission using the same placeholder
 * metadata the Codex CLI sends for interactively selected skills.
 *
 * byteRange is measured in UTF-8 bytes, while String#indexOf uses UTF-16
 * offsets. Keep the conversion here so the UI does not accidentally send a
 * character range for non-ASCII prompts.
 */
export function composerTextInput(text: string, skillNames: string[]): Extract<UserInput, { type: 'text' }> {
  const encoder = new TextEncoder()
  const elements: Array<{ byteRange: { start: number; end: number }; placeholder: string }> = []
  const names = [...new Set(skillNames)].filter(Boolean)

  for (const name of names) {
    const marker = `$${name}`
    let searchStart = 0
    while (searchStart < text.length) {
      const markerStart = text.indexOf(marker, searchStart)
      if (markerStart < 0) break
      const markerEnd = markerStart + marker.length
      const before = markerStart === 0 ? '' : text[markerStart - 1]
      const after = markerEnd === text.length ? '' : text[markerEnd]
      if ((!before || /\s/u.test(before)) && (!after || /\s/u.test(after))) {
        const start = encoder.encode(text.slice(0, markerStart)).byteLength
        const end = start + encoder.encode(marker).byteLength
        elements.push({ byteRange: { start, end }, placeholder: marker })
      }
      searchStart = markerEnd
    }
  }

  elements.sort((left, right) => left.byteRange.start - right.byteRange.start)
  return { type: 'text', text, text_elements: elements }
}

export function insertComposerPrompt(current: string, prompt: string): string {
  return current.trim() ? `${prompt.trim()}\n\n${current}` : prompt.trim()
}

export function absoluteMentionPath(root: string, path: string): string {
  if (/^(?:\/|[A-Za-z]:[\\/])/.test(path)) return path
  return `${root.replace(/[\\/]$/, '')}/${path.replace(/^[\\/]/, '')}`
}

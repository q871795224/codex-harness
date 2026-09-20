import type { MessageReference, SendShortcut, UserInput } from '../../core/domain/codex'

export const LONG_PASTE_THRESHOLD = 1_000

export interface CollapsedPasteOrigin {
  kind: 'project-doc'
  projectId: string
}

export interface CollapsedPaste {
  start: number
  end: number
  content: string
  label: string
  /** 标识这条折叠区间的来源；普通粘贴为空，项目背景卡为 project-doc。 */
  origin?: CollapsedPasteOrigin
  reference?: { kind: 'file' | 'skill' | 'command'; path?: string; name: string }
}

export interface CollapsedPasteEdit {
  text: string
  pastes: CollapsedPaste[]
  cursor: number
}

export interface ActiveComposerTrigger {
  kind: 'file' | 'skill' | 'command' | 'plugin'
  query: string
  start: number
  end: number
  triggerChar?: string
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

interface ClipboardImageData {
  items?: ArrayLike<{ type: string }>
  files?: ArrayLike<{ type: string }>
}

export function clipboardHasImage(data: ClipboardImageData): boolean {
  return [...Array.from(data.items ?? []), ...Array.from(data.files ?? [])]
    .some((item) => item.type.toLocaleLowerCase().startsWith('image/'))
}

export function isSupportedImagePath(path: string): boolean {
  return /\.(?:gif|jpe?g|png|webp)$/i.test(path)
}

interface ComposerInputAttachment {
  path: string
  name: string
  kind: 'image' | 'file' | 'skill'
}

export function composerInputs(text: string, attachments: ComposerInputAttachment[], preserveWhitespace = false, imagePlaceholders = true): UserInput[] {
  const selectedSkillNames = attachments.filter((attachment) => attachment.kind === 'skill').map((attachment) => attachment.name)
  const body = preserveWhitespace ? text : text.trim()
  const images: UserInput[] = attachments
    .filter((attachment) => attachment.kind === 'image')
    .map((attachment) => ({ type: 'localImage', path: attachment.path }))
  const skills: UserInput[] = attachments
    .filter((attachment) => attachment.kind === 'skill')
    .map((attachment) => ({ type: 'skill', name: attachment.name, path: attachment.path }))
  // 普通文件对齐 Codex CLI：路径直接随文本发出，由 agent 自行读取文件内容；
  // 不再发送结构化 mention（App Server 不会把它放进模型上下文）。
  const bodyWithFilePaths = attachments
    .filter((attachment) => attachment.kind === 'file')
    .reduce((acc, attachment) => (acc ? `${acc}\n${attachment.path}` : attachment.path), body)
  const imageLabels = (imagePlaceholders ? images : []).map((_, index) => `[Image #${index + 1}]`).join(' ')
  const message = imageLabels ? `${imageLabels}${bodyWithFilePaths ? ` ${bodyWithFilePaths}` : ''}` : bodyWithFilePaths
  const textInput = composerTextInput(message, selectedSkillNames)
  let imageOffset = 0
  const labeledImages = imagePlaceholders ? images : []
  labeledImages.forEach((_, index) => {
    const label = `[Image #${index + 1}]`
    textInput.text_elements.unshift({ byteRange: { start: imageOffset, end: imageOffset + label.length }, placeholder: label })
    imageOffset += label.length + 1
  })
  textInput.text_elements.sort((a, b) => a.byteRange.start - b.byteRange.start)
  return [...images, ...(message ? [textInput] : []), ...skills]
}

interface ComposerSuggestionLike {
  kind: 'image' | 'file' | 'skill' | 'command' | 'plugin'
  name: string
  path?: string
  detail?: string
  replacement?: string
}

/** 选中建议项后写回输入框的文本；文件对齐 Codex CLI，插入建议列表里展示的相对路径。 */
export function suggestionReplacement(suggestion: ComposerSuggestionLike): string {
  if (suggestion.kind === 'skill') return `$${suggestion.name}`
  if (suggestion.kind === 'command') return suggestion.replacement ?? `/${suggestion.name}`
  if (suggestion.kind === 'file') return suggestion.detail ?? suggestion.path ?? suggestion.name
  return ''
}

/** 只有图片和 Skill 仍作为附件保留；文件已随文本内联，命令和插件不产生附件。 */
export function shouldAttachSuggestion(kind: ComposerSuggestionLike['kind']): kind is 'image' | 'skill' {
  return kind === 'image' || kind === 'skill'
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
  labelOverride?: string,
  origin?: CollapsedPasteOrigin,
): CollapsedPasteEdit {
  const characterCount = pastedCharacterCount(content)
  const label = labelOverride ?? `[Pasted Content ${characterCount} chars]`
  const nextText = `${text.slice(0, selectionStart)}${label}${text.slice(selectionEnd)}`
  const nextPastes = reconcilePasteEdit(pastes, selectionStart, selectionEnd, nextText.length - text.length)
  nextPastes.push({
    start: selectionStart,
    end: selectionStart + label.length,
    content,
    label,
    ...(origin ? { origin } : {}),
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
  return reconcilePasteEdit(pastes, editStart, previousEditEnd, nextText.length - previousText.length)
}

export function reconcilePasteEdit(pastes: CollapsedPaste[], editStart: number, previousEditEnd: number, offset: number): CollapsedPaste[] {
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

export function activeComposerTrigger(text: string, cursor: number | null, extraTriggers = ''): ActiveComposerTrigger | null {
  if (cursor === null || cursor < 0) return null
  const beforeCursor = text.slice(0, cursor)
  const command = beforeCursor.match(/^\s*\/([^\n]*)$/)
  if (command) {
    const start = beforeCursor.indexOf('/')
    return { kind: 'command', query: command[1], start, end: cursor }
  }
  const escaped = extraTriggers.replace(/[-.*+?^${}()|[\]\\]/g, '\\$&')
  const match = beforeCursor.match(new RegExp(`(?:^|\\s)([@$${escaped}])([^\\s@$${escaped}]*)$`))
  if (!match || match.index === undefined) return null
  const triggerOffset = match[0].lastIndexOf(match[1])
  const start = match.index + triggerOffset
  const symbol = match[1]
  const kind = symbol === '@' ? 'file' : symbol === '$' ? 'skill' : 'plugin'
  return {
    kind,
    query: match[2],
    start,
    end: cursor,
    ...(kind === 'plugin' ? { triggerChar: symbol } : {}),
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

/** UI ranges use UTF-16; only App Server text_elements use UTF-8 byte offsets. */
export function composerSubmission(text: string, pastes: CollapsedPaste[], attachments: ComposerInputAttachment[]) {
  const expanded = expandCollapsedPastes(text, pastes)
  const preserveWhitespace = pastes.some((paste) => !paste.reference)
  const input = composerInputs(expanded, attachments, preserveWhitespace)
  const trimOffset = preserveWhitespace ? 0 : expanded.length - expanded.trimStart().length
  const body = input.find((item) => item.type === 'text')
  const references: MessageReference[] = []
  const images = attachments.filter((item) => item.kind === 'image')
  let offset = 0
  images.forEach((item, index) => {
    const label = `[Image #${index + 1}]`
    references.push({ kind: 'image', start: offset, end: offset + label.length, path: item.path })
    offset += label.length + 1
  })
  const bodyOffset = images.length ? offset : 0
  let expansionOffset = 0
  for (const paste of [...pastes].sort((a, b) => a.start - b.start)) {
    if (text.slice(paste.start, paste.end) !== paste.label) continue
    const start = bodyOffset + paste.start + expansionOffset - trimOffset
    const end = start + paste.content.length
    if (paste.reference?.kind === 'file' || paste.reference?.kind === 'skill') {
      references.push({ kind: paste.reference.kind, start, end, path: paste.reference.path! })
    } else if (!paste.origin && !paste.reference) {
      references.push({ kind: 'paste', start, end })
    }
    expansionOffset += paste.content.length - (paste.end - paste.start)
  }
  // The file picker and restored legacy drafts can still contain file attachments.
  let fileOffset = bodyOffset + (preserveWhitespace ? expanded.length : expanded.trim().length)
  for (const file of attachments.filter((item) => item.kind === 'file')) {
    if (fileOffset > bodyOffset) fileOffset += 1
    references.push({ kind: 'file', start: fileOffset, end: fileOffset + file.path.length, path: file.path })
    fileOffset += file.path.length
  }
  if (body) {
    // Selected occurrences only: typing the same $name elsewhere is still plain text.
    const selectedNames = new Set(pastes.filter((paste) => paste.reference?.kind === 'skill').map((paste) => paste.reference!.name))
    body.text_elements = body.text_elements.filter((element) => !selectedNames.has(element.placeholder.slice(1)))
    const encoder = new TextEncoder()
    for (const reference of references.filter((item) => item.kind === 'skill')) {
      body.text_elements.push({
        byteRange: { start: encoder.encode(body.text.slice(0, reference.start)).length, end: encoder.encode(body.text.slice(0, reference.end)).length },
        placeholder: body.text.slice(reference.start, reference.end),
      })
    }
    body.text_elements.sort((a, b) => a.byteRange.start - b.byteRange.start)
  }
  return { input, references: references.sort((a, b) => a.start - b.start) }
}

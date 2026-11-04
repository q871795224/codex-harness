import type { MessageReference, UserInput } from '../../core/domain/codex'

/** Retarget only Harness's project marker, keeping attachment ranges valid. */
export function retargetDraftProjectInput(input: UserInput[], references: MessageReference[], projectId: string, from: string, to: string): { input: UserInput[]; references: MessageReference[] } {
  const marker = `<!-- project-doc: project_id=${projectId} thread_id=${from} -->`
  const replacement = `<!-- project-doc: project_id=${projectId} thread_id=${to} -->`
  const edits: Array<{ start: number; end: number; length: number }> = []
  let offset = 0
  let textItems = 0
  const bytes = (text: string) => new TextEncoder().encode(text).length
  const mapped = input.map((item): UserInput => {
    if (item.type !== 'text') return item
    if (textItems++) offset++
    const start = item.text.indexOf(marker)
    const originalOffset = offset
    offset += item.text.length
    if (start < 0) return item
    const end = start + marker.length
    edits.push({ start: originalOffset + start, end: originalOffset + end, length: replacement.length })
    const byteStart = bytes(item.text.slice(0, start)), byteEnd = byteStart + bytes(marker), byteLength = bytes(replacement)
    const position = (value: number) => value <= byteStart ? value : value >= byteEnd ? value + byteLength - (byteEnd - byteStart) : byteStart + Math.min(value - byteStart, byteLength)
    return { ...item, text: item.text.slice(0, start) + replacement + item.text.slice(end),
      text_elements: item.text_elements?.map((element) => ({ ...element, byteRange: { start: position(element.byteRange.start), end: position(element.byteRange.end) } })),
    }
  })
  const position = (value: number) => {
    let shift = 0
    for (const edit of edits) {
      if (value <= edit.start) break
      if (value < edit.end) return edit.start + shift + Math.min(value - edit.start, edit.length)
      shift += edit.length - (edit.end - edit.start)
    }
    return value + shift
  }
  return { input: mapped, references: references.map((reference) => ({ ...reference, start: position(reference.start), end: position(reference.end) })) }
}

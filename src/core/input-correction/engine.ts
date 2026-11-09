export interface Replacement { from: string; to: string }
export interface Range { start: number; end: number }
export interface Correction extends Range { before: string; after: string }

export function parseReplacement(value: string): Replacement {
  const parts = value.split(/\s*(?:→|->)\s*/)
  const [from, to] = parts.map((part) => part.trim())
  if (parts.length !== 2 || !from || !to || from === to || from.length > 100 || to.length > 100 || /[\r\n]/.test(value)) throw new Error('请输入“原词 → 替换词”，每个词不超过 100 字')
  return { from, to }
}

export function protectedRanges(text: string, ranges: Range[] = []): Range[] {
  const result = [...ranges]
  // Keep pasted references, Markdown code, links, paths and command lines literal.
  const pattern = /^\s*(?:\$|\/)[^\n]*|```[\s\S]*?(?:```|(?![\s\S]))|~~~[\s\S]*?(?:~~~|(?![\s\S]))|`[^`\n]*(?:`|$)|https?:\/\/[^\s]+|(?:^|\s)(?:[~/.]|[A-Za-z]:\\)[^\s]+/gm
  for (const match of text.matchAll(pattern)) result.push({ start: match.index!, end: match.index! + match[0].length })
  return result
}

export function correctInput(text: string, rules: Replacement[], quotes: boolean, ranges: Range[] = []): { text: string; edits: Correction[] } {
  const protectedText = protectedRanges(text, ranges)
  const sorted = rules.filter((rule) => rule.from && rule.to && rule.from !== rule.to).sort((a, b) => b.from.length - a.from.length)
  const edits: Correction[] = []
  let output = '', quoteOpen = false
  for (let index = 0; index < text.length;) {
    const blocked = protectedText.find((range) => index >= range.start && index < range.end)
    if (blocked) {
      const literal = text.slice(index, blocked.end)
      if (literal === '“') quoteOpen = true
      if (literal === '”') quoteOpen = false
      output += literal; index = blocked.end; continue
    }
    const rule = sorted.find((entry) => text.startsWith(entry.from, index) && !protectedText.some((range) => index < range.end && index + entry.from.length > range.start))
    const before = rule?.from ?? text[index]
    let after = rule?.to ?? before
    if (!rule && quotes && /[“”"]/.test(before)) {
      const lineStart = text.lastIndexOf('\n', index - 1) + 1
      const lineEnd = text.indexOf('\n', index)
      if (/\p{Script=Han}/u.test(text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd))) {
        after = quoteOpen ? '”' : '“'
        quoteOpen = !quoteOpen
      }
    }
    if (before === '\n') quoteOpen = false
    if (before !== after) edits.push({ start: output.length, end: output.length + after.length, before, after })
    output += after
    index += before.length
  }
  return { text: output, edits }
}

// Move still-valid corrections through a subsequent user edit. Touched spans belong to the user.
export function moveCorrections(before: string, after: string, edits: Correction[]): Correction[] {
  let start = 0, end = before.length, nextEnd = after.length
  while (start < end && start < nextEnd && before[start] === after[start]) start++
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd-- }
  const delta = nextEnd - end
  return edits.flatMap((edit) => edit.end <= start ? [edit] : edit.start >= end ? [{ ...edit, start: edit.start + delta, end: edit.end + delta }] : [])
}

// A user edit inside a corrected span becomes literal text for the rest of this draft.
export function manuallyEditedRanges(before: string, after: string, ranges: Range[]): Range[] {
  let start = 0, end = before.length, nextEnd = after.length
  while (start < end && start < nextEnd && before[start] === after[start]) start++
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd-- }
  const delta = nextEnd - end
  return ranges.filter((range) => range.end > start && range.start < end || start === end && range.start < start && range.end > start)
    .map((range) => ({ start: Math.min(range.start, start), end: Math.max(nextEnd, range.end + delta) }))
    .filter((range) => range.end > range.start)
}

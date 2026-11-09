import { useEffect, useRef, useState, type RefObject } from 'react'
import { correctInput, moveCorrections, undoCorrections, type Correction, type Range } from '../../core/input-correction/engine'
import { loadCorrectionSettings, useCorrectionSettings } from '../../core/input-correction/settings'

export function useInputCorrection(text: string, composing: boolean, disabled: boolean, ranges: Range[], textarea: RefObject<HTMLTextAreaElement | null>, apply: (text: string, edits: Correction[], undo: boolean) => void) {
  const settings = useCorrectionSettings()
  const [edits, setEdits] = useState<Correction[]>([])
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const previous = useRef(text)
  const pending = useRef(false)
  const suppressed = useRef(new Set<string>())
  const pasted = useRef<Correction[]>([])
  const nextPaste = useRef<Range | null>(null)
  const latest = useRef({ apply, ranges, edits })
  latest.current = { apply, ranges, edits }
  useEffect(() => {
    let disposed = false
    void loadCorrectionSettings().then(() => { if (!disposed) setLoaded(true) }).catch((e) => { if (!disposed) setError(String(e)) })
    return () => { disposed = true }
  }, [])
  useEffect(() => {
    if (previous.current !== text) {
      const remaining = moveCorrections(previous.current, text, latest.current.edits)
      pasted.current = moveCorrections(previous.current, text, pasted.current)
      if (nextPaste.current) pasted.current.push({ ...nextPaste.current, before: '', after: '' })
      nextPaste.current = null
      previous.current = text
      latest.current.edits = remaining
      setEdits(remaining)
    }
    if (!text) { suppressed.current.clear(); pasted.current = []; pending.current = false; return }
    if (!loaded || !pending.current || composing || disabled) return
    const timer = setTimeout(() => {
      pending.current = false
      const result = correctInput(text, settings.enabled ? settings.rules : [], settings.quotes, [...latest.current.ranges, ...latest.current.edits, ...pasted.current], suppressed.current)
      if (!result.edits.length) return
      const element = textarea.current
      const selectionStart = element?.selectionStart ?? text.length
      const selectionEnd = element?.selectionEnd ?? selectionStart
      const shift = (position: number) => {
        let offset = 0
        for (const edit of result.edits) {
          const originalStart = edit.start - offset
          if (position <= originalStart) break
          const delta = edit.after.length - edit.before.length
          if (position < originalStart + edit.before.length) return edit.end
          offset += delta
        }
        return position + offset
      }
      let delta = 0
      const changes = result.edits.map((edit) => {
        const end = edit.start - delta + edit.before.length
        const offset = edit.after.length - edit.before.length
        delta += offset
        return { end, offset }
      })
      const move = (entries: Correction[]) => entries.map((entry) => {
        const offset = changes.filter((change) => change.end <= entry.start).reduce((sum, change) => sum + change.offset, 0)
        return { ...entry, start: entry.start + offset, end: entry.end + offset }
      })
      const existing = move(latest.current.edits)
      pasted.current = move(pasted.current)
      previous.current = result.text
      setEdits([...existing, ...result.edits])
      latest.current.apply(result.text, result.edits, false)
      requestAnimationFrame(() => element?.setSelectionRange(shift(selectionStart), shift(selectionEnd)))
    }, 600)
    return () => clearTimeout(timer)
  }, [text, composing, disabled, settings, textarea, loaded])
  const undo = () => {
    const active = latest.current.edits
    for (const edit of active) suppressed.current.add(/^[“”"]$/.test(edit.before) ? '__quotes__' : edit.before)
    const restored = undoCorrections(text, active)
    let movedPastes = pasted.current
    for (const edit of [...active].sort((a, b) => b.start - a.start)) {
      const offset = edit.before.length - edit.after.length
      movedPastes = movedPastes.map((range) => range.start >= edit.end ? { ...range, start: range.start + offset, end: range.end + offset } : range)
    }
    pasted.current = movedPastes
    const element = textarea.current
    const caret = element?.selectionStart ?? restored.length
    const nextCaret = caret + active.filter((edit) => edit.end <= caret).reduce((sum, edit) => sum + edit.before.length - edit.after.length, 0)
    previous.current = restored
    pending.current = false
    setEdits([])
    latest.current.apply(restored, active, true)
    requestAnimationFrame(() => { element?.focus(); element?.setSelectionRange(nextCaret, nextCaret) })
  }
  return { corrected: edits.length > 0, undo, error, noteInput: () => { pending.current = !nextPaste.current }, notePaste: (start: number, _end: number, content: string) => { pending.current = false; nextPaste.current = { start, end: start + content.length } } }
}

import { useEffect, useRef, useState, type RefObject } from 'react'
import { correctInput, moveCorrections, manuallyEditedRanges, type Correction, type Range } from '../../core/input-correction/engine'
import { loadCorrectionSettings, useCorrectionSettings } from '../../core/input-correction/settings'

export function useInputCorrection(text: string, composing: boolean, disabled: boolean, ranges: Range[], textarea: RefObject<HTMLTextAreaElement | null>, apply: (text: string, edits: Correction[]) => void) {
  const settings = useCorrectionSettings()
  const [edits, setEdits] = useState<Correction[]>([])
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [revision, setRevision] = useState(0)
  const previous = useRef(text)
  const pending = useRef(false)
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
      const manual = manuallyEditedRanges(previous.current, text, [...latest.current.edits, ...pasted.current])
      pasted.current = [...moveCorrections(previous.current, text, pasted.current), ...manual.map((range) => ({ ...range, before: '', after: '' }))]
      if (nextPaste.current) pasted.current.push({ ...nextPaste.current, before: '', after: '' })
      nextPaste.current = null
      previous.current = text
      latest.current.edits = remaining
      setEdits(remaining)
    }
    if (!text) { pasted.current = []; pending.current = false; return }
    if (!loaded || !pending.current || composing || disabled) return
    const timer = setTimeout(() => {
      pending.current = false
      const result = correctInput(text, settings.enabled ? settings.rules : [], settings.quotes, [...latest.current.ranges, ...latest.current.edits, ...pasted.current])
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
      setRevision((value) => value + 1)
      latest.current.apply(result.text, result.edits)
      requestAnimationFrame(() => element?.setSelectionRange(shift(selectionStart), shift(selectionEnd)))
    }, 600)
    return () => clearTimeout(timer)
  }, [text, composing, disabled, settings, textarea, loaded])
  // Derive ranges for this render too, so highlights never lag a user edit by one frame.
  const visibleEdits = previous.current === text ? edits : moveCorrections(previous.current, text, edits)
  return { edits: visibleEdits, revision, error, noteInput: () => { pending.current = !nextPaste.current }, notePaste: (start: number, _end: number, content: string) => { pending.current = false; nextPaste.current = { start, end: start + content.length } } }
}

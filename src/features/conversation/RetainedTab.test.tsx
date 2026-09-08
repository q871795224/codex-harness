// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useState } from 'react'
import { RetainedTab } from './RetainedTab'

afterEach(cleanup)
function Editor() {
  const [editing, setEditing] = useState(false)
  return editing ? <textarea aria-label="draft" defaultValue="original" /> : <button onClick={() => setEditing(true)}>Edit</button>
}
it('lazily mounts tabs and preserves the editing view, draft and scroll across switches', () => {
  const view = (active: boolean, thread = 'one') => <RetainedTab key={thread} active={active}><Editor /></RetainedTab>
  const { rerender, container } = render(view(false))
  expect(container.textContent).toBe('')
  rerender(view(true))
  fireEvent.click(screen.getByText('Edit'))
  const draft = screen.getByLabelText('draft') as HTMLTextAreaElement
  fireEvent.change(draft, { target: { value: 'unsaved' } })
  draft.scrollTop = 42
  rerender(view(false))
  expect(container.firstElementChild?.hasAttribute('hidden')).toBe(true)
  rerender(view(true))
  expect(screen.getByLabelText('draft')).toBe(draft)
  expect(draft.value).toBe('unsaved')
  expect(draft.scrollTop).toBe(42)
  rerender(view(true, 'two'))
  expect(screen.getByText('Edit')).toBeTruthy()
})

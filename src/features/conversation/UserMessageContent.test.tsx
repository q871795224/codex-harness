// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { UserMessageContent } from './UserMessageContent'
import { saveMessageReferences } from './messageReferences'
import type { UserInput } from '../../core/domain/codex'

const mocks = vi.hoisted(() => ({ storage: new Map<string, string>(), open: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../core/runtime/bridge', () => ({ runtime: {
  getAppState: vi.fn(async (key: string) => mocks.storage.get(key) ?? null),
  setAppState: vi.fn(async (key: string, value: string) => { mocks.storage.set(key, value) }),
  openWorkspacePath: mocks.open,
} }))
beforeEach(() => { vi.stubGlobal('crypto', { subtle: { digest: async (_algorithm: string, bytes: Uint8Array) => bytes.buffer } }); mocks.storage.clear(); mocks.open.mockClear() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('restores selected file tags after remount and opens the exact path; manual paths remain text', async () => {
  const text = 'a.ts a.ts'
  const content: UserInput[] = [{ type: 'text', text, text_elements: [] }]
  await saveMessageReferences('one', content, [{ kind: 'file', start: 0, end: 4, path: '/repo/a.ts' }])
  const item = { type: 'userMessage', clientId: 'one', content }
  const first = render(<UserMessageContent item={item} text={text} cwd="/repo" />)
  await screen.findByRole('button', { name: '[a.ts]' })
  first.unmount()
  render(<UserMessageContent item={item} text={text} cwd="/repo" />)
  const tag = await screen.findByRole('button', { name: '[a.ts]' })
  expect(screen.getAllByRole('button')).toHaveLength(1)
  expect(tag.title).toBe('/repo/a.ts')
  fireEvent.click(tag)
  expect(mocks.open).toHaveBeenCalledWith('goland', '/repo', '/repo/a.ts')
})

it('keeps pasted content available on expansion and raw mode, without duplicate image attachments', async () => {
  const text = '[Image #1] pasted content'
  const content: UserInput[] = [{ type: 'localImage', path: '/tmp/shot.png' }, { type: 'text', text, text_elements: [] }]
  await saveMessageReferences('two', content, [{ kind: 'image', start: 0, end: 10, path: '/tmp/shot.png' }, { kind: 'paste', start: 11, end: text.length }])
  const item = { type: 'userMessage', clientId: 'two', content }
  const { container, rerender } = render(<UserMessageContent item={item} text={text} cwd="/repo" />)
  await waitFor(() => expect(container.querySelector('details')).not.toBeNull())
  expect(screen.getAllByRole('button', { name: '[shot.png]' })).toHaveLength(1)
  expect(container.querySelector('details')!.textContent).toContain('pasted content')
  rerender(<UserMessageContent item={item} text={text} cwd="/repo" raw />)
  expect(container.querySelector('pre')?.textContent).toBe(text)
})

it('does not decorate manually typed paths without metadata', async () => {
  await act(async () => { render(<UserMessageContent item={{ type: 'userMessage', clientId: 'plain' }} text="/repo/a.ts $demo" cwd="/repo" />) })
  expect(screen.queryByRole('button')).toBeNull()
})

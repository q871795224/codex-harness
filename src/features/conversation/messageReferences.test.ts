import { beforeEach, expect, it, vi } from 'vitest'
import { loadMessageReferences, restartedMessageReferences, saveMessageReferences } from './messageReferences'
import type { MessageReference, UserInput } from '../../core/domain/codex'

const storage = vi.hoisted(() => new Map<string, string>())
vi.mock('../../core/runtime/bridge', () => ({ runtime: {
  setAppState: vi.fn(async (key: string, value: string) => { storage.set(key, value) }),
  getAppState: vi.fn(async (key: string) => storage.get(key) ?? null),
} }))
beforeEach(() => storage.clear())
const input: UserInput[] = [{ type: 'text', text: 'secret pasted body /repo/a', text_elements: [] }]
const refs: MessageReference[] = [{ kind: 'paste', start: 0, end: 18 }, { kind: 'file', start: 19, end: 26, path: '/repo/a' }]

it('restores only display metadata by client id and never persists message or paste bodies', async () => {
  await saveMessageReferences('message-1', input, refs)
  const persisted = [...storage.values()].join('')
  expect(persisted).not.toContain('secret')
  expect(persisted).not.toContain('pasted body')
  expect(await loadMessageReferences('message-1', 'secret pasted body /repo/a')).toEqual(refs)
  expect(await loadMessageReferences('message-2', 'secret pasted body /repo/a')).toEqual([])
})

it('does not apply old selections after a queued message is edited, even to equal-length text', async () => {
  await saveMessageReferences('queued', input, refs)
  expect(await loadMessageReferences('queued', 'secret pasted body /repo/b')).toEqual([])
})

it('writes nothing for messages without selected references', async () => {
  await saveMessageReferences('plain', input, [])
  expect(storage.size).toBe(0)
})

it('rebases interrupted steering references when inputs are combined into a new turn', async () => {
  const first: UserInput[] = [{ type: 'text', text: 'a.ts', text_elements: [] }]
  const second: UserInput[] = [{ type: 'text', text: 'b.ts', text_elements: [] }]
  await saveMessageReferences('a', first, [{ kind: 'file', start: 0, end: 4, path: '/repo/a.ts' }])
  await saveMessageReferences('b', second, [{ kind: 'file', start: 0, end: 4, path: '/repo/b.ts' }])
  expect(await restartedMessageReferences([{ clientUserMessageId: 'a', input: first }, { clientUserMessageId: 'b', input: second }])).toEqual([
    { kind: 'file', start: 0, end: 4, path: '/repo/a.ts' },
    { kind: 'file', start: 5, end: 9, path: '/repo/b.ts' },
  ])
})

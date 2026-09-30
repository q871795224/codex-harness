import { beforeEach, expect, it, vi } from 'vitest'
import { appServer } from '../../core/runtime/appServerClient'
import { readHistoryTurn } from './historyItems'

vi.mock('../../core/runtime/appServerClient', () => ({ appServer: { listItems: vi.fn() } }))
beforeEach(() => vi.resetAllMocks())

it('loads full history one item at a time without combining images in a response', async () => {
  const image = { turnId: 'turn', item: { type: 'imageGeneration', id: 'image', result: 'fixture-base64' } }
  const command = { turnId: 'turn', item: { type: 'commandExecution', id: 'command', aggregatedOutput: 'full output' } }
  vi.mocked(appServer.listItems).mockResolvedValueOnce({ data: [image], nextCursor: 'next' }).mockResolvedValueOnce({ data: [command], nextCursor: null })
  expect(await readHistoryTurn('thread', 'turn', new AbortController().signal)).toEqual([image, command])
  expect(appServer.listItems).toHaveBeenNthCalledWith(1, { threadId: 'thread', turnId: 'turn', cursor: null, limit: 1, sortDirection: 'asc' })
  expect(appServer.listItems).toHaveBeenNthCalledWith(2, { threadId: 'thread', turnId: 'turn', cursor: 'next', limit: 1, sortDirection: 'asc' })
})

it('stops paging after collapse or navigation and rejects repeated cursors', async () => {
  const controller = new AbortController()
  vi.mocked(appServer.listItems).mockImplementationOnce(async () => { controller.abort(); return { data: [], nextCursor: 'next' } })
  await expect(readHistoryTurn('thread', 'turn', controller.signal)).rejects.toThrow()
  expect(appServer.listItems).toHaveBeenCalledTimes(1)
  vi.mocked(appServer.listItems).mockResolvedValue({ data: [], nextCursor: 'stuck' })
  await expect(readHistoryTurn('thread', 'turn', new AbortController().signal)).rejects.toThrow('分页未前进')
})

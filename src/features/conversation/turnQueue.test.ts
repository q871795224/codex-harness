import { describe, expect, it, vi } from 'vitest'
import type { QueuedSubmission } from '../../core/domain/codex'
import { textInput } from '../../core/domain/codex'
import { promoteQueuedSubmission, type TurnQueueTransport } from './turnQueue'

function queue(): QueuedSubmission {
  return {
    id: 'queue-1',
    clientUserMessageId: 'message-1',
    input: [
      textInput('first'),
      { type: 'localImage', path: '/tmp/image.png' },
      textInput('second'),
    ],
  }
}

function transport(): TurnQueueTransport {
  return {
    deleteQueue: vi.fn().mockResolvedValue(undefined),
    steerTurn: vi.fn().mockResolvedValue(undefined),
    addQueue: vi.fn().mockResolvedValue(undefined),
  }
}

describe('queued turn promotion', () => {
  it('deletes the queue entry before steering and returns the pending message', async () => {
    const calls: string[] = []
    const client = transport()
    vi.mocked(client.deleteQueue).mockImplementation(async () => { calls.push('delete') })
    vi.mocked(client.steerTurn).mockImplementation(async () => { calls.push('steer') })

    await expect(promoteQueuedSubmission(client, 'thread-1', 'turn-1', queue(), 42)).resolves.toEqual({
      clientUserMessageId: 'message-1',
      text: 'first\nsecond',
      createdAt: 42,
    })
    expect(calls).toEqual(['delete', 'steer'])
    expect(client.addQueue).not.toHaveBeenCalled()
  })

  it('restores the queue entry when steering fails', async () => {
    const client = transport()
    const failure = new Error('turn changed')
    vi.mocked(client.steerTurn).mockRejectedValue(failure)

    await expect(promoteQueuedSubmission(client, 'thread-1', 'turn-1', queue())).rejects.toBe(failure)
    expect(client.addQueue).toHaveBeenCalledWith({
      threadId: 'thread-1',
      clientUserMessageId: 'message-1',
      input: queue().input,
    })
  })

  it('keeps the original steer error when queue restoration also fails', async () => {
    const client = transport()
    const failure = new Error('turn changed')
    vi.mocked(client.steerTurn).mockRejectedValue(failure)
    vi.mocked(client.addQueue).mockRejectedValue(new Error('restore failed'))

    await expect(promoteQueuedSubmission(client, 'thread-1', 'turn-1', queue())).rejects.toBe(failure)
  })
})

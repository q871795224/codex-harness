import { describe, expect, it, vi } from 'vitest'
import type { QueuedSubmission } from '../../core/domain/codex'
import { textInput } from '../../core/domain/codex'
import { promoteQueuedSubmission, restartInputs, submitActiveTurnInput, type TurnQueueTransport } from './turnQueue'

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
      input: queue().input,
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

describe('active turn submission', () => {
  it('adds queue mode to the server queue without steering', async () => {
    const client = transport()

    await expect(submitActiveTurnInput(client, {
      threadId: 'thread-1',
      activeTurnId: 'turn-1',
      clientUserMessageId: 'message-1',
      input: queue().input,
      mode: 'queue',
    })).resolves.toEqual({ kind: 'queued' })
    expect(client.addQueue).toHaveBeenCalledWith({
      threadId: 'thread-1', clientUserMessageId: 'message-1', input: queue().input,
    })
    expect(client.steerTurn).not.toHaveBeenCalled()
  })

  it('records the original structured input for an interjection', async () => {
    const client = transport()

    const result = await submitActiveTurnInput(client, {
      threadId: 'thread-1',
      activeTurnId: 'turn-1',
      clientUserMessageId: 'message-1',
      input: queue().input,
      mode: 'interject',
    }, 42)

    expect(result).toEqual({
      kind: 'steered',
      pending: { clientUserMessageId: 'message-1', text: 'first\nsecond', input: queue().input, createdAt: 42 },
    })
    expect(client.steerTurn).toHaveBeenCalledWith({
      threadId: 'thread-1', expectedTurnId: 'turn-1', clientUserMessageId: 'message-1', input: queue().input,
    })
    expect(client.addQueue).not.toHaveBeenCalled()
  })

  it('restarts stopped interjections without losing attachments or mentions', () => {
    const input = queue().input
    expect(restartInputs([
      { clientUserMessageId: 'message-1', text: 'first', input, createdAt: 1 },
      { clientUserMessageId: 'message-2', text: 'again', input: [textInput('again')], createdAt: 2 },
    ])).toEqual([...input, textInput('again')])
  })
})

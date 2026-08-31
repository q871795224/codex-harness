import type { PendingSteer, QueuedSubmission, UserInput } from '../../core/domain/codex'

export interface TurnQueueTransport {
  deleteQueue(threadId: string, queuedSubmissionId: string): Promise<unknown>
  steerTurn(params: {
    threadId: string
    expectedTurnId: string
    clientUserMessageId: string
    input: UserInput[]
  }): Promise<unknown>
  addQueue(params: {
    threadId: string
    clientUserMessageId: string
    input: UserInput[]
  }): Promise<unknown>
}

export async function promoteQueuedSubmission(
  transport: TurnQueueTransport,
  threadId: string,
  activeTurnId: string,
  queue: QueuedSubmission,
  now = Date.now(),
): Promise<PendingSteer> {
  // App Server has no atomic promote operation. Delete first avoids a duplicated
  // follow-up; on a failed steer, restore the same server-owned queue entry.
  await transport.deleteQueue(threadId, queue.id)
  try {
    await transport.steerTurn({
      threadId,
      expectedTurnId: activeTurnId,
      clientUserMessageId: queue.clientUserMessageId,
      input: queue.input,
    })
  } catch (error) {
    await transport.addQueue({
      threadId,
      clientUserMessageId: queue.clientUserMessageId,
      input: queue.input,
    }).catch(() => undefined)
    throw error
  }

  const text = queue.input
    .map((input) => input.type === 'text' ? input.text : '')
    .filter(Boolean)
    .join('\n')
  return { clientUserMessageId: queue.clientUserMessageId, text, createdAt: now }
}

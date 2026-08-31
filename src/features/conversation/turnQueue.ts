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

export type ActiveTurnSubmissionResult =
  | { kind: 'queued' }
  | { kind: 'steered'; pending: PendingSteer }

export async function submitActiveTurnInput(
  transport: TurnQueueTransport,
  params: {
    threadId: string
    activeTurnId: string
    clientUserMessageId: string
    input: UserInput[]
    mode: 'interject' | 'queue'
  },
  now = Date.now(),
): Promise<ActiveTurnSubmissionResult> {
  if (params.mode === 'queue') {
    await transport.addQueue({
      threadId: params.threadId,
      clientUserMessageId: params.clientUserMessageId,
      input: params.input,
    })
    return { kind: 'queued' }
  }

  await transport.steerTurn({
    threadId: params.threadId,
    expectedTurnId: params.activeTurnId,
    clientUserMessageId: params.clientUserMessageId,
    input: params.input,
  })
  return {
    kind: 'steered',
    pending: pendingSteer(params.clientUserMessageId, params.input, now),
  }
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

  return pendingSteer(queue.clientUserMessageId, queue.input, now)
}

export function restartInputs(restarts: PendingSteer[]): UserInput[] {
  return restarts.flatMap((steer) => steer.input)
}

function pendingSteer(clientUserMessageId: string, input: UserInput[], createdAt: number): PendingSteer {
  const text = input
    .map((input) => input.type === 'text' ? input.text : '')
    .filter(Boolean)
    .join('\n')
  return { clientUserMessageId, text: text.trim() || '附件', input, createdAt }
}

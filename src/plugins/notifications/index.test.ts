import { describe, expect, it, vi } from 'vitest'
import type { ConversationService, TurnCompletedEvent } from '../../core/conversations/types'
import type { SystemNotificationClick, SystemNotificationService } from '../../core/notifications/types'
import { PluginHost } from '../../core/plugins/runtime'
import { notificationsDefaultInstance, notificationsPlugin } from './index'

const storage = {
  async get<T>() { return null as T | null },
  async set() {},
}

describe('notifications plugin', () => {
  it('sends one notification for each completed turn and opens clicked threads', async () => {
    const listeners: {
      completed?: (event: TurnCompletedEvent) => void
      click?: (event: SystemNotificationClick) => void
    } = {}
    const send = vi.fn(async () => undefined)
    const openThread = vi.fn(async () => undefined)
    const conversations: ConversationService = {
      onTurnCompleted(listener) {
        listeners.completed = listener
        return () => { delete listeners.completed }
      },
      openThread,
    }
    const notifications: SystemNotificationService = {
      requestPermission: async () => true,
      send,
      async onClick(listener) {
        listeners.click = listener
        return () => { delete listeners.click }
      },
    }
    const host = new PluginHost([notificationsPlugin], {
      storage: () => storage,
      services: {
        'harness.conversations': conversations,
        'harness.systemNotifications': notifications,
      },
    })

    await host.syncInstances([notificationsDefaultInstance])
    const event: TurnCompletedEvent = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      title: '实现系统通知',
      status: 'completed',
    }
    listeners.completed?.(event)
    listeners.click?.({ threadId: 'thread-1' })
    await Promise.resolve()

    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith({
      threadId: event.threadId,
      turnId: event.turnId,
      title: event.title,
    })
    expect(openThread).toHaveBeenCalledWith('thread-1')

    await host.dispose()
    expect(listeners.completed).toBeUndefined()
    expect(listeners.click).toBeUndefined()
  })

  it('fails activation when notification permission is denied', async () => {
    const host = new PluginHost([notificationsPlugin], {
      storage: () => storage,
      services: {
        'harness.conversations': { onTurnCompleted: () => () => undefined, openThread: async () => undefined } satisfies ConversationService,
        'harness.systemNotifications': {
          requestPermission: async () => false,
          send: async () => undefined,
          onClick: async () => () => undefined,
        } satisfies SystemNotificationService,
      },
    })

    await host.syncInstances([notificationsDefaultInstance])

    expect(host.status(notificationsDefaultInstance.instanceId)).toEqual({ phase: 'failed', error: 'macOS 通知权限未开启' })
  })
})

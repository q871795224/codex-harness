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
      onMessageSubmitted: () => () => undefined,
      openThread,
    }
    const notifications: SystemNotificationService = {
      requestPermission: async () => true,
      send,
      dismissThread: vi.fn(async () => undefined),
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

  it('fails activation when notification permission is unavailable', async () => {
    const host = new PluginHost([notificationsPlugin], {
      storage: () => storage,
      services: {
        'harness.conversations': { onMessageSubmitted: () => () => undefined, onTurnCompleted: () => () => undefined, openThread: async () => undefined } satisfies ConversationService,
        'harness.systemNotifications': {
          requestPermission: async () => false,
          dismissThread: async () => undefined,
          send: async () => undefined,
          onClick: async () => () => undefined,
        } satisfies SystemNotificationService,
      },
    })

    await host.syncInstances([notificationsDefaultInstance])

    expect(host.status(notificationsDefaultInstance.instanceId)).toEqual({ phase: 'failed', error: 'macOS 通知权限未开启' })
  })

  it('reports notification delivery failures instead of silently swallowing them', async () => {
    let completed: ((event: TurnCompletedEvent) => void) | undefined
    const error = new Error('delivery rejected')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const host = new PluginHost([notificationsPlugin], {
      storage: () => storage,
      services: {
        'harness.conversations': {
          onTurnCompleted(listener) {
            completed = listener
            return () => { completed = undefined }
          },
          onMessageSubmitted: () => () => undefined,
          openThread: async () => undefined,
        } satisfies ConversationService,
        'harness.systemNotifications': {
          requestPermission: async () => true,
          dismissThread: async () => undefined,
          send: async () => { throw error },
          onClick: async () => () => undefined,
        } satisfies SystemNotificationService,
      },
    })

    await host.syncInstances([notificationsDefaultInstance])
    completed?.({ threadId: 'thread-1', turnId: 'turn-1', title: '测试通知', status: 'completed' })
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalled())

    expect(consoleError).toHaveBeenCalledWith('[plugin:builtin.notifications] macOS 通知发送失败', error)
    consoleError.mockRestore()
    await host.dispose()
  })
  it('clears a whole conversation on click or message submission, preserving other conversations and waiting for in-flight delivery', async () => {
    let completed!: (event: TurnCompletedEvent) => void
    let activity!: (threadId: string) => void
    let clicked!: (event: SystemNotificationClick) => void
    let finishDelivery!: () => void
    const delivered = new Map<string, string[]>()
    const send = vi.fn(async (input: { threadId: string; turnId: string }) => {
      if (input.turnId === 'slow') await new Promise<void>((resolve) => { finishDelivery = resolve })
      delivered.set(input.threadId, [...(delivered.get(input.threadId) ?? []), input.turnId])
    })
    const dismissThread = vi.fn(async (id: string) => { delivered.delete(id) })
    const openThread = vi.fn(async () => undefined)
    const host = new PluginHost([notificationsPlugin], {
      storage: () => storage,
      services: {
        'harness.conversations': {
          onTurnCompleted(listener) { completed = listener; return () => {} },
          onMessageSubmitted(listener) { activity = listener; return () => {} },
          openThread,
        } satisfies ConversationService,
        'harness.systemNotifications': {
          requestPermission: async () => true, send, dismissThread,
          async onClick(listener) { clicked = listener; return () => {} },
        } satisfies SystemNotificationService,
      },
    })
    await host.syncInstances([notificationsDefaultInstance])
    const finish = (threadId: string, turnId: string) => completed({ threadId, turnId, title: 'same inherited title', status: 'completed' })
    finish('parent', 'one')
    finish('fork', 'one')
    finish('fork', 'two')
    await vi.waitFor(() => expect(delivered.get('fork')).toEqual(['one', 'two']))
    clicked({ threadId: 'fork' })
    await vi.waitFor(() => expect(delivered.has('fork')).toBe(false))
    expect(openThread).toHaveBeenCalledWith('fork')
    expect(delivered.get('parent')).toEqual(['one'])

    finish('parent', 'slow')
    await vi.waitFor(() => expect(finishDelivery).toBeTypeOf('function'))
    activity('parent')
    expect(delivered.get('parent')).toEqual(['one'])
    finishDelivery()
    await vi.waitFor(() => expect(delivered.has('parent')).toBe(false))
    expect(dismissThread.mock.calls.map(([id]) => id)).toEqual(['fork', 'parent'])
    await host.dispose()
  })

})

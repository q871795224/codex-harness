import type { ConversationService } from '../../core/conversations/types'
import type { SystemNotificationService } from '../../core/notifications/types'
import type { HarnessPlugin, PluginInstanceRecord } from '../../extensions/types'

export const notificationsPlugin: HarnessPlugin = {
  manifest: {
    schemaVersion: 1,
    id: 'builtin.notifications',
    name: '系统通知',
    description: 'Codex 或 Claude 完成一次完整回复后发送 macOS 系统通知。',
    version: '1.1.0',
    engine: { codexHarness: '^0.3.0' },
    supportedScopes: ['global'],
    permissions: ['system:notifications'],
  },
  async activate(ctx) {
    const conversations = ctx.services.get<ConversationService>('harness.conversations')
    const notifications = ctx.services.get<SystemNotificationService>('harness.systemNotifications')
    if (!await notifications.requestPermission()) throw new Error('macOS 通知权限未开启')

    // Serialize delivery and acknowledgement per thread: a late send must not
    // recreate a notification after the user has already opened its conversation.
    const pending = new Map<string, Promise<void>>()
    const enqueue = (threadId: string, operation: () => Promise<void>, message: string) => {
      const task = (pending.get(threadId) ?? Promise.resolve()).then(operation)
        .catch((error) => console.error(`[plugin:builtin.notifications] ${message}`, error))
      pending.set(threadId, task)
      void task.then(() => { if (pending.get(threadId) === task) pending.delete(threadId) })
    }
    const dismiss = (threadId: string) => enqueue(threadId,
      () => notifications.dismissThread(threadId), 'macOS 通知清除失败')
    ctx.effect(conversations.onMessageSubmitted(dismiss))
    ctx.effect(conversations.onTurnCompleted((event) => {
      enqueue(event.threadId, () => notifications.send({
        threadId: event.threadId,
        turnId: event.turnId,
        title: event.title,
      }), 'macOS 通知发送失败')
    }))
    ctx.effect(await notifications.onClick((event) => {
      dismiss(event.threadId)
      void conversations.openThread(event.threadId).catch(() => undefined)
    }))
  },
}

export const notificationsDefaultInstance: PluginInstanceRecord = {
  instanceId: 'builtin.notifications:default',
  pluginId: notificationsPlugin.manifest.id,
  scope: { kind: 'global' },
  enabled: true,
  config: {},
  createdAt: 0,
  updatedAt: 0,
}

import type { ConversationService } from '../../core/conversations/types'
import type { SystemNotificationService } from '../../core/notifications/types'
import type { HarnessPlugin, PluginInstanceRecord } from '../../extensions/types'

export const notificationsPlugin: HarnessPlugin = {
  manifest: {
    schemaVersion: 1,
    id: 'builtin.notifications',
    name: '系统通知',
    description: 'Codex 完成一次完整回复后发送 macOS 系统通知。',
    version: '1.0.1',
    engine: { codexHarness: '^0.3.0' },
    supportedScopes: ['global'],
    permissions: ['system:notifications'],
  },
  async activate(ctx) {
    const conversations = ctx.services.get<ConversationService>('harness.conversations')
    const notifications = ctx.services.get<SystemNotificationService>('harness.systemNotifications')
    if (!await notifications.requestPermission()) throw new Error('macOS 通知权限未开启')

    ctx.effect(conversations.onTurnCompleted((event) => {
      void notifications.send({
        threadId: event.threadId,
        turnId: event.turnId,
        title: event.title,
      }).catch(() => undefined)
    }))
    ctx.effect(await notifications.onClick((event) => {
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

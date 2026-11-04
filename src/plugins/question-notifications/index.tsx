import { useState } from 'react'
import type { ConversationService } from '../../core/conversations/types'
import type { QuestionNotificationService } from '../../core/questions/types'
import { questionNotifications } from '../../core/questions/notifications'
import type { NotificationService } from '../../core/notifications/store'
import type { HarnessPlugin, PluginInstanceRecord, PluginSettingsProps } from '../../extensions/types'

export const questionNotificationsPlugin: HarnessPlugin = {
  manifest: {
    schemaVersion: 1, id: 'builtin.question-notifications', name: 'SeaTalk 提问通知',
    description: 'Codex 中间提问时逐题通知；点击只打开问题和预填答案，仍需在 Harness 内提交。',
    version: '1.0.0', engine: { codexHarness: '^0.10.0' }, supportedScopes: ['global'],
    permissions: ['localhost:bridge-agent'],
  },
  settings: Settings,
  activate(ctx) {
    const conversations = ctx.services.get<ConversationService>('harness.conversations')
    const sender = ctx.services.get<QuestionNotificationService>('harness.questionNotifications')
    const notifications = ctx.services.get<NotificationService>('harness.notifications')
    const config = readConfig(ctx.config)
    let disposed = false
    ctx.effect(() => { disposed = true })
    ctx.effect(conversations.onUserInputRequested((event) => {
      void (async () => {
        const inputs = await questionNotifications(event)
        for (const input of inputs) {
          if (disposed) return
          try { await sender.send(config.baseUrl, config.account, config.targetId, input) }
          catch {
            if (disposed) return
            notifications.publish({ id: `question-notification:${event.request.threadId}:${event.request.id}`, level: 'warning', source: 'question-notifications',
              title: 'SeaTalk 提问通知未发送', message: '请在 Harness 内查看问题；可在插件设置中检查 Bridge 账号。', threadId: event.request.threadId })
          }
        }
      })().catch(() => undefined)
    }))
  },
}
function readConfig(config: Readonly<Record<string, unknown>>) {
  const value = (key: string, fallback: string) => typeof config[key] === 'string' && config[key].trim() ? config[key].trim() as string : fallback
  return { baseUrl: value('baseUrl', 'http://127.0.0.1:8787'), account: value('account', 'harness-notify'), targetId: value('targetId', 'self') }
}
function Settings({ instance, saveConfig }: PluginSettingsProps) {
  const [form, setForm] = useState(() => readConfig(instance.config))
  const [saved, setSaved] = useState(false)
  return <div className="plugin-business-settings">
    <p>凭据由 Bridge 管理。self 使用通知账号配置的接收者；手机点击不会唤醒电脑。</p>
    {([['baseUrl', 'Bridge 地址'], ['account', 'Bridge 通知账号'], ['targetId', '接收者员工编号或 self']] as const).map(([key, label]) =>
      <label className="plugin-setting-row" key={key}><span>{label}</span><input value={form[key]} onChange={(event) => { setForm({ ...form, [key]: event.target.value }); setSaved(false) }} /></label>)}
    <button type="button" onClick={() => void saveConfig(form).then(() => setSaved(true))}>{saved ? '已保存' : '保存'}</button>
  </div>
}
export const questionNotificationsDefaultInstance: PluginInstanceRecord = {
  instanceId: 'builtin.question-notifications:default', pluginId: 'builtin.question-notifications', scope: { kind: 'global' },
  enabled: true, config: {}, createdAt: 0, updatedAt: 0,
}

import { useEffect, useMemo } from 'react'
import { appServer } from '../../core/runtime/appServerClient'
import { notifications } from '../../core/notifications/service'
import type { NotificationStore } from '../../core/notifications/store'

const NOTICE_ID = 'codex-provider:custom'
const CHECK_ERROR_ID = 'codex-provider:check-error'
const action = { kind: 'codex-provider-restore' as const, target: 'openai', label: '改回 OpenAI' }

/** Recovery is explicit; a custom provider is a supported configuration, not an alarm. */
export function createCodexProviderRecovery(
  client: Pick<typeof appServer, 'readConfig' | 'writeConfigValue'>,
  store: NotificationStore,
) {
  let restoring: Promise<void> | null = null
  const restore = (): Promise<void> => {
    if (restoring) return restoring
    restoring = (async () => {
      await store.initialize()
      try {
        const { config } = await client.readConfig()
        const provider = config.model_provider ?? 'openai'
        if (provider !== 'openai' && provider !== 'custom') throw new Error('provider changed')
        if (provider === 'custom') await client.writeConfigValue('model_provider', 'openai')
        const readback = await client.readConfig()
        if ((readback.config.model_provider ?? 'openai') !== 'openai') throw new Error('verification failed')
        store.resolve(NOTICE_ID)
        store.resolve('codex-provider:restore-error')
        store.publish({ id: 'codex-provider:restored', source: 'Codex 配置', level: 'info',
          title: 'Codex provider 已确认是 OpenAI', message: '其他配置保持不变。' })
      } catch {
        store.publish({ id: 'codex-provider:restore-error', source: 'Codex 配置', level: 'error',
          title: '未能恢复 Codex provider',
          message: '配置读取、写入或校验失败，或 provider 已改为其他值。请检查后重试。', actions: [action] })
      }
    })().finally(() => { restoring = null })
    return restoring
  }
  return restore
}

export async function retireProviderCheckNotices(store: NotificationStore) {
  await store.initialize()
  store.resolve(NOTICE_ID)
  store.resolve(CHECK_ERROR_ID)
}

export function useCodexProviderRecovery(ready: boolean) {
  const restore = useMemo(() => createCodexProviderRecovery(appServer, notifications), [])
  useEffect(() => {
    if (ready) void retireProviderCheckNotices(notifications)
  }, [ready])
  return restore
}

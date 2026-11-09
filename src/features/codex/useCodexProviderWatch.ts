import { useEffect, useMemo } from 'react'
import { appServer } from '../../core/runtime/appServerClient'
import { notifications } from '../../core/notifications/service'
import type { NotificationStore } from '../../core/notifications/store'

export const PROVIDER_CHECK_INTERVAL = 5 * 60_000
const NOTICE_ID = 'codex-provider:custom'
const CHECK_ERROR_ID = 'codex-provider:check-error'
const action = { kind: 'codex-provider-restore' as const, target: 'openai', label: '改回 OpenAI' }

/** Only observe custom; never write until the user selects the recovery action. */
export function createCodexProviderWatch(
  client: Pick<typeof appServer, 'readConfig' | 'writeConfigValue'>,
  store: NotificationStore,
) {
  let pending: Promise<void> | null = null
  let restoring: Promise<void> | null = null
  let warned = false
  const healthy = () => {
    warned = false
    store.resolve(NOTICE_ID)
  }
  const check = (): Promise<void> => {
    if (restoring) return restoring
    if (pending) return pending
    pending = (async () => {
      await store.initialize()
      try {
        const { config } = await client.readConfig()
        store.resolve(CHECK_ERROR_ID)
        if (config.model_provider !== 'custom') { healthy(); return }
        if (warned) return
        warned = true
        store.publish({
          id: NOTICE_ID, eventKey: crypto.randomUUID(), source: 'Codex 配置', level: 'warning',
          attention: 'action', state: 'pending', title: 'Codex provider 当前为 custom',
          message: '这会影响 openai 历史会话的继续使用。点击“改回 OpenAI”仅修改 model_provider，保留其他配置。',
          actions: [action],
        })
      } catch {
        store.publish({ id: CHECK_ERROR_ID, source: 'Codex 配置', level: 'warning',
          title: '暂时无法检查 Codex provider', message: '未修改配置，5 分钟后重试。' })
      }
    })().finally(() => { pending = null })
    return pending
  }
  const restore = (): Promise<void> => {
    if (restoring) return restoring
    restoring = (async () => {
      // A pending read must finish before recovery; repeated clicks share the write.
      if (pending) await pending
      await store.initialize()
      try {
        const { config } = await client.readConfig()
        const provider = config.model_provider ?? 'openai'
        if (provider !== 'openai' && provider !== 'custom') throw new Error('provider changed')
        if (provider === 'custom') await client.writeConfigValue('model_provider', 'openai')
        const readback = await client.readConfig()
        if ((readback.config.model_provider ?? 'openai') !== 'openai') throw new Error('verification failed')
        healthy()
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
  return { check, restore }
}

export function useCodexProviderWatch(ready: boolean) {
  const watch = useMemo(() => createCodexProviderWatch(appServer, notifications), [])
  useEffect(() => {
    if (!ready) return
    void watch.check()
    const timer = window.setInterval(() => { void watch.check() }, PROVIDER_CHECK_INTERVAL)
    return () => window.clearInterval(timer)
  }, [ready, watch])
  return watch.restore
}

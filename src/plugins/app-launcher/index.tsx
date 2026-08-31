import { useState } from 'react'
import { CircleAlert, LoaderCircle, SquareCode } from 'lucide-react'
import type { AppLauncherService } from '../../core/app-launcher/types'
import type { HarnessPlugin, PluginInstanceRecord, ThreadHeaderActionProps } from '../../extensions/types'

export const appLauncherPlugin: HarnessPlugin = {
  manifest: {
    schemaVersion: 1,
    id: 'builtin.app-launcher',
    name: 'App 启动器',
    description: '在 GoLand 中打开当前会话的 checkout 或 worktree。',
    version: '1.0.0',
    engine: { codexHarness: '^0.5.2' },
    supportedScopes: ['global'],
    permissions: ['process:open-application'],
  },
  activate(ctx) {
    const service = ctx.services.get<AppLauncherService>('harness.appLauncher')
    ctx.slots.threadHeaderActions.register({
      id: 'open-in-goland',
      order: 10,
      render: (props) => <OpenInGoLand service={service} context={props} />,
    })
  },
}

export const appLauncherDefaultInstance: PluginInstanceRecord = {
  instanceId: 'builtin.app-launcher:default',
  pluginId: appLauncherPlugin.manifest.id,
  scope: { kind: 'global' },
  enabled: true,
  config: {},
  createdAt: 0,
  updatedAt: 0,
}

function OpenInGoLand({ service, context }: {
  service: AppLauncherService
  context: ThreadHeaderActionProps
}) {
  const [state, setState] = useState<'idle' | 'opening' | 'failed'>('idle')
  const [error, setError] = useState<string | null>(null)
  const open = async () => {
    if (!context.threadCwd) return
    setState('opening')
    setError(null)
    try {
      await service.open('goland', context.threadCwd)
      setState('idle')
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
      setState('failed')
    }
  }

  const Icon = state === 'opening' ? LoaderCircle : state === 'failed' ? CircleAlert : SquareCode
  return (
    <button
      type="button"
      className={`thread-context-action${state === 'failed' ? ' failed' : ''}`}
      disabled={context.disabled || !context.threadCwd || state === 'opening'}
      onClick={() => void open()}
      title={error ?? '在 GoLand 中打开当前 worktree'}
      aria-label={error ? `GoLand 打开失败：${error}` : '在 GoLand 中打开当前 worktree'}
    >
      <Icon className={state === 'opening' ? 'spin' : undefined} size={11} />
      GoLand
    </button>
  )
}

import { useEffect, useState } from 'react'
import { Check, CircleAlert, Copy, GitPullRequest, LoaderCircle, SquareCode } from 'lucide-react'
import type { AppLauncherService, WorkspaceDeliveryContext } from '../../core/app-launcher/types'
import type { HarnessPlugin, PluginInstanceRecord, ThreadHeaderActionProps } from '../../extensions/types'

export const appLauncherPlugin: HarnessPlugin = {
  manifest: {
    schemaVersion: 1,
    id: 'builtin.app-launcher',
    name: 'App 启动器',
    description: '从当前会话跳转到 GoLand，并衔接 Git 分支与代码评审。',
    version: '1.1.0',
    engine: { codexHarness: '^0.5.2' },
    supportedScopes: ['global'],
    permissions: ['process:open-application'],
  },
  activate(ctx) {
    const service = ctx.services.get<AppLauncherService>('harness.appLauncher')
    ctx.slots.threadHeaderActions.register({
      id: 'open-in-goland',
      order: 10,
      render: (props) => <DeliveryActions service={service} context={props} />,
    })
  },
}

function DeliveryActions({ service, context }: {
  service: AppLauncherService
  context: ThreadHeaderActionProps
}) {
  const [delivery, setDelivery] = useState<WorkspaceDeliveryContext | null>(null)
  useEffect(() => {
    let active = true
    setDelivery(null)
    if (context.threadCwd) {
      void service.deliveryContext(context.threadCwd)
        .then((value) => { if (active) setDelivery(value) })
        .catch(() => undefined)
    }
    return () => { active = false }
  }, [context.threadCwd, service])

  return (
    <>
      <OpenInGoLand service={service} context={context} />
      {delivery?.branch && <CopyBranch branch={delivery.branch} />}
      {delivery?.reviewUrl && (
        <button type="button" className="thread-context-action" onClick={() => void service.openUrl(delivery.reviewUrl!)} title={delivery.remoteUrl ?? delivery.reviewUrl}>
          <GitPullRequest size={11} />{delivery.reviewLabel ?? '创建 MR'}
        </button>
      )}
    </>
  )
}

function CopyBranch({ branch }: { branch: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(branch)
      setState('copied')
    } catch {
      setState('failed')
    }
    window.setTimeout(() => setState('idle'), 1_500)
  }
  return (
    <button type="button" className={`thread-context-action${state === 'failed' ? ' failed' : ''}`} onClick={() => void copy()} title={state === 'failed' ? '无法写入剪贴板' : `复制分支：${branch}`}>
      {state === 'copied' ? <Check size={11} /> : state === 'failed' ? <CircleAlert size={11} /> : <Copy size={11} />}
      {state === 'copied' ? '已复制' : state === 'failed' ? '复制失败' : '分支'}
    </button>
  )
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

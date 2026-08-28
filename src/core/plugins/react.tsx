import { Component, createContext, useContext, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react'
import { runtime } from '../runtime/bridge'
import type {
  ComposerActionContribution,
  ComposerActionProps,
  ConversationTabContribution,
  ConversationTabProps,
  HarnessPlugin,
  NewThreadPanelContribution,
  NewThreadPanelProps,
  PluginInstanceRecord,
  PluginInstanceStatus,
  PluginViewContext,
  QuickActionContribution,
} from '../../extensions/types'
import { defaultPluginInstancesToSeed, removedDefaultPluginInstanceIds } from './defaults'
import { PluginHost, type ResolvedContribution } from './runtime'

const REMOVED_DEFAULT_PLUGIN_INSTANCE_IDS_KEY = 'removedDefaultPluginInstanceIds'

interface PluginHostContextValue {
  definitions: HarnessPlugin[]
  instances: PluginInstanceRecord[]
  loading: boolean
  error: string | null
  status(instanceId: string): PluginInstanceStatus
  resolvedTabs(context: PluginViewContext): ResolvedContribution<ConversationTabContribution>[]
  resolvedNewThreadPanels(context: PluginViewContext): ResolvedContribution<NewThreadPanelContribution>[]
  resolvedComposerActions(context: PluginViewContext): ResolvedContribution<ComposerActionContribution>[]
  resolvedQuickActions(context: PluginViewContext): ResolvedContribution<QuickActionContribution>[]
  upsertInstance(instance: PluginInstanceRecord): Promise<void>
  deleteInstance(instanceId: string): Promise<void>
}

const PluginHostContext = createContext<PluginHostContextValue | null>(null)

interface PluginHostProviderProps {
  definitions: HarnessPlugin[]
  defaultInstances: PluginInstanceRecord[]
  services?: Record<string, unknown>
  children: ReactNode
}

export function PluginHostProvider({ definitions, defaultInstances, services, children }: PluginHostProviderProps) {
  const [revision, setRevision] = useState(0)
  const [instances, setInstances] = useState<PluginInstanceRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const hostRef = useRef<PluginHost | null>(null)
  if (!hostRef.current) {
    hostRef.current = new PluginHost(definitions, {
      storage: (instance) => ({
        get: <T,>(key: string) => runtime.getPluginState<T>(instance.instanceId, key),
        set: <T,>(key: string, value: T) => runtime.setPluginState(instance.instanceId, key, value),
      }),
      services,
      onChange: () => setRevision((current) => current + 1),
    })
  }
  const host = hostRef.current

  useEffect(() => {
    let disposed = false
    const load = async () => {
      try {
        const stored = await runtime.listPluginInstances()
        const next = [...stored]
        const removedDefaultInstanceIds = removedDefaultPluginInstanceIds(
          await runtime.getAppState(REMOVED_DEFAULT_PLUGIN_INSTANCE_IDS_KEY),
        )
        for (const fallback of defaultPluginInstancesToSeed(stored, defaultInstances, removedDefaultInstanceIds)) {
          next.push(await runtime.upsertPluginInstance(fallback))
        }
        if (!disposed) {
          setInstances(next)
          setError(null)
        }
      } catch (nextError) {
        if (!disposed) setError(messageOf(nextError))
      } finally {
        if (!disposed) setLoading(false)
      }
    }
    void load()
    return () => { disposed = true }
  }, [defaultInstances])

  useEffect(() => {
    if (loading) return
    void host.syncInstances(instances).catch((nextError) => setError(messageOf(nextError)))
  }, [host, instances, loading])

  useEffect(() => () => {
    void host.dispose().catch((nextError) => console.error('plugin host dispose failed', nextError))
  }, [host])

  const value = useMemo<PluginHostContextValue>(() => ({
    definitions,
    instances,
    loading,
    error,
    status: (instanceId) => host.status(instanceId),
    resolvedTabs: (context) => host.resolvedTabs(context),
    resolvedNewThreadPanels: (context) => host.resolvedNewThreadPanels(context),
    resolvedComposerActions: (context) => host.resolvedComposerActions(context),
    resolvedQuickActions: (context) => host.resolvedQuickActions(context),
    upsertInstance: async (instance) => {
      try {
        const saved = await runtime.upsertPluginInstance({ ...instance, updatedAt: Date.now() })
        setInstances((current) => [saved, ...current.filter((candidate) => candidate.instanceId !== saved.instanceId)])
        setError(null)
      } catch (nextError) {
        setError(messageOf(nextError))
        throw nextError
      }
    },
    deleteInstance: async (instanceId) => {
      try {
        if (defaultInstances.some((instance) => instance.instanceId === instanceId)) {
          const currentRemoved = removedDefaultPluginInstanceIds(
            await runtime.getAppState(REMOVED_DEFAULT_PLUGIN_INSTANCE_IDS_KEY),
          )
          await runtime.setAppState(
            REMOVED_DEFAULT_PLUGIN_INSTANCE_IDS_KEY,
            JSON.stringify([...new Set([...currentRemoved, instanceId])]),
          )
        }
        await runtime.deletePluginInstance(instanceId)
        setInstances((current) => current.filter((instance) => instance.instanceId !== instanceId))
        setError(null)
      } catch (nextError) {
        setError(messageOf(nextError))
        throw nextError
      }
    },
  }), [defaultInstances, definitions, error, host, instances, loading, revision])

  return <PluginHostContext.Provider value={value}>{children}</PluginHostContext.Provider>
}

export function usePluginHost(): PluginHostContextValue {
  const value = useContext(PluginHostContext)
  if (!value) throw new Error('usePluginHost 必须在 PluginHostProvider 内使用')
  return value
}

interface PluginTabBoundaryProps {
  tab: ResolvedContribution<ConversationTabContribution>
  props: ConversationTabProps
}

interface PluginTabBoundaryState {
  error: string | null
}

export class PluginTabBoundary extends Component<PluginTabBoundaryProps, PluginTabBoundaryState> {
  state: PluginTabBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): PluginTabBoundaryState {
    return { error: messageOf(error) }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[plugin:${this.props.tab.pluginId}] tab render failed`, error, info)
  }

  componentDidUpdate(previous: PluginTabBoundaryProps): void {
    if (previous.tab.instanceId !== this.props.tab.instanceId && this.state.error) this.setState({ error: null })
  }

  render(): ReactNode {
    if (this.state.error) {
      return <div className="plugin-error">插件页面加载失败：{this.state.error}</div>
    }
    return this.props.tab.contribution.render(this.props.props)
  }
}

export function PluginComposerAction({ action, props }: {
  action: ResolvedContribution<ComposerActionContribution>
  props: ComposerActionProps
}) {
  return (
    <PluginRenderBoundary pluginId={action.pluginId} instanceId={action.instanceId} label="输入框操作">
      {action.contribution.render(props)}
    </PluginRenderBoundary>
  )
}

export function PluginNewThreadPanel({ panel, props }: {
  panel: ResolvedContribution<NewThreadPanelContribution>
  props: NewThreadPanelProps
}) {
  return (
    <PluginRenderBoundary pluginId={panel.pluginId} instanceId={panel.instanceId} label="新会话面板">
      {panel.contribution.render(props)}
    </PluginRenderBoundary>
  )
}

class PluginRenderBoundary extends Component<{
  pluginId: string
  instanceId: string
  label: string
  children: ReactNode
}, { error: string | null }> {
  state = { error: null as string | null }

  static getDerivedStateFromError(error: unknown) {
    return { error: messageOf(error) }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[plugin:${this.props.pluginId}] ${this.props.label} render failed`, error, info)
  }

  componentDidUpdate(previous: Readonly<typeof this.props>): void {
    if (previous.instanceId !== this.props.instanceId && this.state.error) this.setState({ error: null })
  }

  render(): ReactNode {
    return this.state.error
      ? <div className="plugin-error">插件{this.props.label}加载失败：{this.state.error}</div>
      : this.props.children
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

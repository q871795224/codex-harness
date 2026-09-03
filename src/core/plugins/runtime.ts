import type {
  ComposerActionContribution,
  ComposerCompletionContribution,
  ConversationTabContribution,
  HarnessPlugin,
  NewThreadPanelContribution,
  PluginCommand,
  PluginInstanceContext,
  PluginInstanceRecord,
  PluginInstanceStatus,
  PluginScope,
  PluginStorage,
  PluginViewContext,
  QuickActionContribution,
  QuickCommandContribution,
  ThreadHeaderActionContribution,
} from '../../extensions/types'

type Disposer = () => void | Promise<void>

interface ScopedContribution<T> {
  pluginId: string
  instanceId: string
  scope: PluginScope
  contribution: T & { id: string; order?: number }
}

export interface ResolvedContribution<T> {
  pluginId: string
  instanceId: string
  contribution: T
}

class LifecycleScope {
  private readonly disposers: Disposer[] = []
  private disposed = false

  effect(disposer: Disposer): void {
    if (this.disposed) {
      void disposer()
      return
    }
    this.disposers.push(disposer)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    let firstError: unknown = null
    for (const disposer of this.disposers.reverse()) {
      try {
        await disposer()
      } catch (error) {
        firstError ??= error
      }
    }
    if (firstError) throw firstError
  }
}

class ContributionRegistry<T extends { id: string; order?: number }> {
  private readonly entries: ScopedContribution<T>[] = []

  register(entry: ScopedContribution<T>): Disposer {
    if (this.entries.some((candidate) => candidate.instanceId === entry.instanceId && candidate.contribution.id === entry.contribution.id)) {
      throw new Error(`重复的 contribution：${entry.contribution.id}`)
    }
    this.entries.push(entry)
    return () => {
      const index = this.entries.indexOf(entry)
      if (index >= 0) this.entries.splice(index, 1)
    }
  }

  list(): ScopedContribution<T>[] {
    return [...this.entries]
  }
}

class ServiceRegistry {
  private readonly services = new Map<string, unknown>()

  provide<T>(id: string, service: T): Disposer {
    if (this.services.has(id)) throw new Error(`service 已存在：${id}`)
    this.services.set(id, service)
    return () => {
      if (this.services.get(id) === service) this.services.delete(id)
    }
  }

  get<T>(id: string): T {
    if (!this.services.has(id)) throw new Error(`找不到 service：${id}`)
    return this.services.get(id) as T
  }

  optional<T>(id: string): T | undefined {
    return this.services.get(id) as T | undefined
  }
}

class EventBus {
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>()

  on<T>(event: string, handler: (payload: T) => void): Disposer {
    const listeners = this.listeners.get(event) ?? new Set()
    const wrapped = handler as (payload: unknown) => void
    listeners.add(wrapped)
    this.listeners.set(event, listeners)
    return () => {
      listeners.delete(wrapped)
      if (listeners.size === 0) this.listeners.delete(event)
    }
  }

  emit<T>(event: string, payload: T): void {
    for (const handler of this.listeners.get(event) ?? []) handler(payload)
  }
}

class CommandRegistry {
  private readonly commands = new Map<string, { instanceId: string; command: PluginCommand }>()

  register(instanceId: string, command: PluginCommand): Disposer {
    if (this.commands.has(command.id)) throw new Error(`command 已存在：${command.id}`)
    this.commands.set(command.id, { instanceId, command })
    return () => {
      if (this.commands.get(command.id)?.instanceId === instanceId) this.commands.delete(command.id)
    }
  }
}

interface ActiveInstance {
  signature: string
  lifecycle: LifecycleScope
  abortController: AbortController
}

export interface PluginHostOptions {
  storage(instance: PluginInstanceRecord): PluginStorage
  services?: Record<string, unknown>
  onChange?(): void
}

export class PluginHost {
  private readonly definitions = new Map<string, HarnessPlugin>()
  private readonly active = new Map<string, ActiveInstance>()
  private readonly statuses = new Map<string, PluginInstanceStatus>()
  private readonly services = new ServiceRegistry()
  private readonly events = new EventBus()
  private readonly tabs = new ContributionRegistry<ConversationTabContribution>()
  private readonly threadHeaderActions = new ContributionRegistry<ThreadHeaderActionContribution>()
  private readonly newThreadPanels = new ContributionRegistry<NewThreadPanelContribution>()
  private readonly composerActions = new ContributionRegistry<ComposerActionContribution>()
  private readonly composerCompletions = new ContributionRegistry<ComposerCompletionContribution>()
  private readonly quickActions = new ContributionRegistry<QuickActionContribution>()
  private readonly quickCommands = new ContributionRegistry<QuickCommandContribution>()
  private readonly commands = new CommandRegistry()
  private syncQueue: Promise<void> = Promise.resolve()

  constructor(definitions: HarnessPlugin[], private readonly options: PluginHostOptions) {
    for (const definition of definitions) {
      if (this.definitions.has(definition.manifest.id)) throw new Error(`重复的插件定义：${definition.manifest.id}`)
      this.definitions.set(definition.manifest.id, definition)
    }
    sortPluginDefinitions(definitions)
    for (const [id, service] of Object.entries(options.services ?? {})) this.services.provide(id, service)
  }

  manifests(): HarnessPlugin[] {
    return [...this.definitions.values()]
  }

  status(instanceId: string): PluginInstanceStatus {
    return this.statuses.get(instanceId) ?? { phase: 'disabled' }
  }

  resolvedTabs(context: PluginViewContext): ResolvedContribution<ConversationTabContribution>[] {
    return this.filterProvider(resolveScopedContributions(this.tabs.list(), context), context)
  }

  resolvedThreadHeaderActions(context: PluginViewContext): ResolvedContribution<ThreadHeaderActionContribution>[] {
    return this.filterProvider(resolveScopedContributions(this.threadHeaderActions.list(), context), context)
  }

  resolvedNewThreadPanels(context: PluginViewContext): ResolvedContribution<NewThreadPanelContribution>[] {
    return this.filterProvider(resolveScopedContributions(this.newThreadPanels.list(), context), context)
  }

  resolvedComposerActions(context: PluginViewContext): ResolvedContribution<ComposerActionContribution>[] {
    return this.filterProvider(resolveScopedContributions(this.composerActions.list(), context), context)
  }

  resolvedComposerCompletions(context: PluginViewContext): ResolvedContribution<ComposerCompletionContribution>[] {
    return this.filterProvider(resolveScopedContributions(this.composerCompletions.list(), context), context)
  }

  resolvedQuickActions(context: PluginViewContext): ResolvedContribution<QuickActionContribution>[] {
    return this.filterProvider(resolveScopedContributions(this.quickActions.list(), context), context)
  }

  resolvedQuickCommands(context: PluginViewContext): ResolvedContribution<QuickCommandContribution>[] {
    return this.filterProvider(resolveScopedContributions(this.quickCommands.list(), context), context)
  }

  private filterProvider<T>(entries: ResolvedContribution<T>[], context: PluginViewContext): ResolvedContribution<T>[] {
    if (!context.provider) return entries
    return entries.filter((entry) => {
      const supported = this.definitions.get(entry.pluginId)?.manifest.supportedProviders
      return !supported || supported.includes(context.provider!)
    })
  }

  syncInstances(instances: PluginInstanceRecord[]): Promise<void> {
    const snapshot = instances.map((instance) => ({ ...instance, config: { ...instance.config } }))
    const task = this.syncQueue.then(() => this.applyInstances(snapshot))
    this.syncQueue = task.catch(() => undefined)
    return task
  }

  private async applyInstances(instances: PluginInstanceRecord[]): Promise<void> {
    const desired = new Map(instances.map((instance) => [instance.instanceId, instance]))
    const enabledByPlugin = new Map<string, PluginInstanceRecord[]>()
    for (const instance of instances) {
      if (!instance.enabled) continue
      const list = enabledByPlugin.get(instance.pluginId) ?? []
      list.push(instance)
      enabledByPlugin.set(instance.pluginId, list)
    }

    for (const [instanceId, current] of [...this.active]) {
      const instance = desired.get(instanceId)
      const definition = instance ? this.definitions.get(instance.pluginId) : undefined
      const signature = instance && definition ? instanceSignature(instance, definition, enabledByPlugin) : null
      if (!instance?.enabled || !definition || current.signature !== signature) await this.deactivate(instanceId)
    }

    const ordered = sortPluginDefinitions([...this.definitions.values()])
    for (const definition of ordered) {
      const pluginInstances = instances.filter((instance) => instance.pluginId === definition.manifest.id)
      for (const instance of pluginInstances) {
        if (!instance.enabled) {
          this.setStatus(instance.instanceId, { phase: 'disabled' })
          continue
        }
        if (!definition.manifest.supportedScopes.includes(instance.scope.kind)) {
          this.setStatus(instance.instanceId, { phase: 'failed', error: `插件不支持 ${instance.scope.kind} scope` })
          continue
        }
        const missing = (definition.manifest.requires ?? []).find((id) =>
          !(enabledByPlugin.get(id) ?? []).some((dependency) => this.status(dependency.instanceId).phase === 'active'),
        )
        if (missing) {
          await this.deactivate(instance.instanceId)
          this.setStatus(instance.instanceId, { phase: 'failed', error: `缺少依赖插件：${missing}` })
          continue
        }
        if (!this.active.has(instance.instanceId)) await this.activate(definition, instance, enabledByPlugin)
      }
    }

    for (const instance of instances) {
      if (this.definitions.has(instance.pluginId)) continue
      this.setStatus(instance.instanceId, { phase: 'failed', error: `找不到插件定义：${instance.pluginId}` })
    }
  }

  async dispose(): Promise<void> {
    await this.syncQueue
    let firstError: unknown = null
    for (const instanceId of [...this.active.keys()].reverse()) {
      try {
        await this.deactivate(instanceId)
      } catch (error) {
        firstError ??= error
      }
    }
    if (firstError) throw firstError
  }

  private async activate(
    definition: HarnessPlugin,
    instance: PluginInstanceRecord,
    enabledByPlugin: Map<string, PluginInstanceRecord[]>,
  ): Promise<void> {
    const lifecycle = new LifecycleScope()
    const abortController = new AbortController()
    const metadata = { pluginId: instance.pluginId, instanceId: instance.instanceId, scope: instance.scope }
    this.setStatus(instance.instanceId, { phase: 'pending' })

    const context: PluginInstanceContext = {
      ...metadata,
      config: Object.freeze({ ...instance.config }),
      signal: abortController.signal,
      storage: this.options.storage(instance),
      effect: (disposer) => lifecycle.effect(disposer),
      services: {
        provide: <T,>(id: string, service: T) => lifecycle.effect(this.services.provide(id, service)),
        get: <T,>(id: string) => this.services.get<T>(id),
        optional: <T,>(id: string) => this.services.optional<T>(id),
      },
      events: {
        on: <T,>(event: string, handler: (payload: T) => void) => lifecycle.effect(this.events.on(event, handler)),
        emit: <T,>(event: string, payload: T) => this.events.emit(event, payload),
      },
      slots: {
        threadHeaderActions: {
          register: (contribution) => lifecycle.effect(this.threadHeaderActions.register({ ...metadata, contribution })),
        },
        newThreadPanels: {
          register: (contribution) => lifecycle.effect(this.newThreadPanels.register({ ...metadata, contribution })),
        },
        conversationTabs: {
          register: (contribution) => lifecycle.effect(this.tabs.register({ ...metadata, contribution })),
        },
        composerActions: {
          register: (contribution) => lifecycle.effect(this.composerActions.register({ ...metadata, contribution })),
        },
        composerCompletions: {
          register: (contribution) => lifecycle.effect(this.composerCompletions.register({ ...metadata, contribution })),
        },
        quickActions: {
          register: (contribution) => lifecycle.effect(this.quickActions.register({ ...metadata, contribution })),
        },
        quickCommands: {
          register: (contribution) => lifecycle.effect(this.quickCommands.register({ ...metadata, contribution })),
        },
      },
      commands: {
        register: (command) => lifecycle.effect(this.commands.register(instance.instanceId, command)),
      },
    }

    try {
      const disposer = await definition.activate(context)
      if (disposer) lifecycle.effect(disposer)
      this.active.set(instance.instanceId, {
        lifecycle,
        abortController,
        signature: instanceSignature(instance, definition, enabledByPlugin),
      })
      this.setStatus(instance.instanceId, { phase: 'active' })
    } catch (error) {
      abortController.abort()
      let cleanupError: unknown = null
      try {
        await lifecycle.dispose()
      } catch (nextError) {
        cleanupError = nextError
      }
      const detail = cleanupError ? `${messageOf(error)}；清理失败：${messageOf(cleanupError)}` : messageOf(error)
      this.setStatus(instance.instanceId, { phase: 'failed', error: detail })
    }
  }

  private async deactivate(instanceId: string): Promise<void> {
    const current = this.active.get(instanceId)
    if (!current) return
    this.active.delete(instanceId)
    current.abortController.abort()
    try {
      await current.lifecycle.dispose()
      this.setStatus(instanceId, { phase: 'disabled' })
    } catch (error) {
      this.setStatus(instanceId, { phase: 'failed', error: `插件资源清理失败：${messageOf(error)}` })
      throw error
    }
  }

  private setStatus(instanceId: string, status: PluginInstanceStatus): void {
    this.statuses.set(instanceId, status)
    this.options.onChange?.()
  }
}

export function sortPluginDefinitions(definitions: HarnessPlugin[]): HarnessPlugin[] {
  const byId = new Map(definitions.map((definition) => [definition.manifest.id, definition]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const ordered: HarnessPlugin[] = []

  const visit = (definition: HarnessPlugin) => {
    const id = definition.manifest.id
    if (visited.has(id)) return
    if (visiting.has(id)) throw new Error(`插件依赖存在循环：${[...visiting, id].join(' -> ')}`)
    visiting.add(id)
    for (const dependency of definition.manifest.requires ?? []) {
      const target = byId.get(dependency)
      if (target) visit(target)
    }
    visiting.delete(id)
    visited.add(id)
    ordered.push(definition)
  }

  for (const definition of definitions) visit(definition)
  return ordered
}

export function scopeMatches(scope: PluginScope, context: PluginViewContext): boolean {
  if (scope.kind === 'global') return true
  if (scope.kind === 'workspace') return scope.workspaceRoot === context.workspaceRoot
  return scope.threadId === context.threadId
}

export function resolveScopedContributions<T extends { id: string; order?: number }>(
  entries: ScopedContribution<T>[],
  context: PluginViewContext,
): ResolvedContribution<T>[] {
  const selected = new Map<string, ScopedContribution<T>>()
  for (const entry of entries) {
    if (!scopeMatches(entry.scope, context)) continue
    const key = `${entry.pluginId}:${entry.contribution.id}`
    const current = selected.get(key)
    if (!current || scopeRank(entry.scope) > scopeRank(current.scope)) selected.set(key, entry)
  }
  return [...selected.values()]
    .sort((left, right) => (left.contribution.order ?? 0) - (right.contribution.order ?? 0)
      || left.contribution.id.localeCompare(right.contribution.id))
    .map(({ pluginId, instanceId, contribution }) => ({ pluginId, instanceId, contribution }))
}

function scopeRank(scope: PluginScope): number {
  if (scope.kind === 'thread') return 3
  if (scope.kind === 'workspace') return 2
  return 1
}

function instanceSignature(
  instance: PluginInstanceRecord,
  definition: HarnessPlugin,
  enabledByPlugin: Map<string, PluginInstanceRecord[]>,
): string {
  const dependencies = (definition.manifest.requires ?? []).flatMap((id) =>
    (enabledByPlugin.get(id) ?? []).map((dependency) => [dependency.instanceId, dependency.updatedAt]),
  )
  return JSON.stringify([instance.pluginId, definition.manifest.version, instance.scope, instance.config, instance.updatedAt, dependencies])
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

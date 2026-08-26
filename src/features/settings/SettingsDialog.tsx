import { useEffect, useMemo, useState } from 'react'
import { Blocks, Check, Palette, Plus, Power, Trash2, Type, X } from 'lucide-react'
import { usePluginHost } from '../../core/plugins/react'
import type { FontSize, Thread, Workspace } from '../../core/domain/codex'
import { threadTitle } from '../../core/domain/codex'
import type { HarnessPlugin, PluginInstanceRecord, PluginInstanceStatus, PluginScope, PluginScopeKind } from '../../extensions/types'

interface SettingsDialogProps {
  fontSize: FontSize
  workspaces: Workspace[]
  threads: Thread[]
  selectedThreadId: string | null
  onFontSize: (fontSize: FontSize) => void
  onClose: () => void
}

type SettingsPage = 'appearance' | 'plugins'

const fontSizeOptions: Array<{ value: FontSize; label: string; detail: string }> = [
  { value: 'compact', label: '紧凑', detail: '信息密度更高' },
  { value: 'standard', label: '标准', detail: '当前推荐大小' },
  { value: 'large', label: '大', detail: '更舒适的阅读' },
]

export function SettingsDialog({ fontSize, workspaces, threads, selectedThreadId, onFontSize, onClose }: SettingsDialogProps) {
  const [page, setPage] = useState<SettingsPage>('appearance')
  const heading = page === 'appearance' ? '外观' : '插件'

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
        <aside className="settings-nav" aria-label="设置菜单">
          <div className="settings-nav-brand">
            <span className="settings-kicker">HARNESS</span>
            <h2>设置</h2>
          </div>
          <nav>
            <button type="button" className={page === 'appearance' ? 'selected' : ''} aria-current={page === 'appearance' ? 'page' : undefined} onClick={() => setPage('appearance')}>
              <Palette size={16} />外观
            </button>
            <button type="button" className={page === 'plugins' ? 'selected' : ''} aria-current={page === 'plugins' ? 'page' : undefined} onClick={() => setPage('plugins')}>
              <Blocks size={16} />插件
            </button>
          </nav>
        </aside>

        <div className="settings-panel">
          <header className="settings-panel-head">
            <div>
              <span className="settings-kicker">{page === 'appearance' ? 'APPEARANCE' : 'EXTENSIONS'}</span>
              <h2 id="settings-title">{heading}</h2>
            </div>
            <button type="button" className="settings-close" onClick={onClose} aria-label="关闭设置"><X size={18} /></button>
          </header>

          {page === 'appearance' ? (
            <AppearanceSettings fontSize={fontSize} onFontSize={onFontSize} />
          ) : (
            <PluginSettings workspaces={workspaces} threads={threads} selectedThreadId={selectedThreadId} />
          )}
        </div>
      </section>
    </div>
  )
}

function AppearanceSettings({ fontSize, onFontSize }: { fontSize: FontSize; onFontSize: (fontSize: FontSize) => void }) {
  return (
    <section className="settings-section" aria-labelledby="font-size-title">
      <div className="settings-section-title">
        <Type size={17} />
        <div>
          <h3 id="font-size-title">字体大小</h3>
          <p>立即应用，并仅保存在这台设备上。</p>
        </div>
      </div>
      <div className="font-size-options" role="radiogroup" aria-label="字体大小">
        {fontSizeOptions.map((option) => {
          const selected = fontSize === option.value
          return (
            <button key={option.value} type="button" role="radio" aria-checked={selected} className={selected ? 'selected' : ''} onClick={() => onFontSize(option.value)}>
              <span>{option.label}</span>
              <small>{option.detail}</small>
              {selected && <Check size={16} aria-hidden />}
            </button>
          )
        })}
      </div>
    </section>
  )
}

function PluginSettings({ workspaces, threads, selectedThreadId }: { workspaces: Workspace[]; threads: Thread[]; selectedThreadId: string | null }) {
  const plugins = usePluginHost()
  const [selectedPluginId, setSelectedPluginId] = useState(() => plugins.definitions[0]?.manifest.id ?? '')
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null)
  const selectedDefinition = plugins.definitions.find((definition) => definition.manifest.id === selectedPluginId) ?? plugins.definitions[0] ?? null
  const selectedInstances = selectedDefinition
    ? plugins.instances.filter((instance) => instance.pluginId === selectedDefinition.manifest.id)
    : []
  const selectedInstance = selectedInstances.find((instance) => instance.instanceId === selectedInstanceId) ?? selectedInstances[0] ?? null

  useEffect(() => {
    if (!selectedDefinition) return
    if (selectedDefinition.manifest.id !== selectedPluginId) setSelectedPluginId(selectedDefinition.manifest.id)
    if (selectedInstance?.instanceId !== selectedInstanceId) setSelectedInstanceId(selectedInstance?.instanceId ?? null)
  }, [selectedDefinition, selectedInstance, selectedInstanceId, selectedPluginId])

  const selectDefinition = (definition: HarnessPlugin) => {
    const firstInstance = plugins.instances.find((instance) => instance.pluginId === definition.manifest.id)
    setSelectedPluginId(definition.manifest.id)
    setSelectedInstanceId(firstInstance?.instanceId ?? null)
  }

  return (
    <section className="plugin-settings" aria-label="Harness 插件">
      <aside className="plugin-catalog">
        <div className="plugin-catalog-intro">
          <span>{plugins.definitions.length} 个内置插件</span>
          <p>选择插件与实例，在右侧调整归属和设置。</p>
        </div>
        <nav className="plugin-catalog-list" aria-label="插件列表">
          {plugins.loading ? <div className="plugin-settings-empty">正在读取插件实例…</div> : plugins.definitions.map((definition) => (
            <PluginDefinitionNav
              key={definition.manifest.id}
              definition={definition}
              instances={plugins.instances.filter((instance) => instance.pluginId === definition.manifest.id)}
              selected={definition.manifest.id === selectedDefinition?.manifest.id}
              selectedInstanceId={selectedInstance?.instanceId ?? null}
              workspaces={workspaces}
              threads={threads}
              selectedThreadId={selectedThreadId}
              onSelectDefinition={() => selectDefinition(definition)}
              onSelectInstance={(instanceId) => {
                setSelectedPluginId(definition.manifest.id)
                setSelectedInstanceId(instanceId)
              }}
            />
          ))}
        </nav>
      </aside>
      <div className="plugin-detail-scroll">
        {plugins.error && <div className="plugin-settings-error">{plugins.error}</div>}
        {!plugins.loading && selectedDefinition && selectedInstance ? (
          <PluginInstanceDetail
            definition={selectedDefinition}
            instance={selectedInstance}
            workspaces={workspaces}
            threads={threads}
            selectedThreadId={selectedThreadId}
          />
        ) : !plugins.loading && selectedDefinition ? (
          <div className="plugin-detail-empty"><Blocks size={20} /><strong>{selectedDefinition.manifest.name}</strong><p>这个插件还没有实例，请从左侧新增一个归属实例。</p></div>
        ) : null}
      </div>
    </section>
  )
}

function PluginDefinitionNav({ definition, instances, selected, selectedInstanceId, workspaces, threads, selectedThreadId, onSelectDefinition, onSelectInstance }: {
  definition: HarnessPlugin
  instances: PluginInstanceRecord[]
  selected: boolean
  selectedInstanceId: string | null
  workspaces: Workspace[]
  threads: Thread[]
  selectedThreadId: string | null
  onSelectDefinition(): void
  onSelectInstance(instanceId: string): void
}) {
  const plugins = usePluginHost()
  const availableScope = useMemo(
    () => nextAvailableScope(definition, instances, workspaces, threads, selectedThreadId),
    [definition, instances, selectedThreadId, threads, workspaces],
  )

  const addInstance = async () => {
    if (!availableScope) return
    const now = Date.now()
    const instance: PluginInstanceRecord = {
      instanceId: crypto.randomUUID(),
      pluginId: definition.manifest.id,
      scope: availableScope,
      enabled: true,
      config: {},
      createdAt: now,
      updatedAt: now,
    }
    await plugins.upsertInstance(instance)
    onSelectInstance(instance.instanceId)
  }

  return (
    <div className={`plugin-nav-group ${selected ? 'selected' : ''}`}>
      <div className="plugin-nav-heading">
        <button type="button" onClick={onSelectDefinition}>
          <span className="plugin-nav-mark"><Blocks size={14} /></span>
          <span><strong>{definition.manifest.name}</strong><small>v{definition.manifest.version} · {instances.length} 个实例</small></span>
        </button>
        <button type="button" className="plugin-nav-add" disabled={!availableScope} onClick={() => void addInstance().catch(() => undefined)} title={availableScope ? '新增插件实例' : '没有可用的新归属'} aria-label={`新增 ${definition.manifest.name} 实例`}>
          <Plus size={13} />
        </button>
      </div>
      {instances.length > 0 && <div className="plugin-nav-instances">
        {instances.map((instance) => (
          <button key={instance.instanceId} type="button" className={instance.instanceId === selectedInstanceId ? 'selected' : ''} aria-current={instance.instanceId === selectedInstanceId ? 'page' : undefined} onClick={() => onSelectInstance(instance.instanceId)}>
            <span className={`plugin-status-dot ${plugins.status(instance.instanceId).phase}`} />
            <span>{scopeSummary(instance.scope, workspaces, threads)}</span>
          </button>
        ))}
      </div>}
    </div>
  )
}

function PluginInstanceDetail({ definition, instance, workspaces, threads, selectedThreadId }: {
  definition: HarnessPlugin
  instance: PluginInstanceRecord
  workspaces: Workspace[]
  threads: Thread[]
  selectedThreadId: string | null
}) {
  const plugins = usePluginHost()
  const status = plugins.status(instance.instanceId)
  const Settings = definition.settings
  const persist = (next: PluginInstanceRecord) => plugins.upsertInstance(next).catch(() => undefined)
  const updateScopeKind = (kind: PluginScopeKind) => {
    const scope = scopeForKind(kind, workspaces, threads, selectedThreadId)
    if (scope) void persist({ ...instance, scope, updatedAt: Date.now() })
  }
  const updateOwner = (owner: string) => {
    const scope: PluginScope = instance.scope.kind === 'workspace'
      ? { kind: 'workspace', workspaceRoot: owner }
      : { kind: 'thread', threadId: owner }
    void persist({ ...instance, scope, updatedAt: Date.now() })
  }

  return (
    <article className="plugin-instance-detail">
      <header className="plugin-detail-head">
        <div>
          <span className="settings-kicker">PLUGIN INSTANCE</span>
          <h3>{definition.manifest.name}</h3>
          <p>{definition.manifest.description}</p>
          <code>{definition.manifest.id} · v{definition.manifest.version}</code>
        </div>
        <div className="plugin-instance-actions">
          <button type="button" className={instance.enabled ? 'enabled' : ''} onClick={() => void persist({ ...instance, enabled: !instance.enabled, updatedAt: Date.now() })}>
            <Power size={13} />{instance.enabled ? '已启用' : '已停用'}
          </button>
          {!instance.instanceId.endsWith(':default') && (
            <button type="button" className="danger" aria-label="删除实例" onClick={() => void plugins.deleteInstance(instance.instanceId).catch(() => undefined)}><Trash2 size={13} /></button>
          )}
        </div>
      </header>

      <div className="plugin-detail-status"><span className={`plugin-status ${status.phase}`}><span />{statusLabel(status.phase)}</span><span>{scopeSummary(instance.scope, workspaces, threads)}</span></div>

      <section className="plugin-detail-section">
        <div className="plugin-detail-section-title"><strong>实例归属</strong><p>切换会话只影响插件入口是否可见，不会停止后台实例。</p></div>
        <div className="plugin-scope-fields">
        <label>
          <span>归属</span>
          <select value={instance.scope.kind} onChange={(event) => updateScopeKind(event.target.value as PluginScopeKind)}>
            {definition.manifest.supportedScopes.map((kind) => (
              <option key={kind} value={kind} disabled={!scopeForKind(kind, workspaces, threads, selectedThreadId)}>{scopeKindLabel(kind)}</option>
            ))}
          </select>
        </label>
        {instance.scope.kind === 'workspace' && (
          <label>
            <span>Workspace</span>
            <select value={instance.scope.workspaceRoot} onChange={(event) => updateOwner(event.target.value)}>
              {workspaces.map((workspace) => <option key={workspace.root} value={workspace.root}>{workspace.name}</option>)}
            </select>
          </label>
        )}
        {instance.scope.kind === 'thread' && (
          <label>
            <span>Thread</span>
            <select value={instance.scope.threadId} onChange={(event) => updateOwner(event.target.value)}>
              {threads.map((thread) => <option key={thread.id} value={thread.id}>{threadTitle(thread)}</option>)}
            </select>
          </label>
        )}
        </div>
      </section>

      {status.phase === 'failed' && <div className="plugin-instance-error">{status.error}</div>}
      {Settings ? (
        <section className="plugin-detail-section">
          <div className="plugin-detail-section-title"><strong>插件设置</strong><p>这些配置只属于当前实例。</p></div>
          <Settings instance={instance} saveConfig={(config) => plugins.upsertInstance({ ...instance, config, updatedAt: Date.now() })} />
        </section>
      ) : (
        <section className="plugin-detail-section"><div className="plugin-detail-section-title"><strong>插件设置</strong><p>这个插件没有额外的业务设置。</p></div></section>
      )}
    </article>
  )
}

function nextAvailableScope(
  definition: HarnessPlugin,
  instances: PluginInstanceRecord[],
  workspaces: Workspace[],
  threads: Thread[],
  selectedThreadId: string | null,
): PluginScope | null {
  const used = new Set(instances.map((instance) => scopeIdentity(instance.scope)))
  if (definition.manifest.supportedScopes.includes('global') && !used.has('global')) return { kind: 'global' }
  if (definition.manifest.supportedScopes.includes('workspace')) {
    const workspace = workspaces.find((candidate) => !used.has(`workspace:${candidate.root}`))
    if (workspace) return { kind: 'workspace', workspaceRoot: workspace.root }
  }
  if (definition.manifest.supportedScopes.includes('thread')) {
    const ordered = selectedThreadId
      ? [...threads].sort((left, right) => Number(right.id === selectedThreadId) - Number(left.id === selectedThreadId))
      : threads
    const thread = ordered.find((candidate) => !used.has(`thread:${candidate.id}`))
    if (thread) return { kind: 'thread', threadId: thread.id }
  }
  return null
}

function scopeForKind(kind: PluginScopeKind, workspaces: Workspace[], threads: Thread[], selectedThreadId: string | null): PluginScope | null {
  if (kind === 'global') return { kind: 'global' }
  if (kind === 'workspace') return workspaces[0] ? { kind: 'workspace', workspaceRoot: workspaces[0].root } : null
  const thread = threads.find((candidate) => candidate.id === selectedThreadId) ?? threads[0]
  return thread ? { kind: 'thread', threadId: thread.id } : null
}

function scopeIdentity(scope: PluginScope): string {
  if (scope.kind === 'workspace') return `workspace:${scope.workspaceRoot}`
  if (scope.kind === 'thread') return `thread:${scope.threadId}`
  return 'global'
}

function scopeKindLabel(kind: PluginScopeKind): string {
  if (kind === 'workspace') return 'Workspace'
  if (kind === 'thread') return 'Thread'
  return '全局'
}

function scopeSummary(scope: PluginScope, workspaces: Workspace[], threads: Thread[]): string {
  if (scope.kind === 'workspace') return workspaces.find((workspace) => workspace.root === scope.workspaceRoot)?.name ?? scope.workspaceRoot
  if (scope.kind === 'thread') {
    const thread = threads.find((candidate) => candidate.id === scope.threadId)
    return thread ? threadTitle(thread) : scope.threadId
  }
  return '全局'
}

function statusLabel(phase: PluginInstanceStatus['phase']): string {
  if (phase === 'active') return '运行中'
  if (phase === 'pending') return '启动中'
  if (phase === 'failed') return '启动失败'
  return '已停止'
}

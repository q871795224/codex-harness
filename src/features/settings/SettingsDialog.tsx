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

  return (
    <section className="settings-section plugin-settings" aria-label="Harness 插件">
      <div className="settings-section-title">
        <Blocks size={17} />
        <div>
          <h3>Harness 插件</h3>
          <p>每个实例拥有独立归属和配置；切换会话只改变可见性，不会停止后台实例。</p>
        </div>
      </div>

      {plugins.error && <div className="plugin-settings-error">{plugins.error}</div>}
      {plugins.loading ? <div className="plugin-settings-empty">正在读取插件实例…</div> : plugins.definitions.map((definition) => (
        <PluginDefinitionCard
          key={definition.manifest.id}
          definition={definition}
          instances={plugins.instances.filter((instance) => instance.pluginId === definition.manifest.id)}
          workspaces={workspaces}
          threads={threads}
          selectedThreadId={selectedThreadId}
        />
      ))}
    </section>
  )
}

function PluginDefinitionCard({ definition, instances, workspaces, threads, selectedThreadId }: {
  definition: HarnessPlugin
  instances: PluginInstanceRecord[]
  workspaces: Workspace[]
  threads: Thread[]
  selectedThreadId: string | null
}) {
  const plugins = usePluginHost()
  const availableScope = useMemo(
    () => nextAvailableScope(definition, instances, workspaces, threads, selectedThreadId),
    [definition, instances, selectedThreadId, threads, workspaces],
  )

  const addInstance = () => {
    if (!availableScope) return
    const now = Date.now()
    void plugins.upsertInstance({
      instanceId: crypto.randomUUID(),
      pluginId: definition.manifest.id,
      scope: availableScope,
      enabled: true,
      config: {},
      createdAt: now,
      updatedAt: now,
    }).catch(() => undefined)
  }

  return (
    <article className="plugin-definition-card">
      <header>
        <div>
          <strong>{definition.manifest.name}</strong>
          <span>{definition.manifest.id} · v{definition.manifest.version}</span>
        </div>
        <button type="button" className="plugin-add" disabled={!availableScope} onClick={addInstance} title={availableScope ? '新增插件实例' : '没有可用的新归属'}>
          <Plus size={14} />实例
        </button>
      </header>
      <p>{definition.manifest.description}</p>
      <div className="plugin-instance-list">
        {instances.map((instance) => (
          <PluginInstanceCard
            key={instance.instanceId}
            definition={definition}
            instance={instance}
            workspaces={workspaces}
            threads={threads}
            selectedThreadId={selectedThreadId}
          />
        ))}
      </div>
    </article>
  )
}

function PluginInstanceCard({ definition, instance, workspaces, threads, selectedThreadId }: {
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
    <div className="plugin-instance-card">
      <div className="plugin-instance-head">
        <span className={`plugin-status ${status.phase}`}><span />{statusLabel(status.phase)}</span>
        <div className="plugin-instance-actions">
          <button type="button" className={instance.enabled ? 'enabled' : ''} onClick={() => void persist({ ...instance, enabled: !instance.enabled, updatedAt: Date.now() })}>
            <Power size={13} />{instance.enabled ? '已启用' : '已停用'}
          </button>
          {!instance.instanceId.endsWith(':default') && (
            <button type="button" className="danger" aria-label="删除实例" onClick={() => void plugins.deleteInstance(instance.instanceId).catch(() => undefined)}><Trash2 size={13} /></button>
          )}
        </div>
      </div>

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

      {status.phase === 'failed' && <div className="plugin-instance-error">{status.error}</div>}
      {Settings && <Settings instance={instance} saveConfig={(config) => plugins.upsertInstance({ ...instance, config, updatedAt: Date.now() })} />}
    </div>
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

function statusLabel(phase: PluginInstanceStatus['phase']): string {
  if (phase === 'active') return '运行中'
  if (phase === 'pending') return '启动中'
  if (phase === 'failed') return '启动失败'
  return '已停止'
}

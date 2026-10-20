import type { useUnifiedHarness } from '../../features/conversation/useUnifiedHarness'
import type { useCodexCore } from '../../features/codex/useCodexCore'
import type { usePluginHost } from '../plugins/react'
import type { PluginInstanceRecord, PluginScope, PluginViewContext } from '../../extensions/types'
import { runtime } from '../runtime/bridge'
import { appServer } from '../runtime/appServerClient'
import { managementMethods, type ManagementRequest } from './types'

export interface ManagementContext {
  harness: ReturnType<typeof useUnifiedHarness>
  codex: ReturnType<typeof useCodexCore>
  plugins: ReturnType<typeof usePluginHost>
  flavor: string
}
const configKeys = ['model', 'model_reasoning_effort', 'service_tier', 'approval_policy'] as const

function text(p: Record<string, unknown>, key: string): string {
  const value = p[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`缺少 ${key}`)
  return value.trim()
}
function boolean(p: Record<string, unknown>, key: string): boolean {
  if (typeof p[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`)
  return p[key]
}
function provider(p: Record<string, unknown>): 'codex' | 'claude' {
  const value = p.provider ?? 'codex'
  if (value !== 'codex' && value !== 'claude') throw new Error('provider 必须是 codex 或 claude')
  return value
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('需要 JSON 对象')
  return value as Record<string, unknown>
}
function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, i) => sameJson(value, right[i]))
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) || Array.isArray(right)) return false
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
}
function scope(value: unknown): PluginScope {
  const input = object(value)
  if (input.kind === 'global') return { kind: 'global' }
  if (input.kind === 'workspace') return { kind: 'workspace', workspaceRoot: text(input, 'workspaceRoot') }
  if (input.kind === 'thread') return { kind: 'thread', threadId: text(input, 'threadId') }
  throw new Error('scope.kind 必须是 global、workspace 或 thread')
}

/** Query the mounted application's final catalog, rather than rebuilding it from SQLite. */
export function createManagementHandler(get: () => ManagementContext) {
  async function waitFor<T>(read: () => T | undefined): Promise<T> {
    const until = Date.now() + 5_000
    do {
      const value = read()
      if (value !== undefined) return value
      await new Promise((resolve) => setTimeout(resolve, 20))
    } while (Date.now() < until)
    throw new Error('操作已提交，但运行时回读未确认；请查询实际状态，不要自动重复写入')
  }
  function pluginInstance(id: string): PluginInstanceRecord {
    const found = get().plugins.instances.find((instance) => instance.instanceId === id)
    if (!found) throw new Error(`插件实例不存在: ${id}`)
    return found
  }
  function instanceSummary(instance: PluginInstanceRecord) {
    return { instanceId: instance.instanceId, pluginId: instance.pluginId, scope: instance.scope,
      enabled: instance.enabled, configKeys: Object.keys(instance.config), status: get().plugins.status(instance.instanceId) }
  }
  async function savePlugin(instance: PluginInstanceRecord) {
    await get().plugins.upsertInstance(instance)
    const saved = await waitFor(() => {
      const current = get().plugins.instances.find((candidate) => candidate.instanceId === instance.instanceId)
      if (!current || current.enabled !== instance.enabled || !sameJson(current.config, instance.config)) return undefined
      const phase = get().plugins.status(instance.instanceId).phase
      if (current.enabled ? !['active', 'failed'].includes(phase) : phase !== 'disabled') return undefined
      return current
    })
    return instanceSummary(saved)
  }
  return async ({ method, params: p }: ManagementRequest): Promise<unknown> => {
    if (!Object.hasOwn(managementMethods, method)) throw new Error(`不支持的管理操作: ${method}`)
    const { harness: h, plugins, codex, flavor } = get()
    if (method !== 'status' && method !== 'capabilities' && (h.phase !== 'ready' || plugins.loading)) {
      throw new Error('应用目录尚未加载完成，请稍后查询')
    }
    switch (method) {
      case 'capabilities':
        return { protocolVersion: 1, methods: Object.entries(managementMethods).map(([name, writes]) => ({ name, writes })),
          pluginSystem: 'Harness PluginHost（与 Codex/Claude 插件各自独立）', scope: '运行中的 Harness 实例；不启动模型轮次' }
      case 'status':
        return { versions: await runtime.getRuntimeVersions(), flavor, phase: h.phase, selectedProvider: h.selectedProvider,
          selectedThreadId: h.selectedThreadId, claude: h.claudeStatus, plugins: { loading: plugins.loading, error: plugins.error },
          observedAt: new Date().toISOString(), source: 'mounted Harness services' }
      case 'workspaces.list': {
        const registered = new Set((await runtime.listWorkspaces()).map((workspace) => workspace.root))
        const visible = new Set(h.workspaces.map((workspace) => workspace.root))
        return { source: 'live merged workspace catalog', coverage: 'current application catalog, including hidden entries',
          count: h.workspaces.length, catalogCount: h.allWorkspaces.length,
          data: h.allWorkspaces.map((workspace) => ({ ...workspace, visible: visible.has(workspace.root),
            registered: registered.has(workspace.root), discovered: !registered.has(workspace.root) })) }
      }
      case 'workspaces.add':
      case 'workspaces.show': {
        const workspace = await h.chooseWorkspace(text(p, 'path'))
        if (!workspace) throw new Error('工作区添加失败，请查看 Harness 通知详情')
        const saved = await waitFor(() => get().harness.workspaces.find((item) => item.root === workspace.root))
        await confirmWorkspaceVisibility(workspace.root, true)
        return saved
      }
      case 'workspaces.hide': {
        const root = text(p, 'root')
        if (!h.workspaces.some((workspace) => workspace.root === root)) throw new Error('工作区不在当前可见列表中')
        h.removeWorkspace(root)
        await waitFor(() => !get().harness.workspaces.some((workspace) => workspace.root === root) ? true : undefined)
        await confirmWorkspaceVisibility(root, false)
        return { root, visible: false, deleted: false }
      }
      case 'sessions.list':
        return { source: 'live conversation view', coverage: 'loaded view only; search and pagination may omit sessions', complete: false,
          view: h.viewMode, selectedThreadId: h.selectedThreadId, data: h.threads.map((thread) => ({ id: thread.id, name: thread.name,
            cwd: thread.cwd, provider: thread.id.startsWith('claude:') ? 'claude' : 'codex', createdAt: thread.createdAt,
            updatedAt: thread.updatedAt, activeTurnId: h.activeTurnIds[thread.id] ?? null })) }
      case 'sessions.create': {
        const cwd = text(p, 'cwd'), mappings = await runtime.mapThreadWorkspaces([cwd])
        if (!mappings[cwd]) throw new Error('cwd 不是可用的 Git checkout')
        const id = await h.createThread(provider(p), mappings[cwd]!.checkoutRoot)
        if (!id) throw new Error('会话创建失败，请查看 Harness 通知详情')
        return waitFor(() => get().harness.threads.find((thread) => thread.id === id)
          ? { id, cwd: mappings[cwd]!.checkoutRoot, provider: provider(p) } : undefined)
      }
      case 'sessions.select': {
        const id = text(p, 'id')
        await h.openThread(id)
        await waitFor(() => get().harness.selectedThreadId === id ? true : undefined)
        return { id, selected: true }
      }
      case 'sessions.rename': {
        const id = text(p, 'id'), name = text(p, 'name')
        if (!h.threads.some((thread) => thread.id === id)) throw new Error('请先选择会话，将其加载到当前视图')
        await h.renameThread(id, name)
        return waitFor(() => get().harness.threads.find((thread) => thread.id === id)?.name === name ? { id, name } : undefined)
      }
      case 'sessions.archive': {
        const id = text(p, 'id')
        if (h.viewMode !== 'active' || !h.threads.some((thread) => thread.id === id)) throw new Error('会话不在当前活动视图中')
        if (h.activeTurnIds[id]) throw new Error('会话仍在运行，请等当前轮完成后归档')
        await h.archiveThread(id)
        await waitFor(() => !get().harness.threads.some((thread) => thread.id === id) ? true : undefined)
        return { id, archivedOrEmptyDraftClosed: true }
      }
      case 'sessions.restore': {
        const id = text(p, 'id')
        await h.unarchiveThread(id)
        await waitFor(() => get().harness.viewMode === 'active' && get().harness.threads.some((thread) => thread.id === id) ? true : undefined)
        return { id, archived: false }
      }
      case 'plugins.list': {
        const threadId = typeof p.threadId === 'string' ? p.threadId : p.workspaceRoot === undefined ? h.selectedThreadId : null
        const thread = h.threads.find((candidate) => candidate.id === threadId)
        const context: PluginViewContext = { provider: p.provider === undefined
          ? threadId ? threadId.startsWith('claude:') ? 'claude' : 'codex' : h.selectedProvider : provider(p),
          threadId, threadCwd: typeof p.cwd === 'string' ? p.cwd : thread?.cwd ?? null,
          workspaceRoot: typeof p.workspaceRoot === 'string' ? p.workspaceRoot
            : h.workspaces.find((workspace) => workspace.root === (threadId ? h.threadRoots[threadId] : null))?.root ?? null }
        const entries = { tabs: plugins.resolvedTabs(context), headerActions: plugins.resolvedThreadHeaderActions(context),
          newThreadPanels: plugins.resolvedNewThreadPanels(context), composerActions: plugins.resolvedComposerActions(context),
          turnActions: plugins.resolvedTurnActions(context), completions: plugins.resolvedComposerCompletions(context),
          quickActions: plugins.resolvedQuickActions(context), quickCommands: plugins.resolvedQuickCommands(context) }
        return { source: 'Harness PluginHost', context, definitions: plugins.definitions.map((definition) => definition.manifest),
          instances: plugins.instances.map(instanceSummary),
          contributions: Object.fromEntries(Object.entries(entries).map(([slot, values]) => [slot, values.map((entry) => {
            const contribution = entry.contribution as unknown as Record<string, unknown>
            return { pluginId: entry.pluginId, instanceId: entry.instanceId, id: contribution.id,
              label: contribution.label ?? contribution.title ?? contribution.name }
          })])) }
      }
      case 'plugins.create': {
        const definition = plugins.definitions.find((candidate) => candidate.manifest.id === text(p, 'pluginId'))
        if (!definition) throw new Error('插件定义不存在')
        const target = scope(p.scope)
        if (!definition.manifest.supportedScopes.includes(target.kind)) throw new Error('插件不支持该作用域')
        if (!definition.allowMultipleInstancesPerScope && plugins.instances.some((candidate) => candidate.pluginId === definition.manifest.id
          && sameJson(candidate.scope, target))) throw new Error('该作用域已有插件实例')
        return savePlugin({ instanceId: crypto.randomUUID(), pluginId: definition.manifest.id, scope: target,
          enabled: p.enabled === undefined ? true : boolean(p, 'enabled'), config: p.config === undefined
            ? definition.createInstanceConfig?.() ?? {} : object(p.config), createdAt: Date.now(), updatedAt: Date.now() })
      }
      case 'plugins.setEnabled':
        return savePlugin({ ...pluginInstance(text(p, 'instanceId')), enabled: boolean(p, 'enabled') })
      case 'plugins.configure': {
        const instance = pluginInstance(text(p, 'instanceId'))
        return savePlugin({ ...instance, config: { ...instance.config, ...object(p.patch) } })
      }
      case 'plugins.delete': {
        const id = text(p, 'instanceId')
        pluginInstance(id)
        await plugins.deleteInstance(id)
        await waitFor(() => !get().plugins.instances.some((instance) => instance.instanceId === id)
          && !['active', 'pending'].includes(get().plugins.status(id).phase) ? true : undefined)
        return { instanceId: id, deleted: true, status: get().plugins.status(id) }
      }
      case 'skills.list': {
        const cwd = text(p, 'cwd')
        if (provider(p) === 'claude') return runtime.claudeRequest('provider/skills', { cwd })
        return { source: 'Codex App Server skills/list', ...await appServer.listSkills(cwd, p.reload === true) }
      }
      case 'skills.setEnabled': {
        if (provider(p) !== 'codex') throw new Error('Claude Skill 启停尚无此管理接口；请走 Skill 的源码 fallback')
        const cwd = text(p, 'cwd'), path = text(p, 'path'), enabled = boolean(p, 'enabled')
        const current = await appServer.listSkills(cwd)
        if (!current.data.some((entry) => entry.skills.some((skill) => skill.path === path))) throw new Error('Skill 不在该工作区运行时列表中')
        await appServer.setSkillEnabled(path, enabled)
        const saved = (await appServer.listSkills(cwd, true)).data.flatMap((entry) => entry.skills).find((skill) => skill.path === path)
        if (!saved || saved.enabled !== enabled) throw new Error('Skill 配置已提交，但回读未确认')
        return saved
      }
      case 'mcp.reload':
        await appServer.reloadMcpServers()
        await codex.refreshMcp()
        return { source: 'Codex App Server', ...await appServer.listMcpServers() }
      case 'mcp.list':
        return { source: 'Codex App Server', ...await appServer.listMcpServers() }
      case 'config.read': {
        const result = await appServer.readConfig()
        return Object.fromEntries(configKeys.map((key) => [key, result.config[key] ?? null]))
      }
      case 'config.set': {
        const key = text(p, 'key'), value = text(p, 'value')
        if (!(configKeys as readonly string[]).includes(key)) throw new Error('仅支持模型、推理强度、service_tier 和 approval_policy')
        if (key === 'approval_policy' && !['untrusted', 'on-request', 'never'].includes(value)) throw new Error('approval_policy 无效')
        await appServer.writeConfigValue(key, value)
        await codex.reload()
        const readback = (await appServer.readConfig()).config[key as typeof configKeys[number]]
        if (readback !== value) throw new Error('配置已提交，但回读未确认；可能受到更高优先级配置约束')
        return { key, value: readback }
      }
    }
  }
}

async function confirmWorkspaceVisibility(root: string, visible: boolean) {
  const until = Date.now() + 5_000
  do {
    const raw = await runtime.getAppState('navigationPreferences')
    if (raw) {
      const preferences = JSON.parse(raw) as { hiddenWorkspaceRoots?: string[] }
      if (!preferences.hiddenWorkspaceRoots?.includes(root) === visible) return
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  } while (Date.now() < until)
  throw new Error('工作区界面已更新，但持久化回读未确认')
}

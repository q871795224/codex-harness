import { settingsCatalog, settingsGroup, readSettings, updateSettings } from './settings'
import { pluginSettings, validatePluginPatch } from './pluginSettings'
import { keys, number, sameJson } from './validation'
import { notifications } from '../notifications/service'
import { refreshRouterSummaries } from '../workspace-router/summaries'
import { prepareRouterPreview, routingCandidates, readRouteRecord } from '../workspace-router/service'
import { loadRouterSettings } from '../workspace-router/settings'
import { textInput } from '../domain/codex'
import type { CreateAsyncWait, AsyncWaitAction } from '../async-waits/types'
import type { useUnifiedHarness } from '../../features/conversation/useUnifiedHarness'
import type { useCodexCore } from '../../features/codex/useCodexCore'
import type { usePluginHost } from '../plugins/react'
import type { PluginInstanceRecord, PluginScope, PluginViewContext } from '../../extensions/types'
import { runtime } from '../runtime/bridge'
import { appServer } from '../runtime/appServerClient'
import { managementMethods, type ManagementRequest } from './types'
import type { ProjectOnboardingService } from '../project-onboarding/types'

export interface ManagementContext {
  onboarding?: ProjectOnboardingService
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
      case 'projects.list':
        if (!get().onboarding) throw new Error('项目会话接入服务不可用')
        return { data: await get().onboarding!.listProjects() }
      case 'projects.get': {
        const projectId = text(p, 'projectId')
        return { ...await runtime.projectDocGet(projectId), workspaceRoots: await runtime.projectDocWorkspaces(projectId) }
      }
      case 'projects.update': {
        const projectId = text(p, 'projectId'), patch = object(p.patch)
        keys(patch, ['name', 'shortName'], true)
        const current = await runtime.projectDocGet(projectId)
        if (p.expected !== undefined && !sameJson(object(p.expected), { name: current.name, shortName: current.shortName ?? null })) throw new Error('项目元数据已变化，请重新读取')
        if (patch.name !== undefined) text(patch, 'name')
        if (patch.shortName !== undefined && (typeof patch.shortName !== 'string' || Array.from(patch.shortName.trim()).length > 12 || /[\p{Cc}\[\]【】]/u.test(patch.shortName))) throw new Error('项目简称须为最多12字符的单行文本，不含方括号')
        if (patch.name !== undefined) await runtime.projectDocRename(projectId, text(patch, 'name'))
        if (patch.shortName !== undefined) await runtime.projectDocSetShortName(projectId, (patch.shortName as string).trim(), false)
        const saved = await runtime.projectDocGet(projectId)
        if ((patch.name !== undefined && saved.name !== (patch.name as string).trim()) || (patch.shortName !== undefined && (saved.shortName ?? '') !== (patch.shortName as string).trim())) throw new Error('项目元数据已提交，但回读未确认，请查询实际状态')
        return saved
      }
      case 'models.list':
        return { provider: provider(p), data: provider(p) === 'codex' ? codex.models : h.claudeModels, source: 'mounted provider model catalog' }
      case 'settings.list':
        return { groups: settingsCatalog, codexDefaults: 'config.read / config.set', pluginSettings: 'plugins.read / plugins.configure' }
      case 'settings.read': {
        const group = settingsGroup(p.group)
        return { group, settings: await readSettings(group, get()), ...settingsCatalog[group] }
      }
      case 'settings.update': {
        const group = settingsGroup(p.group)
        if (p.expected !== undefined && !sameJson(object(p.expected), await readSettings(group, get()))) throw new Error('设置已变化，请重新读取再更新')
        return updateSettings(group, object(p.patch), get, waitFor)
      }
      case 'router.summaries':
        return { data: await runtime.routerSummaries(h.workspaces.map(w => w.root)) }
      case 'router.refresh': {
        if (p.all === true && p.root !== undefined) throw new Error('root和all不能同时提供')
        const roots = p.all === true ? h.workspaces.map(w => w.root) : [text(p, 'root')]
        if (p.all !== undefined && typeof p.all !== 'boolean') throw new Error('all 必须是布尔值')
        const workspaces = roots.map(root => {
          const found = h.workspaces.find(w => w.root === root)
          if (!found) throw new Error('请使用可见工作区的root')
          return found
        })
        // A full sweep may take longer than a management request. The existing
        // lease-aware queue owns execution; this receipt does not claim completion.
        void refreshRouterSummaries(workspaces, () => false, true).catch(error => get().harness.notify('Router介绍检查失败', 'error', error))
        return { accepted: true, roots, statusMethod: 'router.summaries', changedDocumentsMayUseModel: true }
      }
      case 'router.preview': {
        if (p.input !== undefined && typeof p.input !== 'string') throw new Error('input 必须是文本')
        const settings = await loadRouterSettings()
        const candidates = await routingCandidates(h.workspaces, settings)
        return { prompt: candidates.length ? await prepareRouterPreview([textInput((p.input as string | undefined) ?? '{{用户输入}}')], candidates, settings) : '', modelCalled: false, userInputIsPlaceholder: p.input === undefined }
      }
      case 'router.record':
        return { data: await readRouteRecord(text(p, 'threadId')) }
      case 'router.feedback':
        return runtime.routerFeedback(p.offset === undefined ? 0 : number(p.offset, 0, Number.MAX_SAFE_INTEGER, 'offset'), p.limit === undefined ? 20 : number(p.limit, 1, 100, 'limit'))
      case 'router.setFeedback':
      case 'router.correct': {
        const id = text(p, 'threadId')
        if (id.startsWith('claude:') || !h.threads.some(t => t.id === id)) throw new Error('请先在Harness加载目标Codex会话')
        const record = await readRouteRecord(id)
        if (!record || record.status !== 'started') throw new Error('该会话没有已启动的Router任务')
        const accurate = method === 'router.correct' ? false : boolean(p, 'accurate')
        if (!accurate && !Object.hasOwn(p, 'actualWorkspace')) throw new Error('请明确actualWorkspace，通用工作区使用null')
        const actual = accurate || p.actualWorkspace === null ? null : text(p, 'actualWorkspace')
        const beforeCwd = h.threads.find(t => t.id === id)?.cwd
        let afterCwd = beforeCwd
        if (method === 'router.correct') {
          const target = actual === null ? await runtime.routerWorkspaceDirectory() : h.workspaces.find(w => w.root === actual)?.checkoutRoot
          if (!target) throw new Error('目标工作区已移除')
          await h.correctRouteWorkspace(id, actual)
          afterCwd = await waitFor(() => get().harness.threads.find(t => t.id === id)?.cwd === target ? target : undefined)
        } else await h.giveRouteFeedback(id, accurate, actual)
        const saved = await readRouteRecord(id)
        if (saved?.feedback !== (accurate ? 'accurate' : 'inaccurate') || saved.actualWorkspace !== actual) throw new Error('反馈已提交，但回读未确认')
        return { record: saved, workspaceChanged: afterCwd !== beforeCwd, cwd: afterCwd, taskReplayed: false }
      }
      case 'notifications.list': {
        await notifications.initialize()
        const state = notifications.snapshot()
        if (state.storageError) throw new Error('通知历史读取失败，请在通知中心检查')
        const offset = p.offset === undefined ? 0 : number(p.offset, 0, Number.MAX_SAFE_INTEGER, 'offset')
        const limit = p.limit === undefined ? 50 : number(p.limit, 1, 100, 'limit')
        if (p.unread !== undefined && typeof p.unread !== 'boolean') throw new Error('unread 必须是布尔值')
        const threadId = p.threadId === undefined ? undefined : text(p, 'threadId')
        const records = state.records.filter(r => (!threadId || r.threadId === threadId) && (!p.unread || !r.read))
        return { data: records.slice(offset, offset + limit).map(({ details: _details, ...record }) => record), hasMore: offset + limit < records.length, inAppReminderOverlay: false }
      }
      case 'notifications.markRead': {
        if (p.all === true && p.id !== undefined) throw new Error('id和all不能同时提供')
        await notifications.initialize()
        if (notifications.snapshot().storageError) throw new Error('通知历史尚未加载')
        const id = p.all === true ? undefined : text(p, 'id')
        if (p.all !== undefined && typeof p.all !== 'boolean') throw new Error('all 必须是布尔值')
        if (id && !notifications.snapshot().records.some(r => r.id === id)) throw new Error('通知不存在')
        notifications.markRead(id)
        await notifications.flushed()
        if (notifications.snapshot().storageError) throw new Error('通知已标记，但保存未确认，请先查询状态')
        return { id: id ?? null, all: !id, read: true, sourceActionsResolved: false }
      }
      case 'seatalk.status': {
        const status = object(await runtime.seatalkRemoteCall('status'))
        return Object.fromEntries(['reachable', 'connected', 'accountId', 'ownerId', 'state', 'interactiveCards'].filter(k => ['boolean', 'string', 'number'].includes(typeof status[k])).map(k => [k, status[k]]))
      }
      case 'seatalk.bindings': {
        const response = object(await runtime.seatalkRemoteCall('bindings'))
        const bindings = response.data ?? response.bindings
        if (!Array.isArray(bindings)) throw new Error('SeaTalk绑定响应无效')
        return { data: bindings.map(value => { const b = object(value); return Object.fromEntries(['threadId', 'rootId', 'createdAt'].filter(k => ['string', 'number'].includes(typeof b[k])).map(k => [k, b[k]])) }) }
      }
      case 'plugins.read': {
        const instance = pluginInstance(text(p, 'instanceId'))
        const settings = pluginSettings(instance)
        return { ...instanceSummary(instance), settings, editableFields: Object.keys(settings), hiddenConfigKeys: Object.keys(instance.config).filter(k => !Object.hasOwn(settings, k)) }
      }
      case 'capabilities':
        return { settingsGroups: Object.keys(settingsCatalog), manualOnly: ['project-document-compaction', 'project-onboarding', 'custom-async-wait-approval'], asyncWaitTools: ['ci', 'sdp', 'seatalk', 'sleep', 'custom'], protocolVersion: 1, methods: Object.entries(managementMethods).map(([name, writes]) => ({ name, writes })),
          pluginSystem: 'Harness PluginHost（与 Codex/Claude 插件各自独立）', scope: '运行中的 Harness 实例；CI/SDP 通知并预填，SeaTalk/sleep/获批自定义任务唤醒来源会话' }
      case 'status':
        return { versions: await runtime.getRuntimeVersions(), flavor, phase: h.phase, selectedProvider: h.selectedProvider,
          selectedThreadId: h.selectedThreadId, claude: h.claudeStatus, plugins: { loading: plugins.loading, error: plugins.error },
          observedAt: new Date().toISOString(), source: 'mounted Harness services' }
      case 'asyncWaits.list':
        return runtime.listAsyncWaits()
      case 'asyncWaits.create': {
        keys(p, ['id', 'threadId', 'title', 'continuation', 'checkerPath', 'target', 'condition'])
        // Native deserialization validates the discriminated target and rejects unknown fields.
        return runtime.createAsyncWait({ id: text(p, 'id'), threadId: text(p, 'threadId'), title: text(p, 'title'), continuation: text(p, 'continuation'),
          ...(p.condition !== undefined ? { condition: text(p, 'condition') } : {}),
          ...(p.checkerPath !== undefined ? { checkerPath: text(p, 'checkerPath') } : {}),
          ...(p.target !== undefined ? { target: object(p.target) as CreateAsyncWait['target'] } : {}) })
      }
      case 'asyncWaits.action': {
        const action = text(p, 'action')
        if (!['check', 'pause', 'resume', 'cancel', 'acknowledge'].includes(action)) throw new Error('异步任务操作无效')
        return runtime.asyncWaitAction(text(p, 'id'), action as AsyncWaitAction)
      }
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
        if (p.cwd === undefined) {
          const id = await h.createThread(provider(p))
          if (!id) throw new Error('会话创建失败')
          return waitFor(() => { const thread = get().harness.threads.find(t => t.id === id); return thread ? { id, cwd: thread.cwd, provider: provider(p), automaticWorkspace: provider(p) === 'codex' } : undefined })
        }
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
          conversationBanners: plugins.resolvedConversationBanners(context), newThreadPanels: plugins.resolvedNewThreadPanels(context), composerActions: plugins.resolvedComposerActions(context),
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
        const instance: PluginInstanceRecord = { instanceId: crypto.randomUUID(), pluginId: definition.manifest.id, scope: target,
          enabled: p.enabled === undefined ? true : boolean(p, 'enabled'), config: p.config === undefined
            ? definition.createInstanceConfig?.() ?? {} : object(p.config), createdAt: Date.now(), updatedAt: Date.now() }
        if (p.config !== undefined) validatePluginPatch(instance, object(p.config))
        return savePlugin(instance)
      }
      case 'plugins.setEnabled':
        return savePlugin({ ...pluginInstance(text(p, 'instanceId')), enabled: boolean(p, 'enabled') })
      case 'plugins.configure': {
        const instance = pluginInstance(text(p, 'instanceId'))
        const patch = object(p.patch)
        validatePluginPatch(instance, patch)
        return savePlugin({ ...instance, config: { ...instance.config, ...patch } })
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

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import type { AppServerEvent, JsonObject, ThreadUiState, Workspace } from '../domain/codex'
import type { PluginInstanceRecord, PluginScope } from '../../extensions/types'

interface PluginInstanceDto {
  instanceId: string
  pluginId: string
  scopeKind: PluginScope['kind']
  scopeKey: string | null
  enabled: boolean
  config: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export const runtime = {
  request<T>(method: string, params: JsonObject = {}): Promise<T> {
    return invoke<T>('app_server_request', { method, params })
  },

  respond(id: string | number, result: JsonObject): Promise<void> {
    return invoke<void>('app_server_respond', { id, result })
  },

  listWorkspaces(): Promise<Workspace[]> {
    return invoke<Workspace[]>('list_workspaces')
  },

  async chooseWorkspace(): Promise<Workspace | null> {
    const path = await open({
      directory: true,
      multiple: false,
      title: '选择 Git 主工作区',
    })
    if (!path || Array.isArray(path)) return null
    return invoke<Workspace>('register_workspace', { path })
  },

  mapThreadWorkspaces(paths: string[]): Promise<Record<string, Workspace | null>> {
    return invoke<Record<string, Workspace | null>>('map_thread_workspaces', { paths })
  },

  listThreadStates(): Promise<ThreadUiState[]> {
    return invoke<ThreadUiState[]>('list_thread_states')
  },

  setThreadState(threadId: string, lastReadAt: number | null, badge: string | null): Promise<void> {
    return invoke<void>('set_thread_state', { threadId, lastReadAt, badge })
  },

  getAppState(key: string): Promise<string | null> {
    return invoke<string | null>('get_app_state', { key })
  },

  setAppState(key: string, value: string): Promise<void> {
    return invoke<void>('set_app_state', { key, value })
  },

  async listPluginInstances(): Promise<PluginInstanceRecord[]> {
    const instances = await invoke<PluginInstanceDto[]>('list_plugin_instances')
    return instances.map(pluginInstanceFromDto)
  },

  async upsertPluginInstance(instance: PluginInstanceRecord): Promise<PluginInstanceRecord> {
    const dto = await invoke<PluginInstanceDto>('upsert_plugin_instance', {
      input: {
        instanceId: instance.instanceId,
        pluginId: instance.pluginId,
        scopeKind: instance.scope.kind,
        scopeKey: pluginScopeKey(instance.scope),
        enabled: instance.enabled,
        config: instance.config,
      },
    })
    return pluginInstanceFromDto(dto)
  },

  deletePluginInstance(instanceId: string): Promise<void> {
    return invoke<void>('delete_plugin_instance', { instanceId })
  },

  getPluginState<T>(instanceId: string, key: string): Promise<T | null> {
    return invoke<T | null>('get_plugin_state', { instanceId, key })
  },

  setPluginState<T>(instanceId: string, key: string, value: T): Promise<void> {
    return invoke<void>('set_plugin_state', { instanceId, key, value })
  },

  listenEvents(handler: (event: AppServerEvent) => void): Promise<() => void> {
    return listen<AppServerEvent>('app-server:event', (event) => handler(event.payload))
  },

  listenTransport(handler: (event: JsonObject) => void): Promise<() => void> {
    return listen<JsonObject>('app-server:transport', (event) => handler(event.payload))
  },
}

function pluginScopeKey(scope: PluginScope): string | null {
  if (scope.kind === 'workspace') return scope.workspaceRoot
  if (scope.kind === 'thread') return scope.threadId
  return null
}

function pluginInstanceFromDto(dto: PluginInstanceDto): PluginInstanceRecord {
  let scope: PluginScope
  if (dto.scopeKind === 'workspace' && dto.scopeKey) scope = { kind: 'workspace', workspaceRoot: dto.scopeKey }
  else if (dto.scopeKind === 'thread' && dto.scopeKey) scope = { kind: 'thread', threadId: dto.scopeKey }
  else scope = { kind: 'global' }
  return {
    instanceId: dto.instanceId,
    pluginId: dto.pluginId,
    scope,
    enabled: dto.enabled,
    config: dto.config,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  }
}

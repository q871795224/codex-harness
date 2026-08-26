import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import type { AppServerEvent, JsonObject, ThreadUiState, Workspace } from '../domain/codex'

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

  listenEvents(handler: (event: AppServerEvent) => void): Promise<() => void> {
    return listen<AppServerEvent>('app-server:event', (event) => handler(event.payload))
  },

  listenTransport(handler: (event: JsonObject) => void): Promise<() => void> {
    return listen<JsonObject>('app-server:transport', (event) => handler(event.payload))
  },
}

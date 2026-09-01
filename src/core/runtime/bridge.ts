import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open } from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  textInput,
  type AppServerEvent,
  type JsonObject,
  type RuntimeVersions,
  type Thread,
  type ThreadCreditUsage,
  type ThreadUiState,
  type Turn,
  type Workspace,
} from '../domain/codex'
import { parseThreadCreditUsage } from '../domain/codex'
import type { AgentRun, ThreadInspection } from '../agent-runs/types'
import type { LocalConnectorHealth, LocalConnectorMessage, LocalConnectorSendInput } from '../local-connectors/types'
import type { RadarModelTable } from '../codex-radar/types'
import type { QuickCommandId, QuickCommandResult } from '../quick-commands/types'
import type { SystemNotificationClick, SystemNotificationInput } from '../notifications/types'
import type { PluginInstanceRecord, PluginScope } from '../../extensions/types'
import type { HarnessFileTree } from '../harness-files/types'
import type { UsageSnapshot } from '../usage/types'
import type { ApiSendInput, ApiSendResponse, ApiWorkbenchState } from '../api-workbench/types'
import type { TerminalEvent, TerminalSessionInfo } from '../terminal/types'
import type { WorkspaceAppId, WorkspaceDeliveryContext } from '../app-launcher/types'
import type { CodexUpdateStage, CodexUpdateStatus } from '../codex-update/types'
import type { ClaudeAdapterEvent, ClaudeRuntimeStatus, ClaudeSessionInput, ClaudeSessionRecord, ClaudeTransportEvent, ClaudeTurnStartInput } from '../claude/types'

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

export type DiagnosticErrorCode =
  | 'no_rollout_found'
  | 'timeout'
  | 'connection_failed'
  | 'permission_denied'
  | 'request_failed'
  | 'unhandled_error'

export interface ClientDiagnostic {
  level: 'error' | 'info'
  area: string
  event: string
  context?: JsonObject
  method?: string
  threadId?: string
  errorCode?: DiagnosticErrorCode
  durationMs?: number
  attemptId?: string
  stage?: string
  generatorThreadId?: string
  trigger?: string
  model?: string
  effort?: string
  reason?: string
  sourceChars?: number
  generatedChars?: number
  accepted?: boolean
  status?: string
}

export function diagnosticErrorCode(error: unknown): DiagnosticErrorCode {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  if (normalized.includes('no rollout found')) return 'no_rollout_found'
  if (normalized.includes('timeout') || message.includes('超时')) return 'timeout'
  if (normalized.includes('connection') || message.includes('连接') || normalized.includes('socket')) return 'connection_failed'
  if (normalized.includes('permission') || message.includes('权限')) return 'permission_denied'
  return 'request_failed'
}

export const runtime = {
  async request<T>(method: string, params: JsonObject = {}): Promise<T> {
    const started = performance.now()
    try {
      return await invoke<T>('app_server_request', { method, params })
    } catch (error) {
      void invoke<void>('record_client_diagnostic', {
        diagnostic: {
          level: 'error',
          area: 'frontend',
          event: 'app-server-request.failed',
          method,
          errorCode: diagnosticErrorCode(error),
          durationMs: Math.round(performance.now() - started),
        } satisfies ClientDiagnostic,
      }).catch(() => undefined)
      throw error
    }
  },

  claudeRuntimeStatus(): Promise<ClaudeRuntimeStatus> {
    return invoke<ClaudeRuntimeStatus>('claude_runtime_status')
  },

  claudeRequest<T>(method: string, params: JsonObject = {}): Promise<T> {
    return invoke<T>('claude_runtime_request', { method, params })
  },

  listClaudeSessions(archived = false): Promise<ClaudeSessionRecord[]> {
    return invoke<ClaudeSessionRecord[]>('list_claude_sessions', { archived })
  },

  upsertClaudeSession(input: ClaudeSessionInput): Promise<ClaudeSessionRecord> {
    return invoke<ClaudeSessionRecord>('upsert_claude_session', { input })
  },

  setClaudeSessionArchived(sessionId: string, archived: boolean): Promise<void> {
    return invoke<void>('set_claude_session_archived', { sessionId, archived })
  },

  startClaudeTurn(input: ClaudeTurnStartInput): Promise<{ accepted: boolean }> {
    return this.claudeRequest('turn/start', input as unknown as JsonObject)
  },

  interruptClaudeTurn(sessionId: string): Promise<void> {
    return this.claudeRequest<void>('turn/interrupt', { sessionId })
  },

  answerClaudeApproval(requestId: string, allow: boolean, updatedInput?: Record<string, unknown>): Promise<{ resolvedSeq?: number }> {
    return this.claudeRequest<{ resolvedSeq?: number }>('approval/respond', { requestId, allow, ...(updatedInput ? { updatedInput } : {}) })
  },

  listenClaudeEvents(handler: (event: ClaudeAdapterEvent) => void): Promise<() => void> {
    return listen<ClaudeAdapterEvent>('claude:event', (event) => handler(event.payload))
  },

  listenClaudeTransport(handler: (event: ClaudeTransportEvent) => void): Promise<() => void> {
    return listen<ClaudeTransportEvent>('claude:transport', (event) => handler(event.payload))
  },

  async readThreadCreditUsage(threadId: string): Promise<ThreadCreditUsage | null> {
    const response = await this.request<unknown>('account/usage/read', { threadId })
    return parseThreadCreditUsage(response)
  },

  respond(id: string | number, result: JsonObject): Promise<void> {
    return invoke<void>('app_server_respond', { id, result })
  },

  getRuntimeVersions(): Promise<RuntimeVersions> {
    return invoke<RuntimeVersions>('runtime_versions')
  },

  codexUpdateStatus(force = false): Promise<CodexUpdateStatus> {
    return invoke<CodexUpdateStatus>('codex_update_status', { force })
  },

  installCodexUpdate(): Promise<CodexUpdateStatus> {
    return invoke<CodexUpdateStatus>('install_codex_update')
  },

  listenCodexUpdateProgress(handler: (stage: CodexUpdateStage) => void): Promise<() => void> {
    return listen<CodexUpdateStage>('codex-update:progress', (event) => handler(event.payload))
  },

  skipCodexUpdate(version: string): Promise<CodexUpdateStatus> {
    return invoke<CodexUpdateStatus>('skip_codex_update', { version })
  },

  recordClientDiagnostic(diagnostic: ClientDiagnostic): Promise<void> {
    return invoke<void>('record_client_diagnostic', { diagnostic })
  },

  openDiagnosticsDirectory(): Promise<void> {
    return invoke<void>('open_diagnostics_directory')
  },

  setWindowTheme(theme: 'light' | 'dark'): Promise<void> {
    return getCurrentWindow().setTheme(theme)
  },

  openExternalUrl(url: string): Promise<void> {
    return openUrl(url)
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

  async chooseComposerFiles(): Promise<string[]> {
    const paths = await open({
      directory: false,
      multiple: true,
      title: '添加图片或文件',
    })
    if (!paths) return []
    return Array.isArray(paths) ? paths : [paths]
  },

  async chooseApiWorkbenchImportFiles(): Promise<string[]> {
    const paths = await open({
      directory: false,
      multiple: true,
      title: '导入 Postman Collection、Environment 或 Globals',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (!paths) return []
    return Array.isArray(paths) ? paths : [paths]
  },

  apiWorkbenchLoad(): Promise<ApiWorkbenchState | null> {
    return invoke<ApiWorkbenchState | null>('api_workbench_load')
  },

  apiWorkbenchSave(value: ApiWorkbenchState): Promise<ApiWorkbenchState> {
    return invoke<ApiWorkbenchState>('api_workbench_save', { value })
  },

  apiWorkbenchSend(input: ApiSendInput): Promise<ApiSendResponse> {
    return invoke<ApiSendResponse>('api_workbench_send', { input })
  },

  apiWorkbenchReadImportFile(path: string): Promise<string> {
    return invoke<string>('api_workbench_read_import_file', { path })
  },

  terminalCreate(cwd: string, cols: number, rows: number): Promise<TerminalSessionInfo> {
    return invoke<TerminalSessionInfo>('terminal_create', { input: { cwd, cols, rows } })
  },

  terminalWrite(sessionId: string, data: string): Promise<void> {
    return invoke<void>('terminal_write', { sessionId, data })
  },

  terminalResize(sessionId: string, cols: number, rows: number): Promise<void> {
    return invoke<void>('terminal_resize', { sessionId, cols, rows })
  },

  terminalClose(sessionId: string): Promise<void> {
    return invoke<void>('terminal_close', { sessionId })
  },

  terminalOpenIterm(cwd: string): Promise<void> {
    return invoke<void>('terminal_open_iterm', { cwd })
  },

  openWorkspaceApp(appId: WorkspaceAppId, cwd: string): Promise<void> {
    return invoke<void>('open_workspace_app', { appId, cwd })
  },

  openWorkspacePath(appId: WorkspaceAppId, cwd: string, path: string, line?: number): Promise<void> {
    return invoke<void>('open_workspace_path', { appId, cwd, path, line: line ?? null })
  },

  workspaceDeliveryContext(cwd: string): Promise<WorkspaceDeliveryContext> {
    return invoke<WorkspaceDeliveryContext>('workspace_delivery_context', { cwd })
  },

  async listenTerminalEvents(handler: (event: TerminalEvent) => void): Promise<() => void> {
    return listen<TerminalEvent>('harness-terminal', (event) => handler(event.payload))
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

  listHarnessFiles(cwd: string, fallbackFilenames: string[], maxBytes: number): Promise<HarnessFileTree> {
    return invoke<HarnessFileTree>('list_harness_files', { cwd, fallbackFilenames, maxBytes })
  },

  readHarnessFile(cwd: string, path: string, fallbackFilenames: string[]): Promise<string> {
    return invoke<string>('read_harness_file', { cwd, path, fallbackFilenames })
  },

  writeHarnessFile(cwd: string, path: string, content: string, fallbackFilenames: string[]): Promise<void> {
    return invoke<void>('write_harness_file', { cwd, path, content, fallbackFilenames })
  },

  createHarnessDirectory(cwd: string, path: string, fallbackFilenames: string[]): Promise<void> {
    return invoke<void>('create_harness_directory', { cwd, path, fallbackFilenames })
  },

  renameHarnessPath(cwd: string, path: string, nextPath: string, fallbackFilenames: string[]): Promise<void> {
    return invoke<void>('rename_harness_path', { cwd, path, nextPath, fallbackFilenames })
  },

  removeHarnessPath(cwd: string, path: string, fallbackFilenames: string[]): Promise<void> {
    return invoke<void>('remove_harness_path', { cwd, path, fallbackFilenames })
  },

  listPluginRuns(): Promise<AgentRun[]> {
    return invoke<AgentRun[]>('list_plugin_runs')
  },

  createAgentWorktree(cwd: string, runId: string): Promise<string> {
    return invoke<string>('create_agent_worktree', { cwd, runId })
  },

  removeAgentWorktree(cwd: string, runId: string): Promise<void> {
    return invoke<void>('remove_agent_worktree', { cwd, runId })
  },

  upsertPluginRun(run: AgentRun): Promise<AgentRun> {
    return invoke<AgentRun>('upsert_plugin_run', {
      input: {
        runId: run.runId,
        instanceId: run.instanceId,
        mode: run.mode,
        workspaceAccess: run.workspaceAccess,
        status: run.status,
        title: run.title,
        workspaceRoot: run.workspaceRoot,
        parentThreadId: run.parentThreadId,
        childThreadId: run.childThreadId,
        turnId: run.turnId,
        errorSummary: run.errorSummary,
        completedAt: run.completedAt,
        returnedAt: run.returnedAt,
        workspaceRemovedAt: run.workspaceRemovedAt,
      },
    })
  },

  localConnectorHealth(baseUrl: string): Promise<LocalConnectorHealth> {
    return invoke<LocalConnectorHealth>('local_connector_health', { baseUrl })
  },

  localConnectorListMessages(baseUrl: string, limit = 50): Promise<LocalConnectorMessage[]> {
    return invoke<LocalConnectorMessage[]>('local_connector_list_messages', { baseUrl, limit })
  },

  localConnectorSendMessage(baseUrl: string, input: LocalConnectorSendInput): Promise<{ ok: boolean; messageId?: string }> {
    return invoke<{ ok: boolean; messageId?: string }>('local_connector_send_message', { baseUrl, input })
  },

  codexRadarModelTable(): Promise<RadarModelTable> {
    return invoke<RadarModelTable>('codex_radar_model_table')
  },

  usageCachedSnapshot(since: string, until: string): Promise<UsageSnapshot | null> {
    return invoke<UsageSnapshot | null>('usage_cached_snapshot', { since, until })
  },

  usageRefreshSnapshot(since: string, until: string): Promise<UsageSnapshot> {
    return invoke<UsageSnapshot>('usage_refresh_snapshot', { since, until })
  },

  runQuickCommand(commandId: QuickCommandId): Promise<QuickCommandResult> {
    return invoke<QuickCommandResult>('run_quick_command', { commandId })
  },

  requestSystemNotificationPermission(): Promise<boolean> {
    return invoke<boolean>('request_system_notification_permission')
  },

  sendSystemNotification(input: SystemNotificationInput): Promise<void> {
    return invoke<void>('send_system_notification', { input })
  },

  async listenSystemNotificationClicks(handler: (event: SystemNotificationClick) => void): Promise<() => void> {
    return listen<SystemNotificationClick>('system-notification:clicked', (event) => handler(event.payload))
  },

  async startCodexThread(workspaceRoot: string): Promise<string> {
    const response = await invoke<{ thread: Thread }>('app_server_request', {
      method: 'thread/start',
      params: { cwd: workspaceRoot },
    })
    return response.thread.id
  },

  async startCodexTurn(threadId: string, prompt: string): Promise<string> {
    const response = await invoke<{ turn: Turn }>('app_server_request', {
      method: 'turn/start',
      params: {
        threadId,
        clientUserMessageId: crypto.randomUUID(),
        input: [textInput(prompt)],
      },
    })
    return response.turn.id
  },

  interruptCodexTurn(threadId: string, turnId: string): Promise<void> {
    return invoke<void>('app_server_request', {
      method: 'turn/interrupt',
      params: { threadId, turnId },
    })
  },

  async inspectCodexThread(threadId: string): Promise<ThreadInspection> {
    const response = await resumeThread(threadId, 1)
    const turns = response.initialTurnsPage?.data ?? response.thread.turns ?? []
    return {
      active: response.thread.status.type === 'active',
      lastTurnStatus: turns[0]?.status ?? null,
    }
  },

  async readLastAgentMessage(threadId: string): Promise<string> {
    const response = await resumeThread(threadId, 5)
    const turns = response.initialTurnsPage?.data ?? response.thread.turns ?? []
    for (const turn of turns) {
      for (const item of [...turn.items].reverse()) {
        if (item.type === 'agentMessage' && item.text?.trim()) return item.text.trim()
      }
    }
    throw new Error('子 Agent 尚未生成可回传的结果')
  },

  listenEvents(handler: (event: AppServerEvent) => void): Promise<() => void> {
    return listen<AppServerEvent>('app-server:event', (event) => handler(event.payload))
  },

  listenTransport(handler: (event: JsonObject) => void): Promise<() => void> {
    return listen<JsonObject>('app-server:transport', (event) => handler(event.payload))
  },
}

export function recordWorkspaceContextDiagnostic(diagnostic: Omit<ClientDiagnostic, 'area'>): void {
  void runtime.recordClientDiagnostic({ area: 'workspace-context', ...diagnostic }).catch(() => undefined)
}

interface ResumeThreadResponse {
  thread: Thread
  initialTurnsPage?: { data: Turn[]; nextCursor: string | null } | null
}

function resumeThread(threadId: string, limit: number): Promise<ResumeThreadResponse> {
  return invoke<ResumeThreadResponse>('app_server_request', {
    method: 'thread/resume',
    params: { threadId, initialTurnsPage: { limit, sortDirection: 'desc', itemsView: 'full' } },
  })
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

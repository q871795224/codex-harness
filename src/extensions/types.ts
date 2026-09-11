import type { ComponentType, ReactNode } from 'react'
import type { CodexModel, Thread, ThreadCodexSettings, ThreadItemEntry, Workspace } from '../core/domain/codex'

export type PluginScopeKind = 'global' | 'workspace' | 'thread'
export type PluginProvider = 'codex' | 'claude'

export type PluginScope =
  | { kind: 'global' }
  | { kind: 'workspace'; workspaceRoot: string }
  | { kind: 'thread'; threadId: string }

export interface PluginManifest {
  schemaVersion: 1
  id: string
  name: string
  description: string
  version: string
  engine: { codexHarness: string }
  supportedScopes: PluginScopeKind[]
  requires?: string[]
  permissions?: string[]
  supportedProviders?: PluginProvider[]
}

export interface PluginInstanceRecord {
  instanceId: string
  pluginId: string
  scope: PluginScope
  enabled: boolean
  config: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export type PluginInstanceStatus =
  | { phase: 'disabled' }
  | { phase: 'pending' }
  | { phase: 'active' }
  | { phase: 'failed'; error: string }

export interface PluginViewContext {
  provider?: PluginProvider
  threadId: string | null
  threadCwd: string | null
  workspaceRoot: string | null
}

export interface ConversationTabProps extends PluginViewContext {
  items: ThreadItemEntry[]
  workspaces: Workspace[]
  threads: Thread[]
}

export interface ConversationTabContribution {
  id: string
  label: string
  order?: number
  icon?: ComponentType<{ size?: string | number }>
  focusable?: boolean
  hideComposer?: boolean
  render(props: ConversationTabProps): ReactNode
}

export interface ComposerActionProps extends PluginViewContext {
  disabled: boolean
  /** 当前会话的消息条目（供需要读取对话内容的动作，如归档）。 */
  items: ThreadItemEntry[]
  /** 当前会话的工作目录（起独立 run 时用）；无工作目录会话为 null。 */
  checkoutRoot: string | null
  insertSkillPrompt(skillName: string, prompt: string): Promise<boolean>
}

export interface ComposerActionContribution {
  id: string
  order?: number
  render(props: ComposerActionProps): ReactNode
}

export interface TurnActionProps extends PluginViewContext {
  /** 截至当前 turn（含）的会话消息条目，按时间正序。归档类动作应以此为准，不读该 turn 之后的内容。 */
  items: ThreadItemEntry[]
  /** 该操作所属 turn 的 id。 */
  turnId: string
  /** 当前会话的工作目录（起独立 run 时用）；无工作目录会话为 null。 */
  checkoutRoot: string | null
  disabled: boolean
}

export interface TurnActionContribution {
  id: string
  order?: number
  /** 渲染在某个 agent turn 最终回答操作行（copy/raw/fork）右侧；返回 null 则不渲染。 */
  render(props: TurnActionProps): ReactNode
}

export interface ComposerCompletionItem {
  id: string
  title: string
  subtitle?: string
  group?: string
  insertText: string
  collapseAsPaste?: boolean
}

export interface ComposerCompletionContribution {
  id: string
  trigger: string
  order?: number
  loadItems(query: string, ctx: PluginViewContext): ComposerCompletionItem[] | Promise<ComposerCompletionItem[]>
}

export interface ThreadHeaderActionProps extends PluginViewContext {
  disabled: boolean
}

export interface ThreadHeaderActionContribution {
  id: string
  order?: number
  render(props: ThreadHeaderActionProps): ReactNode
}

export interface QuickActionProps extends PluginViewContext {
  checkoutRoot: string | null
  disabled: boolean
}

export interface QuickActionContribution {
  id: string
  label: string
  description?: string
  meta?: string
  order?: number
  run(props: QuickActionProps): void | Promise<void>
}

export interface QuickCommandContribution {
  id: string
  label: string
  command: string
  order?: number
  run(): Promise<{ success: boolean; message: string }>
}

export interface NewThreadPanelProps extends PluginViewContext {
  isNewThread: boolean
  models: CodexModel[]
  settings: ThreadCodexSettings
  disabled: boolean
  onSettingsChange(patch: Partial<ThreadCodexSettings>): Promise<void> | void
  /** 切换当前新会话的工作区（如绑定项目后自动选择项目首个已绑定工作区）。 */
  onWorkspaceChange?(workspaceRoot: string): void
}

export interface NewThreadPanelContribution {
  /** Compact controls alongside the new-thread greeting; defaults to the panel area. */
  placement?: 'header' | 'panel'
  id: string
  order?: number
  render(props: NewThreadPanelProps): ReactNode
}

export interface PluginSettingsProps {
  instance: PluginInstanceRecord
  models: CodexModel[]
  saveConfig(config: Record<string, unknown>): Promise<void>
}

export interface PluginStorage {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T): Promise<void>
}

export interface PluginServiceAccess {
  provide<T>(id: string, service: T): void
  get<T>(id: string): T
  optional<T>(id: string): T | undefined
}

export interface PluginEventAccess {
  on<T>(event: string, handler: (payload: T) => void): void
  emit<T>(event: string, payload: T): void
}

export interface PluginSlotAccess {
  threadHeaderActions: {
    register(contribution: ThreadHeaderActionContribution): void
  }
  newThreadPanels: {
    register(contribution: NewThreadPanelContribution): void
  }
  conversationTabs: {
    register(contribution: ConversationTabContribution): void
  }
  composerActions: {
    register(contribution: ComposerActionContribution): void
  }
  turnActions: {
    register(contribution: TurnActionContribution): void
  }
  composerCompletions: {
    register(contribution: ComposerCompletionContribution): void
  }
  quickActions: {
    register(contribution: QuickActionContribution): void
  }
  quickCommands: {
    register(contribution: QuickCommandContribution): void
  }
}

export interface PluginCommand {
  id: string
  title: string
  run(signal: AbortSignal): void | Promise<void>
}

export interface PluginCommandAccess {
  register(command: PluginCommand): void
}

export interface PluginInstanceContext {
  pluginId: string
  instanceId: string
  scope: PluginScope
  config: Readonly<Record<string, unknown>>
  services: PluginServiceAccess
  events: PluginEventAccess
  slots: PluginSlotAccess
  commands: PluginCommandAccess
  storage: PluginStorage
  signal: AbortSignal
  effect(disposer: () => void | Promise<void>): void
}

export interface HarnessPlugin {
  manifest: PluginManifest
  allowMultipleInstancesPerScope?: boolean
  createInstanceConfig?(): Record<string, unknown>
  instanceLabel?(instance: PluginInstanceRecord): string | null
  migrateInstances?(instances: PluginInstanceRecord[]): PluginInstanceRecord[]
  settings?: ComponentType<PluginSettingsProps>
  activate(ctx: PluginInstanceContext): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>
}

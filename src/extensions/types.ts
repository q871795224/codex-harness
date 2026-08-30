import type { ComponentType, ReactNode } from 'react'
import type { CodexModel, Thread, ThreadCodexSettings, ThreadItemEntry, Workspace } from '../core/domain/codex'

export type PluginScopeKind = 'global' | 'workspace' | 'thread'

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
  render(props: ConversationTabProps): ReactNode
}

export interface ComposerActionProps extends PluginViewContext {
  disabled: boolean
  insertSkillPrompt(skillName: string, prompt: string): Promise<boolean>
}

export interface ComposerActionContribution {
  id: string
  order?: number
  render(props: ComposerActionProps): ReactNode
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
  models: CodexModel[]
  settings: ThreadCodexSettings
  disabled: boolean
  onSettingsChange(patch: Partial<ThreadCodexSettings>): Promise<void> | void
}

export interface NewThreadPanelContribution {
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
  newThreadPanels: {
    register(contribution: NewThreadPanelContribution): void
  }
  conversationTabs: {
    register(contribution: ConversationTabContribution): void
  }
  composerActions: {
    register(contribution: ComposerActionContribution): void
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

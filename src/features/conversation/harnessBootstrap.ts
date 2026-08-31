import type {
  AppearancePreferences,
  KeyboardPreferences,
  NavigationPreferences,
  ThreadTitleGenerationSettings,
  ThreadUiState,
  Workspace,
} from '../../core/domain/codex'
import {
  DEFAULT_SIDEBAR_WIDTH,
  DEFAULT_THREAD_TITLE_GENERATION,
  defaultFontSizePreferences,
  normalizeFontSizePreferences,
  normalizeFollowUpMode,
  normalizeSendShortcut,
  normalizeSidebarWidth,
  normalizeTheme,
} from '../../core/domain/codex'
import { defaultHarnessActionShortcuts, normalizeHarnessActionShortcuts } from '../actions/harnessActions'
import {
  defaultConversationStatsPreferences,
  normalizeConversationStatsPreferences,
  type ConversationStatsPreferences,
} from './conversationStatsConfig'

export const NAVIGATION_PREFERENCES_KEY = 'navigationPreferences'
export const APPEARANCE_PREFERENCES_KEY = 'appearancePreferences'
export const KEYBOARD_PREFERENCES_KEY = 'keyboardPreferences'
export const THREAD_TITLE_GENERATION_KEY = 'threadTitleGeneration'
export const CONVERSATION_STATS_PREFERENCES_KEY = 'conversationStatsPreferences'

export const defaultNavigationPreferences: NavigationPreferences = {
  layout: 'workspace',
  sort: 'recent',
  manualThreadOrder: [],
  workspaceSort: 'stable',
  pinnedThreadIds: [],
  pinnedWorkspaceRoots: [],
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  sidebarCollapsed: false,
}

export const defaultAppearancePreferences: AppearancePreferences = {
  theme: 'light',
  fontSizes: defaultFontSizePreferences(),
}

export const defaultKeyboardPreferences: KeyboardPreferences = {
  sendShortcut: 'mod-enter',
  followUpMode: 'queue',
  actionShortcuts: defaultHarnessActionShortcuts,
}

export interface HarnessBootstrapStorage {
  listWorkspaces(): Promise<Workspace[]>
  listThreadStates(): Promise<ThreadUiState[]>
  getAppState(key: string): Promise<string | null>
}

export interface HarnessBootstrapState {
  workspaces: Workspace[]
  threadStates: Record<string, ThreadUiState>
  rememberedThreadId: string | null
  navigation: NavigationPreferences
  appearance: AppearancePreferences
  keyboard: KeyboardPreferences
  threadTitleGeneration: ThreadTitleGenerationSettings
  conversationStats: ConversationStatsPreferences
}

export async function loadHarnessBootstrap(storage: HarnessBootstrapStorage): Promise<HarnessBootstrapState> {
  const [workspaces, storedStates, rememberedThreadId, storedNavigation, storedAppearance, storedKeyboard, storedThreadTitleGeneration, storedConversationStats] = await Promise.all([
    storage.listWorkspaces(),
    storage.listThreadStates(),
    storage.getAppState('selectedThreadId'),
    storage.getAppState(NAVIGATION_PREFERENCES_KEY),
    storage.getAppState(APPEARANCE_PREFERENCES_KEY),
    storage.getAppState(KEYBOARD_PREFERENCES_KEY),
    storage.getAppState(THREAD_TITLE_GENERATION_KEY),
    storage.getAppState(CONVERSATION_STATS_PREFERENCES_KEY),
  ])

  return {
    workspaces,
    threadStates: Object.fromEntries(storedStates.map((state) => [state.threadId, state])),
    rememberedThreadId,
    navigation: parseNavigationPreferences(storedNavigation),
    appearance: parseAppearancePreferences(storedAppearance),
    keyboard: parseKeyboardPreferences(storedKeyboard),
    threadTitleGeneration: parseThreadTitleGenerationSettings(storedThreadTitleGeneration),
    conversationStats: parseConversationStatsPreferences(storedConversationStats),
  }
}

export function parseNavigationPreferences(raw: string | null): NavigationPreferences {
  if (!raw) return defaultNavigationPreferences
  try {
    const value = JSON.parse(raw) as Partial<NavigationPreferences>
    return {
      layout: value.layout === 'list' ? 'list' : 'workspace',
      sort: value.sort === 'manual' ? 'manual' : 'recent',
      manualThreadOrder: Array.isArray(value.manualThreadOrder)
        ? [...new Set(value.manualThreadOrder.filter((id): id is string => typeof id === 'string'))].slice(0, 500)
        : [],
      workspaceSort: value.workspaceSort === 'recent' ? 'recent' : 'stable',
      pinnedThreadIds: parsePinnedIdentifiers(value.pinnedThreadIds),
      pinnedWorkspaceRoots: parsePinnedIdentifiers(value.pinnedWorkspaceRoots),
      sidebarWidth: normalizeSidebarWidth(value.sidebarWidth),
      sidebarCollapsed: value.sidebarCollapsed === true,
    }
  } catch {
    return defaultNavigationPreferences
  }
}

export function togglePinnedIdentifier(identifiers: string[], identifier: string): string[] {
  return identifiers.includes(identifier)
    ? identifiers.filter((item) => item !== identifier)
    : [identifier, ...identifiers].slice(0, 500)
}

export function parseThreadTitleGenerationSettings(raw: string | null): ThreadTitleGenerationSettings {
  if (!raw) return DEFAULT_THREAD_TITLE_GENERATION
  try {
    const value = JSON.parse(raw) as Partial<ThreadTitleGenerationSettings>
    return {
      model: typeof value.model === 'string' && value.model.trim() ? value.model : DEFAULT_THREAD_TITLE_GENERATION.model,
      effort: typeof value.effort === 'string' && value.effort.trim() ? value.effort : DEFAULT_THREAD_TITLE_GENERATION.effort,
      prompt: typeof value.prompt === 'string' && value.prompt.trim() ? value.prompt : DEFAULT_THREAD_TITLE_GENERATION.prompt,
    }
  } catch {
    return DEFAULT_THREAD_TITLE_GENERATION
  }
}

function parsePinnedIdentifiers(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0))].slice(0, 500)
}

function parseAppearancePreferences(raw: string | null): AppearancePreferences {
  if (!raw) return defaultAppearancePreferences
  try {
    const value = JSON.parse(raw)
    return { theme: normalizeTheme(value?.theme), fontSizes: normalizeFontSizePreferences(value) }
  } catch {
    return defaultAppearancePreferences
  }
}

function parseKeyboardPreferences(raw: string | null): KeyboardPreferences {
  if (!raw) return defaultKeyboardPreferences
  try {
    const value = JSON.parse(raw) as Partial<KeyboardPreferences>
    return {
      sendShortcut: normalizeSendShortcut(value.sendShortcut),
      followUpMode: normalizeFollowUpMode(value.followUpMode),
      actionShortcuts: normalizeHarnessActionShortcuts(value.actionShortcuts),
    }
  } catch {
    return defaultKeyboardPreferences
  }
}

function parseConversationStatsPreferences(raw: string | null): ConversationStatsPreferences {
  if (!raw) return defaultConversationStatsPreferences()
  try {
    return normalizeConversationStatsPreferences(JSON.parse(raw))
  } catch {
    return defaultConversationStatsPreferences()
  }
}

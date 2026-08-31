import type { HarnessActionId, HarnessActionShortcuts } from '../../core/domain/codex'

export const harnessActionDefinitions: Array<{ id: HarnessActionId; label: string }> = [
  { id: 'thread.new', label: '新建会话' },
  ...Array.from({ length: 9 }, (_, index) => ({
    id: `thread.select.${index + 1}` as HarnessActionId,
    label: `切换到第 ${index + 1} 个会话`,
  })),
  { id: 'sidebar.toggle', label: '收起或展开侧边栏' },
  { id: 'composer.focus', label: '回到输入框' },
  { id: 'tab.focus.toggle', label: '切换当前 Tab 全屏' },
]

export const defaultHarnessActionShortcuts: HarnessActionShortcuts = Object.fromEntries([
  ['thread.new', 'Mod+T'],
  ...Array.from({ length: 9 }, (_, index) => [`thread.select.${index + 1}`, `Mod+${index + 1}`]),
  ['sidebar.toggle', 'Mod+B'],
  ['composer.focus', 'Escape'],
  ['tab.focus.toggle', 'F11'],
]) as HarnessActionShortcuts

export interface ShortcutKeyEvent {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  isComposing?: boolean
  keyCode?: number
}

export function normalizeHarnessActionShortcuts(value: unknown): HarnessActionShortcuts {
  const saved = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return Object.fromEntries(harnessActionDefinitions.map(({ id }) => [
    id,
    typeof saved[id] === 'string' && saved[id] ? saved[id] : defaultHarnessActionShortcuts[id],
  ])) as HarnessActionShortcuts
}

export function shortcutFromEvent(event: ShortcutKeyEvent): string | null {
  if (event.isComposing || event.keyCode === 229 || ['Meta', 'Control', 'Shift', 'Alt'].includes(event.key)) return null
  const key = normalizeKey(event.key)
  if (!key) return null
  if (key === 'Escape') return 'Escape'
  if (/^F(?:[1-9]|1[0-2])$/.test(key) && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) return key
  if (!event.metaKey && !event.ctrlKey && !event.altKey) return null
  return [
    event.metaKey ? 'Mod' : null,
    event.ctrlKey ? 'Ctrl' : null,
    event.altKey ? 'Alt' : null,
    event.shiftKey ? 'Shift' : null,
    key,
  ].filter(Boolean).join('+')
}

export function actionForShortcut(event: ShortcutKeyEvent, shortcuts: HarnessActionShortcuts): HarnessActionId | null {
  const shortcut = shortcutFromEvent(event)
  if (!shortcut) return null
  return harnessActionDefinitions.find(({ id }) => shortcuts[id] === shortcut)?.id ?? null
}

export function conflictingAction(shortcuts: HarnessActionShortcuts, actionId: HarnessActionId, shortcut: string): HarnessActionId | null {
  return harnessActionDefinitions.find(({ id }) => id !== actionId && shortcuts[id] === shortcut)?.id ?? null
}

export function formatShortcut(shortcut: string): string {
  return shortcut.split('+').map((part) => ({ Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' })[part] ?? part).join('')
}

export function threadIndexForAction(actionId: HarnessActionId): number | null {
  const match = actionId.match(/^thread\.select\.([1-9])$/)
  return match ? Number(match[1]) - 1 : null
}

function normalizeKey(key: string): string | null {
  if (key === 'Esc') return 'Escape'
  if (key === 'Escape') return key
  if (key === ' ') return 'Space'
  if (key.length === 1) return key.toUpperCase()
  return /^[A-Za-z][A-Za-z0-9]*$/.test(key) ? key : null
}

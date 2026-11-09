import { DEFAULT_HANDOVER_PROMPT, DEFAULT_HANDOVER_TEMPLATE, HANDOVER_PROMPT_FILE_NAME, HANDOVER_TEMPLATE_FILE_NAME } from '../../features/handover/templates'
import type { ManagementContext } from './service'
import { settingsSaved } from '../runtime/settingsEvents'
import { runtime } from '../runtime/bridge'
import { loadRouterSettings, saveRouterSettings, ROUTER_SETTINGS_KEY } from '../workspace-router/settings'
import { loadMemorySettings, saveMemorySettings, MEMORY_SETTINGS_KEY } from '../memory/settings'
import { loadHistorySettings, saveHistorySettings, HISTORY_SETTINGS_KEY } from '../runtime/historySettings'
import { loadCorrectionSettings, readCorrectionSettings, saveCorrectionSettings, CORRECTION_KEY } from '../input-correction/settings'
import { CONVERSATION_STAT_DEFINITIONS, normalizeConversationStatsPreferences } from '../../features/conversation/conversationStatsConfig'
import { harnessActionDefinitions, conflictingAction, shortcutFromEvent } from '../../features/actions/harnessActions'
import { APPEARANCE_PREFERENCES_KEY, KEYBOARD_PREFERENCES_KEY, NAVIGATION_PREFERENCES_KEY, THREAD_TITLE_GENERATION_KEY, RECAP_GENERATION_KEY, CONVERSATION_STATS_PREFERENCES_KEY } from '../../features/conversation/harnessBootstrap'
import type { FontSizeArea, HarnessActionId } from '../domain/codex'
import { object, keys, string, choice, number, boolean, sameJson } from './validation'

export const settingsCatalog = {
  handover: { fields: { prompt: '交接总结指令', template: '交接文档模板' }, effect: '下次交接生效' },
  appearance: { fields: { theme: 'light | dark', fontSizes: '对象，navigation/conversation/settings/plugins各13–19' }, effect: '立即应用' },
  navigation: { fields: { layout: 'workspace | list', sort: 'recent | manual', workspaceSort: 'stable | recent', sidebarUnpinnedCount: '非负整数', sidebarWidth: '214–480', sidebarCollapsed: 'boolean', sidebarListSplitRatio: '0.2–0.8' }, effect: '立即应用' },
  keyboard: { fields: { sendShortcut: 'enter | mod-enter', followUpMode: 'queue | interject', actionShortcuts: '应用动作ID到快捷键字符串的对象' }, effect: '立即应用' },
  threadTitle: { fields: { model: '模型名', effort: '推理强度', prompt: '非空提示词' }, effect: '下次生成标题生效' },
  recap: { fields: { model: '模型名', effort: '推理强度', prompt: '非空提示词' }, effect: '下次生成回顾生效' },
  conversationStats: { fields: { items: '按顺序排列的{id,visible}数组' }, effect: '立即应用' },
  router: { fields: { backend: 'codex | decision2', model: 'Codex模型名', effort: 'Codex推理强度', tokenBudget: '2048–32768', feedbackCount: '0–10', feedbackRule: 'relevant | recent', descriptions: '工作区root到手填用途的对象，按键合并；null删除该项' }, effect: '下次路由/简介生成生效；不会自动重新生成缓存' },
  memory: { fields: { model: '模型名，空字符串跟随默认', effort: '推理强度', prompt: '非空提示词', maxTurns: '0–10000，0全部', budgetPercent: '1–100', contextWindowTokens: '0跟随配置或1024–10000000' }, effect: '下次记忆提炼生效' },
  history: { fields: { loading: 'on-demand | eager', maxResponseMiB: '16–1024' }, effect: '加载方式下次打开会话生效；响应上限重启Harness生效' },
  inputCorrection: { fields: { enabled: 'boolean', quotes: 'boolean', rules: '{from,to}数组，整体替换词库' }, effect: '立即应用' },
} as const
export type SettingsGroup = keyof typeof settingsCatalog
export function settingsGroup(value: unknown): SettingsGroup {
  if (typeof value !== 'string' || !Object.hasOwn(settingsCatalog, value)) throw new Error('未知设置组，请先 settings list')
  return value as SettingsGroup
}

export async function readSettings(group: SettingsGroup, context: ManagementContext) {
  const h = context.harness
  switch (group) {
    case 'handover': return { prompt: await runtime.readHandoverTemplate(HANDOVER_PROMPT_FILE_NAME, DEFAULT_HANDOVER_PROMPT), template: await runtime.readHandoverTemplate(HANDOVER_TEMPLATE_FILE_NAME, DEFAULT_HANDOVER_TEMPLATE) }
    case 'appearance': return h.appearance
    case 'navigation': return Object.fromEntries(Object.keys(settingsCatalog.navigation.fields).map(k => [k, h.navigation[k as keyof typeof h.navigation]]))
    case 'keyboard': return h.keyboard
    case 'threadTitle': return h.threadTitleGeneration
    case 'recap': return h.recapGeneration
    case 'conversationStats': return h.conversationStats
    case 'router': return loadRouterSettings()
    case 'memory': return loadMemorySettings()
    case 'history': return loadHistorySettings()
    case 'inputCorrection': await loadCorrectionSettings(); return readCorrectionSettings()
  }
}

/** Validate the whole patch before calling any UI setter; never expose arbitrary appState keys. */
export async function updateSettings(group: SettingsGroup, patch: Record<string, unknown>, get: () => ManagementContext,
  waitFor: <T>(read: () => T | undefined) => Promise<T>) {
  keys(patch, Object.keys(settingsCatalog[group].fields), true)
  const current = await readSettings(group, get())
  const h = get().harness
  let expected: unknown
  let stateKey: string
  let persisted: unknown
  switch (group) {
    case 'handover': {
      for (const [key, value] of Object.entries(patch)) string(value, key)
      if (patch.prompt !== undefined) await runtime.writeHandoverTemplate(HANDOVER_PROMPT_FILE_NAME, patch.prompt as string)
      if (patch.template !== undefined) await runtime.writeHandoverTemplate(HANDOVER_TEMPLATE_FILE_NAME, patch.template as string)
      const saved = await readSettings(group, get())
      if (!sameJson(saved, { ...object(current), ...patch })) throw new Error('交接模板已提交，但回读未确认')
      settingsSaved('handover')
      return { group, settings: saved, effect: settingsCatalog.handover.effect, changed: !sameJson(current, saved) }
    }
    case 'appearance': {
      const next = { ...h.appearance, ...patch, fontSizes: { ...h.appearance.fontSizes, ...(patch.fontSizes === undefined ? {} : object(patch.fontSizes)) } }
      choice(next.theme, ['light', 'dark'], 'theme')
      keys(next.fontSizes, Object.keys(h.appearance.fontSizes))
      for (const value of Object.values(next.fontSizes)) number(value, 13, 19, 'fontSize')
      if (patch.theme !== undefined) h.setTheme(next.theme)
      if (patch.fontSizes !== undefined) for (const [area, value] of Object.entries(object(patch.fontSizes))) h.setFontSize(area as FontSizeArea, value as number)
      expected = next; stateKey = APPEARANCE_PREFERENCES_KEY; break
    }
    case 'navigation': {
      const next = { ...h.navigation, ...patch }
      choice(next.layout, ['workspace', 'list'], 'layout'); choice(next.sort, ['recent', 'manual'], 'sort'); choice(next.workspaceSort, ['stable', 'recent'], 'workspaceSort')
      number(next.sidebarUnpinnedCount, 0, Number.MAX_SAFE_INTEGER, 'sidebarUnpinnedCount'); number(next.sidebarWidth, 214, 480, 'sidebarWidth')
      number(next.sidebarListSplitRatio, .2, .8, 'sidebarListSplitRatio', false); boolean(next.sidebarCollapsed, 'sidebarCollapsed')
      if (patch.layout !== undefined) h.setNavigationLayout(next.layout)
      if (patch.sort !== undefined) h.setThreadSort(next.sort)
      if (patch.workspaceSort !== undefined) h.setWorkspaceSort(next.workspaceSort)
      if (patch.sidebarUnpinnedCount !== undefined) h.setSidebarUnpinnedCount(next.sidebarUnpinnedCount)
      if (patch.sidebarWidth !== undefined) h.setSidebarWidth(next.sidebarWidth)
      if (patch.sidebarCollapsed !== undefined) h.setSidebarCollapsed(next.sidebarCollapsed)
      if (patch.sidebarListSplitRatio !== undefined) h.setSidebarListSplitRatio(next.sidebarListSplitRatio)
      expected = Object.fromEntries(Object.keys(settingsCatalog.navigation.fields).map(k => [k, next[k as keyof typeof next]]))
      persisted = next; stateKey = NAVIGATION_PREFERENCES_KEY; break
    }
    case 'keyboard': {
      const next = { ...h.keyboard, ...patch, actionShortcuts: { ...h.keyboard.actionShortcuts, ...(patch.actionShortcuts === undefined ? {} : object(patch.actionShortcuts)) } }
      choice(next.sendShortcut, ['enter', 'mod-enter'], 'sendShortcut'); choice(next.followUpMode, ['queue', 'interject'], 'followUpMode')
      keys(next.actionShortcuts, harnessActionDefinitions.map(a => a.id))
      for (const [id, value] of Object.entries(next.actionShortcuts)) {
        string(value, 'shortcut', 100)
        const parts = value.split('+'); let key = parts.pop()!
        if (!key && parts.at(-1) === '') { parts.pop(); key = '+' }
        const modifiers = parts.map(part => part.toLowerCase())
        if (modifiers.some(part => !['mod', 'ctrl', 'alt', 'shift'].includes(part)) || new Set(modifiers).size !== modifiers.length) throw new Error(`快捷键格式无效: ${id}`)
        const named: Record<string, string> = { escape: 'Escape', esc: 'Escape', space: ' ', enter: 'Enter', tab: 'Tab', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', backspace: 'Backspace', delete: 'Delete', insert: 'Insert' }
        key = named[key.toLowerCase()] ?? (/^f\d{1,2}$/i.test(key) ? key.toUpperCase() : key)
        const normalized = shortcutFromEvent({ key, metaKey: modifiers.includes('mod'), ctrlKey: modifiers.includes('ctrl'), altKey: modifiers.includes('alt'), shiftKey: modifiers.includes('shift') })
        if (!normalized) throw new Error(`快捷键格式无效: ${id}`)
        next.actionShortcuts[id as HarnessActionId] = normalized
      }
      for (const [id, value] of Object.entries(next.actionShortcuts)) if (conflictingAction(next.actionShortcuts, id as HarnessActionId, value)) throw new Error(`快捷键冲突: ${id}`)
      if (patch.sendShortcut !== undefined) h.setSendShortcut(next.sendShortcut)
      if (patch.followUpMode !== undefined) h.setFollowUpMode(next.followUpMode)
      if (patch.actionShortcuts !== undefined) for (const id of Object.keys(object(patch.actionShortcuts))) h.setActionShortcut(id as HarnessActionId, next.actionShortcuts[id as HarnessActionId])
      expected = next; stateKey = KEYBOARD_PREFERENCES_KEY; break
    }
    case 'threadTitle': case 'recap': {
      const next = { ...(group === 'threadTitle' ? h.threadTitleGeneration : h.recapGeneration), ...patch }
      next.model = string(next.model, 'model', 200); next.effort = string(next.effort, 'effort', 32, true); next.prompt = string(next.prompt, 'prompt')
      if (group === 'threadTitle') h.setThreadTitleGeneration(next); else h.setRecapGeneration(next)
      expected = next; stateKey = group === 'threadTitle' ? THREAD_TITLE_GENERATION_KEY : RECAP_GENERATION_KEY; break
    }
    case 'conversationStats': {
      if (!Array.isArray(patch.items)) throw new Error('items 必须是数组')
      const seen = new Set()
      for (const value of patch.items) {
        const item = object(value); keys(item, ['id', 'visible'])
        if (!CONVERSATION_STAT_DEFINITIONS.some(d => d.id === item.id) || seen.has(item.id)) throw new Error('未知或重复的底部信息项')
        seen.add(item.id); boolean(item.visible, 'visible')
      }
      const next = normalizeConversationStatsPreferences(patch); h.setConversationStats(next)
      expected = next; stateKey = CONVERSATION_STATS_PREFERENCES_KEY; break
    }
    case 'router': {
      const saved = await loadRouterSettings(); const descriptions = { ...saved.descriptions }
      if (patch.descriptions !== undefined) for (const [root, value] of Object.entries(object(patch.descriptions))) {
        if (!get().harness.allWorkspaces.some(w => w.root === root)) throw new Error('用途说明必须使用已知工作区root')
        if (value === null) delete descriptions[root]
        else { if (typeof value !== 'string') throw new Error('用途说明必须是文本或null'); descriptions[root] = value }
      }
      expected = await saveRouterSettings({ ...saved, ...patch, descriptions }); stateKey = ROUTER_SETTINGS_KEY; break
    }
    case 'memory': expected = await saveMemorySettings({ ...await loadMemorySettings(), ...patch }); stateKey = MEMORY_SETTINGS_KEY; break
    case 'history': expected = await saveHistorySettings({ ...await loadHistorySettings(), ...patch }); stateKey = HISTORY_SETTINGS_KEY; break
    case 'inputCorrection': {
      await loadCorrectionSettings(); const next = { ...readCorrectionSettings(), ...patch }
      boolean(next.enabled, 'enabled'); boolean(next.quotes, 'quotes')
      if (!Array.isArray(next.rules)) throw new Error('rules 必须是数组')
      for (const rule of next.rules) { keys(object(rule), ['from', 'to']); string(rule.from, 'from', 4000); string(rule.to, 'to', 4000) }
      await saveCorrectionSettings(next); expected = readCorrectionSettings(); stateKey = CORRECTION_KEY; break
    }
  }
  // Stored module settings are committed before their save returns. Core UI
  // setters also need their live React state and asynchronous persistence checked.
  if (['appearance', 'navigation', 'keyboard', 'threadTitle', 'recap', 'conversationStats'].includes(group)) {
    await waitFor(() => {
      const state = get().harness
      const actual = group === 'navigation' ? Object.fromEntries(Object.keys(settingsCatalog.navigation.fields).map(k => [k, state.navigation[k as keyof typeof state.navigation]]))
        : group === 'threadTitle' ? state.threadTitleGeneration : group === 'recap' ? state.recapGeneration : state[group as 'appearance' | 'keyboard' | 'conversationStats']
      return sameJson(actual, expected) ? true : undefined
    })
  }
  const until = Date.now() + 5_000
  let confirmed = false
  do {
    const raw = await runtime.getAppState(stateKey)
    if (raw && sameJson(JSON.parse(raw), persisted ?? expected)) { confirmed = true; break }
    await new Promise(resolve => setTimeout(resolve, 20))
  } while (Date.now() < until)
  if (!confirmed) throw new Error('设置已提交，但持久化回读未确认；请先查询实际状态')
  return { group, settings: await readSettings(group, get()), effect: settingsCatalog[group].effect, changed: !sameJson(current, expected) }
}

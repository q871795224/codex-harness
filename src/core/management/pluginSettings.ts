import type { PluginInstanceRecord } from '../../extensions/types'
import { keys, string, number, choice } from './validation'
import { readProjectDocConfig } from '../../plugins/project-doc/config'

/** Only documented non-secret settings are readable. Unknown plugin keys stay private. */
export function pluginSettings(instance: PluginInstanceRecord) {
  const input = instance.config
  const text = (key: string, fallback: string) => typeof input[key] === 'string' ? input[key] as string : fallback
  const trimmedText = (key: string, fallback: string) => text(key, fallback).trim() || fallback
  const baseUrl = () => {
    try { const value = new URL(text('baseUrl', 'http://127.0.0.1:8787')); value.username = ''; value.password = ''; value.search = ''; value.hash = ''; return value.toString().replace(/\/$/, '') }
    catch { return '无效Bridge地址' }
  }
  switch (instance.pluginId) {
    case 'builtin.project-doc': {
      const value = readProjectDocConfig(input)
      return { compactionThreshold: value.compactionThreshold, archiveModel: value.archiveModel, archiveEffort: value.archiveEffort }
    }
    case 'builtin.question-notifications':
      return { baseUrl: baseUrl(), account: trimmedText('account', 'harness-notify'), targetId: trimmedText('targetId', 'self') }
    case 'builtin.seatalk':
      return { baseUrl: baseUrl(), account: text('account', 'seatalk-local'), defaultTargetType: input.defaultTargetType === 'user' ? 'user' : 'group', defaultTargetId: text('defaultTargetId', ''), defaultThreadId: text('defaultThreadId', '') }
    default: return {}
  }
}
export function validatePluginPatch(instance: PluginInstanceRecord, patch: Record<string, unknown>) {
  const fields = Object.keys(pluginSettings(instance))
  if (!fields.length) return // Existing third-party configuration contract stays unchanged.
  keys(patch, fields, true)
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'compactionThreshold') number(value, 1, Number.MAX_SAFE_INTEGER, key)
    else if (key === 'defaultTargetType') choice(value, ['user', 'group'], key)
    else if (key === 'baseUrl') {
      const url = new URL(string(value, key, 2000))
      if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('Bridge地址必须是无凭据的本机HTTP(S)地址')
    } else string(value, key, 4000, ['defaultTargetId', 'defaultThreadId'].includes(key))
  }
}

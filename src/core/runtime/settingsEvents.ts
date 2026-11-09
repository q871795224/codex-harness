import { useEffect, useRef } from 'react'

const listeners = new Map<string, Set<() => void>>()
export function settingsSaved(group: string) { listeners.get(group)?.forEach(listener => listener()) }
export function onSettingsSaved(group: string, listener: () => void) {
  const groupListeners = listeners.get(group) ?? new Set()
  listeners.set(group, groupListeners); groupListeners.add(listener)
  return () => { groupListeners.delete(listener); if (!groupListeners.size) listeners.delete(group) }
}
/** Keep already open settings panels in sync with writes through the management API. */
export function useSettingsReload<T>(group: string, load: () => Promise<T>, apply: (value: T) => void, fail: (error: unknown) => void) {
  const current = useRef({ load, apply, fail }); current.current = { load, apply, fail }
  useEffect(() => {
    let active = true, sequence = 0
    const stop = onSettingsSaved(group, () => {
      const request = ++sequence
      void current.current.load().then(value => { if (active && request === sequence) current.current.apply(value) })
        .catch(error => { if (active && request === sequence) current.current.fail(error) })
    })
    return () => { active = false; stop() }
  }, [group])
}

import { useCallback, useEffect, useState } from 'react'
import { runtime } from '../../core/runtime/bridge'

/** 新建 Claude 会话的默认推理强度（appState 键）。空字符串 / null 都表示「不指定，按模型首个支持档位」。 */
export const CLAUDE_DEFAULT_EFFORT_KEY = 'claude.defaultEffort'

/**
 * 新建 Claude 会话的默认推理强度（全局，跨会话共享）。
 * 已存在的会话不动；`useClaudeHarness.createSession` 在新会话 settings 里采用此值。
 * 强度是否生效以模型 `supportedEffortLevels` 为准，发送 turn 时会按会话模型校验回退。
 */
export function useClaudeDefaultEffort() {
  const [defaultEffort, setDefaultEffortState] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let disposed = false
    void runtime.getAppState(CLAUDE_DEFAULT_EFFORT_KEY)
      .then((value) => {
        if (disposed) return
        setDefaultEffortState(value || null)
        setLoaded(true)
      })
      .catch(() => {
        if (disposed) return
        setLoaded(true)
      })
    return () => { disposed = true }
  }, [])

  const setDefaultEffort = useCallback(async (effort: string | null) => {
    setDefaultEffortState(effort)
    await runtime.setAppState(CLAUDE_DEFAULT_EFFORT_KEY, effort ?? '').catch(() => undefined)
  }, [])

  return { defaultEffort, loaded, setDefaultEffort }
}

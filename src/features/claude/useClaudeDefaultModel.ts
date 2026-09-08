import { useCallback, useEffect, useState } from 'react'
import { runtime } from '../../core/runtime/bridge'

/** 新建 Claude 会话的默认模型（appState 键）。空字符串 / null 都表示「用 Claude CLI 自己的默认」。 */
export const CLAUDE_DEFAULT_MODEL_KEY = 'claude.defaultModel'

/**
 * 新建 Claude 会话的默认模型（全局，跨会话共享）。
 * 已存在的会话不动；`useClaudeHarness.createSession` 在新会话 settings 里采用此值。
 */
export function useClaudeDefaultModel() {
  const [defaultModel, setDefaultModelState] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let disposed = false
    void runtime.getAppState(CLAUDE_DEFAULT_MODEL_KEY)
      .then((value) => {
        if (disposed) return
        setDefaultModelState(value || null)
        setLoaded(true)
      })
      .catch(() => {
        if (disposed) return
        setLoaded(true)
      })
    return () => { disposed = true }
  }, [])

  const setDefaultModel = useCallback(async (model: string | null) => {
    setDefaultModelState(model)
    await runtime.setAppState(CLAUDE_DEFAULT_MODEL_KEY, model ?? '').catch(() => undefined)
  }, [])

  return { defaultModel, loaded, setDefaultModel }
}

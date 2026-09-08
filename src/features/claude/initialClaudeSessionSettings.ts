import { DEFAULT_CLAUDE_SESSION_SETTINGS, type ClaudeSessionSettings } from '../../core/claude/types'
import { runtime } from '../../core/runtime/bridge'
import { CLAUDE_DEFAULT_MODEL_KEY } from './useClaudeDefaultModel'

/**
 * 新建 Claude 会话的初始 settings：以 DEFAULT_CLAUDE_SESSION_SETTINGS 为基线，
 * 若设置了全局默认模型则覆盖 model。读失败回退到 DEFAULT。
 */
export async function initialClaudeSessionSettings(): Promise<ClaudeSessionSettings> {
  try {
    const stored = await runtime.getAppState(CLAUDE_DEFAULT_MODEL_KEY)
    if (!stored) return DEFAULT_CLAUDE_SESSION_SETTINGS
    return { ...DEFAULT_CLAUDE_SESSION_SETTINGS, model: stored }
  } catch {
    return DEFAULT_CLAUDE_SESSION_SETTINGS
  }
}

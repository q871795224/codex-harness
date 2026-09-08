import { DEFAULT_CLAUDE_SESSION_SETTINGS, type ClaudeSessionSettings } from '../../core/claude/types'
import { runtime } from '../../core/runtime/bridge'
import { CLAUDE_DEFAULT_MODEL_KEY } from './useClaudeDefaultModel'
import { CLAUDE_DEFAULT_EFFORT_KEY } from './useClaudeDefaultEffort'

/**
 * 新建 Claude 会话的初始 settings：以 DEFAULT_CLAUDE_SESSION_SETTINGS 为基线，
 * 若设置了全局默认模型 / 推理强度则覆盖对应字段。读失败回退到 DEFAULT。
 */
export async function initialClaudeSessionSettings(): Promise<ClaudeSessionSettings> {
  try {
    const [model, effort] = await Promise.all([
      runtime.getAppState(CLAUDE_DEFAULT_MODEL_KEY),
      runtime.getAppState(CLAUDE_DEFAULT_EFFORT_KEY),
    ])
    return {
      ...DEFAULT_CLAUDE_SESSION_SETTINGS,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    }
  } catch {
    return DEFAULT_CLAUDE_SESSION_SETTINGS
  }
}

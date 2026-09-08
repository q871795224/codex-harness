import { BrainCircuit } from 'lucide-react'
import type { ClaudeModel } from '../../core/claude/types'
import { useClaudeDefaultModel } from '../claude/useClaudeDefaultModel'
import { useClaudeDefaultEffort } from '../claude/useClaudeDefaultEffort'

/**
 * 「模型」设置页的 Claude 默认模型卡片。
 * 选项来自 harness.claudeModels；值写入 appState `claude.defaultModel` / `claude.defaultEffort`，
 * 新建 Claude 会话时由 `initialClaudeSessionSettings` 采用；已有会话不受影响。
 */
export function ClaudeDefaultModelSettings({ models }: { models: ClaudeModel[] }) {
  const { defaultModel, loaded, setDefaultModel } = useClaudeDefaultModel()
  const { defaultEffort, loaded: effortLoaded, setDefaultEffort } = useClaudeDefaultEffort()

  // 与会话发送时一致：未选默认模型（CLI 默认）时按模型列表第一项展示可选强度。
  const selectedModel = models.find((model) => model.value === defaultModel) ?? models[0] ?? null
  const effortLevels = selectedModel?.supportedEffortLevels ?? []
  const effort = defaultEffort && effortLevels.includes(defaultEffort) ? defaultEffort : effortLevels[0] ?? ''

  const selectModel = (value: string | null) => {
    void setDefaultModel(value)
    // 切换默认模型后，若已存强度不在新模型支持列表内则清除，避免残留无效值。
    const next = models.find((model) => model.value === value) ?? models[0] ?? null
    if (defaultEffort && !next?.supportedEffortLevels.includes(defaultEffort)) void setDefaultEffort(null)
  }

  return (
    <section className="codex-setting-card">
      <div className="settings-section-title">
        <BrainCircuit size={17} />
        <div>
          <h3>Claude 默认模型</h3>
          <p>用于新建 Claude 会话；已有会话保持各自设置。</p>
        </div>
      </div>
      <div className="settings-row-list">
        <label className="settings-row">
          <span>模型</span>
          <select
            aria-label="模型"
            value={defaultModel ?? ''}
            disabled={!loaded}
            onChange={(event) => selectModel(event.target.value || null)}
          >
            <option value="">CLI 默认</option>
            {models.map((model) => (
              <option key={model.value} value={model.value}>{model.displayName}</option>
            ))}
          </select>
        </label>
        {effortLevels.length > 0 && (
          <label className="settings-row">
            <span>推理强度</span>
            <select
              aria-label="推理强度"
              value={effort}
              disabled={!effortLoaded}
              onChange={(event) => void setDefaultEffort(event.target.value)}
            >
              {effortLevels.map((level) => (
                <option key={level} value={level}>{level}</option>
              ))}
            </select>
          </label>
        )}
      </div>
    </section>
  )
}

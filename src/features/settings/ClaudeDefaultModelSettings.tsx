import { BrainCircuit } from 'lucide-react'
import type { ClaudeModel } from '../../core/claude/types'
import { useClaudeDefaultModel } from '../claude/useClaudeDefaultModel'

/**
 * 「模型」设置页的 Claude 默认模型卡片。
 * 选项来自 harness.claudeModels；值写入 appState `claude.defaultModel`，
 * 新建 Claude 会话时由 `initialClaudeSessionSettings` 采用；已有会话不受影响。
 */
export function ClaudeDefaultModelSettings({ models }: { models: ClaudeModel[] }) {
  const { defaultModel, loaded, setDefaultModel } = useClaudeDefaultModel()

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
            onChange={(event) => void setDefaultModel(event.target.value || null)}
          >
            <option value="">CLI 默认</option>
            {models.map((model) => (
              <option key={model.value} value={model.value}>{model.displayName}</option>
            ))}
          </select>
        </label>
      </div>
    </section>
  )
}

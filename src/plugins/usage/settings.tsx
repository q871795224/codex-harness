import { useEffect, useState } from 'react'
import { Activity, Cloud, Cpu, Save } from 'lucide-react'
import type { CodexAnalyticsCounterMode } from '../../core/codex-analytics/types'
import type { PluginSettingsProps } from '../../extensions/types'

export function readCounterMode(config: Readonly<Record<string, unknown>>): CodexAnalyticsCounterMode {
  return config.tokenCounter === 'official' ? 'official' : 'local'
}

export function CodexAnalyticsSettings({ instance, saveConfig }: PluginSettingsProps) {
  const [mode, setMode] = useState(() => readCounterMode(instance.config))
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    setMode(readCounterMode(instance.config))
    setMessage(null)
  }, [instance.config, instance.instanceId])

  const save = async () => {
    setSaving(true)
    setMessage(null)
    try {
      await saveConfig({ tokenCounter: mode })
      setMessage('已保存，新产生的记录将使用该模式')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="codex-analytics-settings">
      <div className="codex-analytics-settings-intro">
        <Activity size={15} />
        <span>计数在独立后台线程完成；任何失败都只影响分析精度，不影响 Codex 执行。</span>
      </div>
      <div className="codex-analytics-counter-options" role="radiogroup" aria-label="Token 计数方式">
        <label className={mode === 'local' ? 'selected' : ''}>
          <input type="radio" name="token-counter" checked={mode === 'local'} onChange={() => { setMode('local'); setMessage(null) }} />
          <Cpu size={18} />
          <span><strong>本地分词器</strong><small>默认。使用 o200k_base，不联网、不发送正文，延迟最低。</small></span>
        </label>
        <label className={mode === 'official' ? 'selected' : ''}>
          <input type="radio" name="token-counter" checked={mode === 'official'} onChange={() => { setMode('official'); setMessage(null) }} />
          <Cloud size={18} />
          <span><strong>OpenAI 官方接口</strong><small>调用 /responses/input_tokens；需进程环境中的 OPENAI_API_KEY，失败时自动回退本地。</small></span>
        </label>
      </div>
      <p className="codex-analytics-settings-note">官方模式会把用户输入、Skill 内容和 MCP 参数/结果发送给 OpenAI。官方文档目前未单独承诺该端点免费或无限速，因此采集器采用单并发、有界队列和短超时。</p>
      <div className="codex-analytics-settings-save">
        <button type="button" disabled={saving} onClick={() => void save()}><Save size={14} />{saving ? '保存中…' : '保存设置'}</button>
        {message ? <span>{message}</span> : null}
      </div>
    </div>
  )
}

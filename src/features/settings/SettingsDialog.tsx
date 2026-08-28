import { useCallback, useEffect, useMemo, useState } from 'react'
import { Blocks, BrainCircuit, CircleHelp, FolderOpen, Keyboard, LoaderCircle, MessageSquareText, Minus, Moon, Palette, Plus, Power, RefreshCw, Server, Sparkles, Sun, Type, X } from 'lucide-react'
import { usePluginHost } from '../../core/plugins/react'
import type { CodexSkill, FollowUpMode, FontSize, FontSizeArea, FontSizePreferences, HarnessActionId, HarnessActionShortcuts, RuntimeVersions, SendShortcut, Theme, Thread, ThreadTitleGenerationSettings, Workspace } from '../../core/domain/codex'
import { DEFAULT_FONT_SIZES, DEFAULT_THREAD_TITLE_GENERATION, MAX_FONT_SIZE, MIN_FONT_SIZE, threadTitle } from '../../core/domain/codex'
import { runtime } from '../../core/runtime/bridge'
import type { HarnessPlugin, PluginInstanceRecord, PluginInstanceStatus, PluginScope, PluginScopeKind } from '../../extensions/types'
import type { useCodexCore } from '../codex/useCodexCore'
import { conflictingAction, formatShortcut, harnessActionDefinitions, shortcutFromEvent } from '../actions/harnessActions'

interface SettingsDialogProps {
  theme: Theme
  fontSizes: FontSizePreferences
  sendShortcut: SendShortcut
  followUpMode: FollowUpMode
  actionShortcuts: HarnessActionShortcuts
  workspaces: Workspace[]
  threads: Thread[]
  selectedThreadId: string | null
  selectedWorkspaceRoot: string | null
  codex: ReturnType<typeof useCodexCore>
  threadTitleGeneration: ThreadTitleGenerationSettings
  onTheme: (theme: Theme) => void
  onFontSize: (area: FontSizeArea, fontSize: FontSize) => void
  onResetFontSizes: () => void
  onSendShortcut: (shortcut: SendShortcut) => void
  onFollowUpMode: (mode: FollowUpMode) => void
  onActionShortcut: (actionId: HarnessActionId, shortcut: string) => void
  onResetActionShortcuts: () => void
  onThreadTitleGeneration: (settings: ThreadTitleGenerationSettings) => void
  onClose: () => void
}

type SettingsPage = 'appearance' | 'keyboard' | 'models' | 'thread-title' | 'skills' | 'mcp' | 'plugins'

const fontSizeAreas: Array<{ area: FontSizeArea; label: string }> = [
  { area: 'navigation', label: '导航与列表' },
  { area: 'conversation', label: '会话与输入' },
  { area: 'settings', label: '设置界面' },
  { area: 'plugins', label: '插件界面' },
]

export function SettingsDialog({ theme, fontSizes, sendShortcut, followUpMode, actionShortcuts, workspaces, threads, selectedThreadId, selectedWorkspaceRoot, codex, threadTitleGeneration, onTheme, onFontSize, onResetFontSizes, onSendShortcut, onFollowUpMode, onActionShortcut, onResetActionShortcuts, onThreadTitleGeneration, onClose }: SettingsDialogProps) {
  const [page, setPage] = useState<SettingsPage>('appearance')
  const [versions, setVersions] = useState<RuntimeVersions | null>(null)
  const [versionsLoading, setVersionsLoading] = useState(true)
  const [versionsError, setVersionsError] = useState<string | null>(null)
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null)
  const pageMeta: Record<SettingsPage, { heading: string; kicker: string }> = {
    appearance: { heading: '外观', kicker: 'APPEARANCE' },
    keyboard: { heading: '快捷键', kicker: 'KEYBOARD' },
    models: { heading: '模型', kicker: 'CODEX' },
    'thread-title': { heading: '会话标题', kicker: 'AUTOMATION' },
    skills: { heading: '技能', kicker: 'CODEX' },
    mcp: { heading: 'MCP', kicker: 'CODEX' },
    plugins: { heading: '插件', kicker: 'EXTENSIONS' },
  }

  const loadVersions = useCallback(async () => {
    setVersionsLoading(true)
    setVersionsError(null)
    try {
      setVersions(await runtime.getRuntimeVersions())
    } catch (error) {
      setVersionsError(error instanceof Error ? error.message : String(error))
    } finally {
      setVersionsLoading(false)
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  useEffect(() => {
    void loadVersions()
  }, [loadVersions])

  const openDiagnostics = useCallback(async () => {
    setDiagnosticsError(null)
    try {
      await runtime.openDiagnosticsDirectory()
    } catch (error) {
      setDiagnosticsError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
        <aside className="settings-nav" aria-label="设置菜单">
          <div className="settings-nav-brand">
            <span className="settings-kicker">HARNESS</span>
            <h2>设置</h2>
          </div>
          <nav>
            <button type="button" className={page === 'appearance' ? 'selected' : ''} aria-current={page === 'appearance' ? 'page' : undefined} onClick={() => setPage('appearance')}>
              <Palette size={16} />外观
            </button>
            <button type="button" className={page === 'keyboard' ? 'selected' : ''} aria-current={page === 'keyboard' ? 'page' : undefined} onClick={() => setPage('keyboard')}>
              <Keyboard size={16} />快捷键
            </button>
            <button type="button" className={page === 'models' ? 'selected' : ''} aria-current={page === 'models' ? 'page' : undefined} onClick={() => setPage('models')}>
              <BrainCircuit size={16} />模型
            </button>
            <button type="button" className={page === 'thread-title' ? 'selected' : ''} aria-current={page === 'thread-title' ? 'page' : undefined} onClick={() => setPage('thread-title')}>
              <MessageSquareText size={16} />会话标题
            </button>
            <button type="button" className={page === 'skills' ? 'selected' : ''} aria-current={page === 'skills' ? 'page' : undefined} onClick={() => setPage('skills')}>
              <Sparkles size={16} />技能
            </button>
            <button type="button" className={page === 'mcp' ? 'selected' : ''} aria-current={page === 'mcp' ? 'page' : undefined} onClick={() => setPage('mcp')}>
              <Server size={16} />MCP
            </button>
            <button type="button" className={page === 'plugins' ? 'selected' : ''} aria-current={page === 'plugins' ? 'page' : undefined} onClick={() => setPage('plugins')}>
              <Blocks size={16} />插件
            </button>
          </nav>
        </aside>

        <div className="settings-panel">
          <header className="settings-panel-head">
            <div>
              <span className="settings-kicker">{pageMeta[page].kicker}</span>
              <h2 id="settings-title">{pageMeta[page].heading}</h2>
            </div>
            <button type="button" className="settings-close" onClick={onClose} aria-label="关闭设置"><X size={18} /></button>
          </header>

          {page === 'appearance' && <AppearanceSettings theme={theme} fontSizes={fontSizes} onTheme={onTheme} onFontSize={onFontSize} onResetFontSizes={onResetFontSizes} />}
          {page === 'keyboard' && <KeyboardSettings sendShortcut={sendShortcut} followUpMode={followUpMode} actionShortcuts={actionShortcuts} onSendShortcut={onSendShortcut} onFollowUpMode={onFollowUpMode} onActionShortcut={onActionShortcut} onResetActionShortcuts={onResetActionShortcuts} />}
          {page === 'models' && <ModelsSettings codex={codex} />}
          {page === 'thread-title' && <ThreadTitleSettings codex={codex} settings={threadTitleGeneration} onChange={onThreadTitleGeneration} />}
          {page === 'skills' && <SkillsSettings workspaceRoot={selectedWorkspaceRoot} />}
          {page === 'mcp' && <McpSettings codex={codex} />}
          {page === 'plugins' && <PluginSettings workspaces={workspaces} threads={threads} selectedThreadId={selectedThreadId} />}
          <SettingsVersions
            versions={versions}
            loading={versionsLoading}
            error={versionsError}
            onRefresh={() => void loadVersions()}
            diagnosticsError={diagnosticsError}
            onOpenDiagnostics={() => void openDiagnostics()}
          />
        </div>
      </section>
    </div>
  )
}

function ThreadTitleSettings({ codex, settings, onChange }: {
  codex: ReturnType<typeof useCodexCore>
  settings: ThreadTitleGenerationSettings
  onChange: (settings: ThreadTitleGenerationSettings) => void
}) {
  const [promptDraft, setPromptDraft] = useState(settings.prompt)
  const selectedModel = codex.models.find((model) => model.model === settings.model) ?? null
  const efforts = selectedModel?.supportedReasoningEfforts.map((option) => option.reasoningEffort) ?? [settings.effort]

  useEffect(() => setPromptDraft(settings.prompt), [settings.prompt])

  const selectModel = (modelId: string) => {
    const model = codex.models.find((candidate) => candidate.model === modelId)
    const effort = model?.supportedReasoningEfforts.some((option) => option.reasoningEffort === settings.effort)
      ? settings.effort
      : model?.defaultReasoningEffort ?? settings.effort
    onChange({ ...settings, model: modelId, effort })
  }

  return (
    <div className="settings-section codex-settings">
      <section className="codex-setting-card">
        <div className="settings-section-title"><MessageSquareText size={17} /><div><h3>自动命名</h3><p>在未命名会话的回合完成后，用独立的只读临时会话生成标题。</p></div></div>
        <div className="settings-row-list">
          <label className="settings-row">
            <span>模型</span>
            <select value={settings.model} disabled={codex.loading} onChange={(event) => selectModel(event.target.value)}>
              {!selectedModel && <option value={settings.model}>{settings.model}</option>}
              {codex.models.map((model) => <option key={model.id} value={model.model}>{model.displayName}</option>)}
            </select>
          </label>
          <label className="settings-row">
            <span>推理强度</span>
            <select value={settings.effort} disabled={codex.loading} onChange={(event) => onChange({ ...settings, effort: event.target.value })}>
              {efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
            </select>
          </label>
        </div>
        <label className="title-prompt-field">
          <span>开发者提示词</span>
          <textarea value={promptDraft} onChange={(event) => setPromptDraft(event.target.value)} spellCheck={false} />
        </label>
        <div className="title-prompt-actions">
          <button type="button" onClick={() => { setPromptDraft(DEFAULT_THREAD_TITLE_GENERATION.prompt); onChange({ ...settings, prompt: DEFAULT_THREAD_TITLE_GENERATION.prompt }) }}>恢复默认</button>
          <button type="button" className="primary" disabled={!promptDraft.trim() || promptDraft === settings.prompt} onClick={() => onChange({ ...settings, prompt: promptDraft.trim() })}>保存提示词</button>
        </div>
      </section>
    </div>
  )
}

function SettingsVersions({
  versions,
  loading,
  error,
  onRefresh,
  diagnosticsError,
  onOpenDiagnostics,
}: {
  versions: RuntimeVersions | null
  loading: boolean
  error: string | null
  onRefresh: () => void
  diagnosticsError: string | null
  onOpenDiagnostics: () => void
}) {
  const entries = [
    ['Harness', versions?.harness ?? null],
    ['App Server', versions?.appServer ?? null],
    ['Codex CLI', versions?.codexCli ?? null],
  ] as const

  return (
    <footer className="settings-versions" aria-label="版本信息">
      <div className="settings-versions-copy">
        <span className="settings-versions-title">版本信息</span>
        <dl className="settings-version-list" title={error ?? undefined}>
          {entries.map(([label, version]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd className={version ? undefined : 'unavailable'}>{version ? `v${version}` : loading ? '读取中…' : '未检测到'}</dd>
            </div>
          ))}
        </dl>
        <span className="settings-diagnostics-note">诊断日志不记录对话正文或凭证</span>
      </div>
      <div className="settings-versions-actions">
        <button
          className="settings-open-logs"
          type="button"
          title={diagnosticsError ? `无法打开日志目录：${diagnosticsError}` : '打开诊断日志目录'}
          onClick={onOpenDiagnostics}
        >
          <FolderOpen size={15} />日志
        </button>
        <button
          className="settings-versions-refresh"
          type="button"
          title={error ? `重新读取版本：${error}` : '重新读取版本'}
          aria-label="重新读取版本"
          onClick={onRefresh}
          disabled={loading}
        >
          {loading ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
        </button>
      </div>
    </footer>
  )
}

function ModelsSettings({ codex }: { codex: ReturnType<typeof useCodexCore> }) {
  const selectedModel = codex.models.find((model) => model.model === codex.defaults.model) ?? codex.models[0] ?? null

  return (
    <div className="settings-section codex-settings">
      <section className="codex-setting-card">
        <div className="settings-section-title"><BrainCircuit size={17} /><div><h3>默认模型</h3><p>用于新会话；单个会话可在输入框中覆盖。</p></div></div>
        <div className="settings-row-list">
          <label className="settings-row"><span>模型</span><select value={codex.defaults.model} disabled={codex.loading || codex.models.length === 0} onChange={(event) => void codex.updateDefault('model', event.target.value)}>{codex.models.map((model) => <option key={model.id} value={model.model}>{model.displayName}</option>)}</select></label>
          <label className="settings-row"><span>推理强度</span><select value={codex.defaults.effort} disabled={codex.loading || !selectedModel} onChange={(event) => void codex.updateDefault('model_reasoning_effort', event.target.value)}>{(selectedModel?.supportedReasoningEfforts ?? []).map((option) => <option key={option.reasoningEffort} value={option.reasoningEffort}>{option.reasoningEffort}</option>)}</select></label>
          <label className="settings-row"><span>审批模式</span><select value={codex.defaults.approvalPolicy} disabled={codex.loading} onChange={(event) => void codex.updateDefault('approval_policy', event.target.value)}><option value="on-request">On request</option><option value="untrusted">Untrusted</option><option value="never">Never</option></select></label>
        </div>
      </section>
      {codex.error && <div className="plugin-settings-error">{codex.error}</div>}
    </div>
  )
}

function SkillsSettings({ workspaceRoot }: { workspaceRoot: string | null }) {
  const [skills, setSkills] = useState<CodexSkill[]>([])
  const [scanErrors, setScanErrors] = useState<Array<{ path: string; message: string }>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadSkills = useCallback(async (forceReload = false) => {
    setLoading(true)
    setError(null)
    setScanErrors([])
    try {
      if (!workspaceRoot) {
        setSkills([])
        return
      }
      const skillResult = await runtime.request<{ data: Array<{ skills: CodexSkill[]; errors: Array<{ path: string; message: string }> }> }>('skills/list', { cwds: [workspaceRoot], forceReload })
      setSkills(skillResult.data.flatMap((entry) => entry.skills))
      setScanErrors(skillResult.data.flatMap((entry) => entry.errors ?? []))
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    } finally {
      setLoading(false)
    }
  }, [workspaceRoot])

  useEffect(() => { void loadSkills() }, [loadSkills])

  const toggleSkill = async (skill: CodexSkill) => {
    setError(null)
    try {
      await runtime.request('skills/config/write', { path: skill.path, enabled: !skill.enabled })
      await loadSkills(true)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    }
  }

  return (
    <div className="settings-section codex-settings">
      <section className="codex-setting-card">
        <div className="settings-section-title"><Sparkles size={17} /><div><h3>已发现技能</h3><p>{workspaceRoot ? <>Codex 基于目录 <code className="codex-scan-path">{workspaceRoot}</code> 发现 {skills.length} 个有效技能</> : '选择一个目录上下文后查看可用技能。'}</p></div><button type="button" className="codex-refresh-button" disabled={loading || !workspaceRoot} onClick={() => void loadSkills(true)}><RefreshCw size={14} /></button></div>
        <div className="codex-inventory-list">
          {skills.map((skill) => <div className="codex-inventory-row" key={skill.path}><div><div className="codex-inventory-name"><strong>{skill.name}</strong><span>{skillSource(skill)}</span></div><small>{skill.description || skill.path}</small></div><button type="button" className={`codex-runtime-status codex-skill-status ${skill.enabled ? 'connected' : 'disabled'}`} onClick={() => void toggleSkill(skill)}><Power size={11} />{skill.enabled ? '已启用' : '已停用'}</button></div>)}
          {!loading && workspaceRoot && skills.length === 0 && <div className="codex-empty">这个目录上下文中没有发现技能。</div>}
        </div>
      </section>
      {scanErrors.map((scanError) => <div key={`${scanError.path}:${scanError.message}`} className="plugin-settings-error"><strong>{scanError.path}</strong><br />{scanError.message}</div>)}
      {error && <div className="plugin-settings-error">{error}</div>}
    </div>
  )
}

function McpSettings({ codex }: { codex: ReturnType<typeof useCodexCore> }) {
  return (
    <div className="settings-section codex-settings">
      <section className="codex-setting-card">
        <div className="settings-section-title"><Server size={17} /><div><h3>已配置服务</h3><p>显示 Codex 全局配置中的 MCP 服务及运行状态。</p></div><button type="button" className="codex-refresh-button" disabled={codex.mcpLoading} onClick={() => void codex.reloadMcp()}><RefreshCw size={14} /></button></div>
        <div className="codex-inventory-list">
          {codex.mcpServers.map((server) => {
            const toolCount = Object.keys(server.tools ?? {}).length
            const enabled = codex.config.mcp_servers?.[server.name]?.enabled !== false
            return <div className="codex-inventory-row" key={server.name}><div><strong>{server.name}</strong><small>{toolCount} 个工具{server.pluginId ? ` · 插件：${server.pluginId}` : ''}</small></div><span className={`codex-runtime-status ${enabled ? 'enabled' : 'disabled'}`}>{enabled ? '已启用' : '已停用'}</span></div>
          })}
          {!codex.mcpLoading && codex.mcpServers.length === 0 && <div className="codex-empty">没有配置 MCP 服务。</div>}
        </div>
      </section>
      {codex.mcpError && <div className="plugin-settings-error">{codex.mcpError}</div>}
    </div>
  )
}

function skillSource(skill: CodexSkill): string {
  if (skill.pluginId) return `插件 · ${skill.pluginId}`
  if (skill.scope === 'repo') return '仓库'
  if (skill.scope === 'user') return '用户'
  if (skill.scope === 'system') return '系统'
  if (skill.scope === 'admin') return '管理员'
  return skill.scope
}

function AppearanceSettings({ theme, fontSizes, onTheme, onFontSize, onResetFontSizes }: {
  theme: Theme
  fontSizes: FontSizePreferences
  onTheme: (theme: Theme) => void
  onFontSize: (area: FontSizeArea, fontSize: FontSize) => void
  onResetFontSizes: () => void
}) {
  const canReset = fontSizeAreas.some(({ area }) => fontSizes[area] !== DEFAULT_FONT_SIZES[area])

  return (
    <div className="settings-section settings-stack">
      <section className="settings-preference-block" aria-labelledby="theme-title">
        <div className="settings-section-title">
          <Palette size={17} />
          <div><h3 id="theme-title">主题</h3><p>切换 Harness 的界面配色。</p></div>
        </div>
        <div className="theme-options" role="radiogroup" aria-label="主题">
          <button type="button" role="radio" aria-checked={theme === 'light'} className={theme === 'light' ? 'selected' : ''} onClick={() => onTheme('light')}>
            <span className="theme-preview light"><Sun size={16} /></span><span><strong>浅色</strong><small>明亮、清晰</small></span>
          </button>
          <button type="button" role="radio" aria-checked={theme === 'dark'} className={theme === 'dark' ? 'selected' : ''} onClick={() => onTheme('dark')}>
            <span className="theme-preview dark"><Moon size={16} /></span><span><strong>深色</strong><small>低光环境</small></span>
          </button>
        </div>
      </section>
      <section className="settings-preference-block" aria-labelledby="font-size-title">
        <div className="settings-section-title">
          <Type size={17} />
          <h3 id="font-size-title">字体大小</h3>
        </div>
        <div className="settings-row-list">
          {fontSizeAreas.map(({ area, label }) => (
            <div key={area} className="settings-row">
              <span>{label}</span>
              <FontSizeStepper label={label} value={fontSizes[area]} onChange={(value) => onFontSize(area, value)} />
            </div>
          ))}
          <div className="settings-row settings-reset-row">
            <span>全部字号</span>
            <button type="button" onClick={onResetFontSizes} disabled={!canReset}>恢复默认</button>
          </div>
        </div>
      </section>
    </div>
  )
}

function KeyboardSettings({ sendShortcut, followUpMode, actionShortcuts, onSendShortcut, onFollowUpMode, onActionShortcut, onResetActionShortcuts }: {
  sendShortcut: SendShortcut
  followUpMode: FollowUpMode
  actionShortcuts: HarnessActionShortcuts
  onSendShortcut: (shortcut: SendShortcut) => void
  onFollowUpMode: (mode: FollowUpMode) => void
  onActionShortcut: (actionId: HarnessActionId, shortcut: string) => void
  onResetActionShortcuts: () => void
}) {
  return (
    <div className="settings-stack keyboard-settings">
      <section className="settings-section" aria-labelledby="action-shortcut-title">
        <div className="settings-section-title">
          <Keyboard size={17} />
          <div><h3 id="action-shortcut-title">应用操作</h3><p>点击快捷键后直接按下新的组合键；数字会话按侧栏当前可见顺序切换。</p></div>
        </div>
        <div className="settings-row-list">
          {harnessActionDefinitions.map((action) => (
            <ShortcutRecorder key={action.id} action={action} shortcuts={actionShortcuts} onChange={onActionShortcut} />
          ))}
          <div className="settings-row settings-reset-row"><span>全部应用快捷键</span><button type="button" onClick={onResetActionShortcuts}>恢复默认</button></div>
        </div>
      </section>
      <section className="settings-section" aria-labelledby="send-shortcut-title">
        <div className="settings-section-title">
          <Keyboard size={17} />
          <div><h3 id="send-shortcut-title">输入与发送</h3><p>设置发送快捷键和 Codex 运行时处理后续消息的默认方式。</p></div>
        </div>
        <div className="settings-row-list">
          <label className="settings-row">
            <span>发送快捷键</span>
            <select value={sendShortcut} onChange={(event) => onSendShortcut(event.target.value as SendShortcut)}>
              <option value="mod-enter">⌘ / Ctrl + Enter</option>
              <option value="enter">Enter</option>
            </select>
          </label>
          <label className="settings-row">
            <span>后续消息默认行为</span>
            <select value={followUpMode} onChange={(event) => onFollowUpMode(event.target.value as FollowUpMode)}>
              <option value="queue">排队</option>
              <option value="interject">插话</option>
            </select>
          </label>
          <div className="settings-shortcut-note">{sendShortcut === 'enter' ? 'Shift + Enter 换行' : 'Enter 换行'}</div>
        </div>
      </section>
    </div>
  )
}

function ShortcutRecorder({ action, shortcuts, onChange }: {
  action: { id: HarnessActionId; label: string }
  shortcuts: HarnessActionShortcuts
  onChange: (actionId: HarnessActionId, shortcut: string) => void
}) {
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="settings-row shortcut-setting-row">
      <span>{action.label}{error && <small>{error}</small>}</span>
      <button
        type="button"
        className={recording ? 'recording' : ''}
        onClick={() => { setRecording(true); setError(null) }}
        onBlur={() => setRecording(false)}
        onKeyDown={(event) => {
          if (!recording) return
          event.preventDefault()
          event.stopPropagation()
          const shortcut = shortcutFromEvent(event)
          if (!shortcut) {
            setError('请使用组合键或 Esc')
            return
          }
          const conflict = conflictingAction(shortcuts, action.id, shortcut)
          if (conflict) {
            const label = harnessActionDefinitions.find(({ id }) => id === conflict)?.label ?? conflict
            setError(`与“${label}”冲突`)
            return
          }
          onChange(action.id, shortcut)
          setRecording(false)
          setError(null)
        }}
      >
        {recording ? '请按快捷键…' : formatShortcut(shortcuts[action.id])}
      </button>
    </div>
  )
}

function FontSizeStepper({ label, value, onChange }: { label: string; value: FontSize; onChange: (value: FontSize) => void }) {
  return (
    <div className="font-size-stepper">
      <button type="button" onClick={() => onChange(value - 1)} disabled={value <= MIN_FONT_SIZE} aria-label={`减小${label}字号`}><Minus size={16} /></button>
      <output aria-label={`${label}字号`}>{value} px</output>
      <button type="button" onClick={() => onChange(value + 1)} disabled={value >= MAX_FONT_SIZE} aria-label={`增大${label}字号`}><Plus size={16} /></button>
    </div>
  )
}

function PluginSettings({ workspaces, threads, selectedThreadId }: { workspaces: Workspace[]; threads: Thread[]; selectedThreadId: string | null }) {
  const plugins = usePluginHost()
  const [selectedPluginId, setSelectedPluginId] = useState(() => plugins.definitions[0]?.manifest.id ?? '')
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null)
  const selectedDefinition = plugins.definitions.find((definition) => definition.manifest.id === selectedPluginId) ?? plugins.definitions[0] ?? null
  const selectedInstances = selectedDefinition
    ? plugins.instances.filter((instance) => instance.pluginId === selectedDefinition.manifest.id)
    : []
  const selectedInstance = selectedInstances.find((instance) => instance.instanceId === selectedInstanceId) ?? selectedInstances[0] ?? null

  useEffect(() => {
    if (!selectedDefinition) return
    if (selectedDefinition.manifest.id !== selectedPluginId) setSelectedPluginId(selectedDefinition.manifest.id)
    if (selectedInstance?.instanceId !== selectedInstanceId) setSelectedInstanceId(selectedInstance?.instanceId ?? null)
  }, [selectedDefinition, selectedInstance, selectedInstanceId, selectedPluginId])

  const selectDefinition = (definition: HarnessPlugin) => {
    const firstInstance = plugins.instances.find((instance) => instance.pluginId === definition.manifest.id)
    setSelectedPluginId(definition.manifest.id)
    setSelectedInstanceId(firstInstance?.instanceId ?? null)
  }

  return (
    <section className="plugin-settings" aria-label="Harness 插件">
      <aside className="plugin-catalog">
        <div className="plugin-catalog-intro">
          <span>插件 <em>{plugins.definitions.length}</em></span>
        </div>
        <nav className="plugin-catalog-list" aria-label="插件列表">
          {plugins.loading ? <div className="plugin-settings-empty">正在读取插件实例…</div> : plugins.definitions.map((definition) => (
            <PluginDefinitionNav
              key={definition.manifest.id}
              definition={definition}
              instances={plugins.instances.filter((instance) => instance.pluginId === definition.manifest.id)}
              selected={definition.manifest.id === selectedDefinition?.manifest.id}
              selectedInstanceId={selectedInstance?.instanceId ?? null}
              workspaces={workspaces}
              threads={threads}
              selectedThreadId={selectedThreadId}
              onSelectDefinition={() => selectDefinition(definition)}
              onSelectInstance={(instanceId) => {
                setSelectedPluginId(definition.manifest.id)
                setSelectedInstanceId(instanceId)
              }}
            />
          ))}
        </nav>
      </aside>
      <div className="plugin-detail-scroll">
        {plugins.error && <div className="plugin-settings-error">{plugins.error}</div>}
        {!plugins.loading && selectedDefinition && selectedInstance ? (
          <PluginInstanceDetail
            definition={selectedDefinition}
            instance={selectedInstance}
            workspaces={workspaces}
            threads={threads}
            selectedThreadId={selectedThreadId}
          />
        ) : !plugins.loading && selectedDefinition ? (
          <div className="plugin-detail-empty"><Blocks size={20} /><strong>{selectedDefinition.manifest.name}</strong><p>暂无实例，点击 + 新增。</p></div>
        ) : null}
      </div>
    </section>
  )
}

function PluginDefinitionNav({ definition, instances, selected, selectedInstanceId, workspaces, threads, selectedThreadId, onSelectDefinition, onSelectInstance }: {
  definition: HarnessPlugin
  instances: PluginInstanceRecord[]
  selected: boolean
  selectedInstanceId: string | null
  workspaces: Workspace[]
  threads: Thread[]
  selectedThreadId: string | null
  onSelectDefinition(): void
  onSelectInstance(instanceId: string): void
}) {
  const plugins = usePluginHost()
  const availableScope = useMemo(
    () => nextAvailableScope(definition, instances, workspaces, threads, selectedThreadId),
    [definition, instances, selectedThreadId, threads, workspaces],
  )
  const selectedInstance = selected
    ? instances.find((instance) => instance.instanceId === selectedInstanceId) ?? null
    : null

  const addInstance = async () => {
    if (!availableScope) return
    const now = Date.now()
    const instance: PluginInstanceRecord = {
      instanceId: crypto.randomUUID(),
      pluginId: definition.manifest.id,
      scope: availableScope,
      enabled: true,
      config: {},
      createdAt: now,
      updatedAt: now,
    }
    await plugins.upsertInstance(instance)
    onSelectInstance(instance.instanceId)
  }

  const removeSelectedInstance = async () => {
    if (!selectedInstance) return
    await plugins.deleteInstance(selectedInstance.instanceId)
  }

  return (
    <div className={`plugin-nav-group ${selected ? 'selected' : ''}`}>
      <div className="plugin-nav-heading">
        <button type="button" onClick={onSelectDefinition}>
          <span className="plugin-nav-mark"><Blocks size={14} /></span>
          <span title={definition.manifest.description}><strong>{definition.manifest.name}</strong><small>{instances.length} 个实例</small></span>
        </button>
        <div className="plugin-nav-actions">
          <button type="button" className="plugin-nav-add" disabled={!availableScope} onClick={() => void addInstance().catch(() => undefined)} title={availableScope ? '新增插件实例' : '没有可用的新归属'} aria-label={`新增 ${definition.manifest.name} 实例`}><Plus size={14} /></button>
          <button type="button" className="plugin-nav-remove" disabled={!selectedInstance} onClick={() => void removeSelectedInstance().catch(() => undefined)} title={selectedInstance ? '删除当前插件实例' : '请选择要删除的实例'} aria-label={`删除 ${definition.manifest.name} 当前实例`}><Minus size={14} /></button>
        </div>
      </div>
      {instances.length > 0 && <div className="plugin-nav-instances">
        {instances.map((instance) => (
          <button key={instance.instanceId} type="button" className={instance.instanceId === selectedInstanceId ? 'selected' : ''} aria-current={instance.instanceId === selectedInstanceId ? 'page' : undefined} onClick={() => onSelectInstance(instance.instanceId)}>
            <span className={`plugin-status-dot ${plugins.status(instance.instanceId).phase}`} />
            <span>{scopeSummary(instance.scope, workspaces, threads)}</span>
          </button>
        ))}
      </div>}
    </div>
  )
}

function PluginInstanceDetail({ definition, instance, workspaces, threads, selectedThreadId }: {
  definition: HarnessPlugin
  instance: PluginInstanceRecord
  workspaces: Workspace[]
  threads: Thread[]
  selectedThreadId: string | null
}) {
  const plugins = usePluginHost()
  const status = plugins.status(instance.instanceId)
  const Settings = definition.settings
  const persist = (next: PluginInstanceRecord) => plugins.upsertInstance(next).catch(() => undefined)
  const updateScopeKind = (kind: PluginScopeKind) => {
    const scope = scopeForKind(kind, workspaces, threads, selectedThreadId)
    if (scope) void persist({ ...instance, scope, updatedAt: Date.now() })
  }
  const updateOwner = (owner: string) => {
    const scope: PluginScope = instance.scope.kind === 'workspace'
      ? { kind: 'workspace', workspaceRoot: owner }
      : { kind: 'thread', threadId: owner }
    void persist({ ...instance, scope, updatedAt: Date.now() })
  }

  return (
    <article className="plugin-instance-detail">
      <header className="plugin-detail-head">
        <div>
          <div className="plugin-detail-title"><h3>{definition.manifest.name}</h3><span className="plugin-field-help" title={definition.manifest.description} aria-label="插件说明"><CircleHelp size={15} /></span></div>
          <div className="plugin-detail-status"><span className={`plugin-status ${status.phase}`}><span />{statusLabel(status.phase)}</span></div>
        </div>
        <div className="plugin-instance-actions">
          <button type="button" className={instance.enabled ? 'enabled' : ''} onClick={() => void persist({ ...instance, enabled: !instance.enabled, updatedAt: Date.now() })} title={instance.enabled ? '停用当前实例' : '启用当前实例'}>
            <Power size={13} />{instance.enabled ? '已启用' : '已停用'}
          </button>
        </div>
      </header>

      <div className="plugin-detail-form">
        <label className="plugin-setting-row">
          <span>归属 <i className="plugin-field-help" title="全局实例始终可用；Workspace 和 Thread 实例只在对应范围内显示。"><CircleHelp size={13} /></i></span>
          <select value={instance.scope.kind} onChange={(event) => updateScopeKind(event.target.value as PluginScopeKind)}>
            {definition.manifest.supportedScopes.map((kind) => (
              <option key={kind} value={kind} disabled={!scopeForKind(kind, workspaces, threads, selectedThreadId)}>{scopeKindLabel(kind)}</option>
            ))}
          </select>
        </label>
        {instance.scope.kind === 'workspace' && (
          <label className="plugin-setting-row">
            <span>Workspace</span>
            <select value={instance.scope.workspaceRoot} onChange={(event) => updateOwner(event.target.value)}>
              {workspaces.map((workspace) => <option key={workspace.root} value={workspace.root}>{workspace.name}</option>)}
            </select>
          </label>
        )}
        {instance.scope.kind === 'thread' && (
          <label className="plugin-setting-row">
            <span>Thread</span>
            <select value={instance.scope.threadId} onChange={(event) => updateOwner(event.target.value)}>
              {threads.map((thread) => <option key={thread.id} value={thread.id}>{threadTitle(thread)}</option>)}
            </select>
          </label>
        )}

        {status.phase === 'failed' && <div className="plugin-instance-error">{status.error}</div>}
        {Settings ? (
          <Settings instance={instance} saveConfig={(config) => plugins.upsertInstance({ ...instance, config, updatedAt: Date.now() })} />
        ) : null}
      </div>
    </article>
  )
}

function nextAvailableScope(
  definition: HarnessPlugin,
  instances: PluginInstanceRecord[],
  workspaces: Workspace[],
  threads: Thread[],
  selectedThreadId: string | null,
): PluginScope | null {
  const used = new Set(instances.map((instance) => scopeIdentity(instance.scope)))
  if (definition.manifest.supportedScopes.includes('global') && !used.has('global')) return { kind: 'global' }
  if (definition.manifest.supportedScopes.includes('workspace')) {
    const workspace = workspaces.find((candidate) => !used.has(`workspace:${candidate.root}`))
    if (workspace) return { kind: 'workspace', workspaceRoot: workspace.root }
  }
  if (definition.manifest.supportedScopes.includes('thread')) {
    const ordered = selectedThreadId
      ? [...threads].sort((left, right) => Number(right.id === selectedThreadId) - Number(left.id === selectedThreadId))
      : threads
    const thread = ordered.find((candidate) => !used.has(`thread:${candidate.id}`))
    if (thread) return { kind: 'thread', threadId: thread.id }
  }
  return null
}

function scopeForKind(kind: PluginScopeKind, workspaces: Workspace[], threads: Thread[], selectedThreadId: string | null): PluginScope | null {
  if (kind === 'global') return { kind: 'global' }
  if (kind === 'workspace') return workspaces[0] ? { kind: 'workspace', workspaceRoot: workspaces[0].root } : null
  const thread = threads.find((candidate) => candidate.id === selectedThreadId) ?? threads[0]
  return thread ? { kind: 'thread', threadId: thread.id } : null
}

function scopeIdentity(scope: PluginScope): string {
  if (scope.kind === 'workspace') return `workspace:${scope.workspaceRoot}`
  if (scope.kind === 'thread') return `thread:${scope.threadId}`
  return 'global'
}

function scopeKindLabel(kind: PluginScopeKind): string {
  if (kind === 'workspace') return 'Workspace'
  if (kind === 'thread') return 'Thread'
  return '全局'
}

function scopeSummary(scope: PluginScope, workspaces: Workspace[], threads: Thread[]): string {
  if (scope.kind === 'workspace') return workspaces.find((workspace) => workspace.root === scope.workspaceRoot)?.name ?? scope.workspaceRoot
  if (scope.kind === 'thread') {
    const thread = threads.find((candidate) => candidate.id === scope.threadId)
    return thread ? threadTitle(thread) : scope.threadId
  }
  return '全局'
}

function statusLabel(phase: PluginInstanceStatus['phase']): string {
  if (phase === 'active') return '运行中'
  if (phase === 'pending') return '启动中'
  if (phase === 'failed') return '启动失败'
  return '已停止'
}

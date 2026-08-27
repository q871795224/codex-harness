import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ApprovalPolicy, CodexConfig, CodexModel, McpServerStatus, ThreadCodexSettings } from '../../core/domain/codex'
import { runtime } from '../../core/runtime/bridge'

export type { ThreadCodexSettings } from '../../core/domain/codex'

interface ConfigReadResponse {
  config: CodexConfig
}

interface ModelListResponse {
  data: CodexModel[]
  nextCursor: string | null
}

interface McpServerListResponse {
  data: McpServerStatus[]
}

const FALLBACK_APPROVAL: ApprovalPolicy = 'on-request'

export function useCodexCore() {
  const [models, setModels] = useState<CodexModel[]>([])
  const [config, setConfig] = useState<CodexConfig>({ model: null, model_reasoning_effort: null, approval_policy: null })
  const [threadSettings, setThreadSettings] = useState<Record<string, ThreadCodexSettings>>({})
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([])
  const [mcpLoading, setMcpLoading] = useState(true)
  const [mcpError, setMcpError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [modelResult, configResult] = await Promise.all([
        runtime.request<ModelListResponse>('model/list', { limit: 100, includeHidden: false }),
        runtime.request<ConfigReadResponse>('config/read', { includeLayers: false }),
      ])
      setModels(modelResult.data.filter((model) => !model.hidden))
      setConfig(configResult.config)
    } catch (nextError) {
      setError(messageOf(nextError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const refreshMcp = useCallback(async () => {
    setMcpLoading(true)
    setMcpError(null)
    try {
      const result = await runtime.request<McpServerListResponse>('mcpServerStatus/list', {
        limit: 100,
        detail: 'toolsAndAuthOnly',
      })
      setMcpServers(result.data)
    } catch (nextError) {
      setMcpError(messageOf(nextError))
    } finally {
      setMcpLoading(false)
    }
  }, [])

  useEffect(() => { void refreshMcp() }, [refreshMcp])

  const reloadMcp = useCallback(async () => {
    setMcpError(null)
    try {
      await runtime.request('config/mcpServer/reload')
      await refreshMcp()
    } catch (nextError) {
      setMcpError(messageOf(nextError))
    }
  }, [refreshMcp])

  const defaults = useMemo(() => resolveDefaults(models, config), [config, models])

  const settingsForThread = useCallback((threadId: string | null): ThreadCodexSettings => {
    if (!threadId) return defaults
    return threadSettings[threadId] ?? defaults
  }, [defaults, threadSettings])

  const updateThreadSettings = useCallback(async (threadId: string, patch: Partial<ThreadCodexSettings>) => {
    setError(null)
    const previous = threadSettings[threadId] ?? defaults
    const next = normalizeThreadSettings({ ...previous, ...patch }, models)
    setThreadSettings((current) => ({ ...current, [threadId]: next }))
    try {
      await runtime.request('thread/settings/update', {
        threadId,
        ...(patch.model !== undefined ? { model: next.model } : {}),
        ...(patch.effort !== undefined ? { effort: next.effort } : {}),
        ...(patch.approvalPolicy !== undefined ? { approvalPolicy: next.approvalPolicy } : {}),
        ...(patch.approvalsReviewer !== undefined ? { approvalsReviewer: next.approvalsReviewer } : {}),
        ...(patch.sandboxMode !== undefined ? { sandboxPolicy: sandboxPolicy(next.sandboxMode) } : {}),
      })
    } catch (nextError) {
      setThreadSettings((current) => ({ ...current, [threadId]: previous }))
      setError(messageOf(nextError))
      throw nextError
    }
  }, [defaults, models, threadSettings])

  const updateDefault = useCallback(async (key: 'model' | 'model_reasoning_effort' | 'approval_policy', value: string) => {
    setError(null)
    try {
      await runtime.request('config/value/write', { keyPath: key, value, mergeStrategy: 'upsert' })
      setConfig((current) => ({ ...current, [key]: value }))
    } catch (nextError) {
      setError(messageOf(nextError))
    }
  }, [])

  return { models, config, defaults, loading, error, reload, settingsForThread, updateThreadSettings, updateDefault, mcpServers, mcpLoading, mcpError, reloadMcp }
}

function resolveDefaults(models: CodexModel[], config: CodexConfig): ThreadCodexSettings {
  const model = models.find((candidate) => candidate.model === config.model)
    ?? models.find((candidate) => candidate.isDefault)
    ?? models[0]
  const effort = model?.supportedReasoningEfforts.some((candidate) => candidate.reasoningEffort === config.model_reasoning_effort)
    ? config.model_reasoning_effort!
    : model?.defaultReasoningEffort ?? 'medium'
  return {
    model: model?.model ?? config.model ?? '',
    effort,
    approvalPolicy: config.approval_policy ?? FALLBACK_APPROVAL,
    approvalsReviewer: config.approvals_reviewer ?? 'user',
    sandboxMode: config.sandbox_mode ?? 'workspace-write',
  }
}

function normalizeThreadSettings(settings: ThreadCodexSettings, models: CodexModel[]): ThreadCodexSettings {
  const model = models.find((candidate) => candidate.model === settings.model)
  if (!model) return settings
  const effort = model.supportedReasoningEfforts.some((candidate) => candidate.reasoningEffort === settings.effort)
    ? settings.effort
    : model.defaultReasoningEffort
  return { ...settings, effort }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sandboxPolicy(mode: ThreadCodexSettings['sandboxMode']) {
  if (mode === 'danger-full-access') return { type: 'dangerFullAccess' }
  if (mode === 'read-only') return { type: 'readOnly', networkAccess: false }
  return {
    type: 'workspaceWrite',
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  }
}

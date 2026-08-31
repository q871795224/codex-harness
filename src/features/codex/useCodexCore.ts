import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ApprovalPolicy, CodexConfig, CodexModel, McpRuntimeStatus, McpServerStatus, ThreadCodexSettings } from '../../core/domain/codex'
import { runtime } from '../../core/runtime/bridge'
import { startupRuntimeStatus } from './mcpStatus'

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

interface McpStartupUpdate {
  runtimeStatus: McpRuntimeStatus
  error: string | null
}

const FALLBACK_APPROVAL: ApprovalPolicy = 'never'

export function useCodexCore() {
  const [models, setModels] = useState<CodexModel[]>([])
  const [config, setConfig] = useState<CodexConfig>({ model: null, model_reasoning_effort: null, approval_policy: null })
  const [threadSettings, setThreadSettings] = useState<Record<string, ThreadCodexSettings>>({})
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([])
  const [mcpStartupUpdates, setMcpStartupUpdates] = useState<Record<string, McpStartupUpdate>>({})
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

  useEffect(() => {
    let unlisten: (() => void) | undefined
    void runtime.listenEvents((event) => {
      if (event.method !== 'mcpServer/startupStatus/updated') return
      const name = typeof event.params?.name === 'string' ? event.params.name : null
      const status = startupRuntimeStatus(event.params?.status)
      if (!name || !status) return
      setMcpStartupUpdates((current) => ({
        ...current,
        [name]: {
          runtimeStatus: status,
          error: typeof event.params?.error === 'string' ? event.params.error : null,
        },
      }))
    }).then((next) => { unlisten = next })
    return () => { unlisten?.() }
  }, [])

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

  const syncThreadSettings = useCallback((threadId: string, actual: Partial<ThreadCodexSettings>) => {
    const next = normalizeThreadSettings({ ...defaults, ...actual }, models)
    setThreadSettings((current) => settingsEqual(current[threadId], next) ? current : { ...current, [threadId]: next })
  }, [defaults, models])

  const updateThreadSettings = useCallback(async (threadId: string, patch: Partial<ThreadCodexSettings>) => {
    setError(null)
    const previous = threadSettings[threadId] ?? defaults
    const next = normalizeThreadSettings({ ...previous, ...patch }, models)
    const serviceTierChanged = patch.serviceTier !== undefined || previous.serviceTier !== next.serviceTier
    setThreadSettings((current) => ({ ...current, [threadId]: next }))
    try {
      await runtime.request('thread/settings/update', {
        threadId,
        ...(patch.model !== undefined ? { model: next.model } : {}),
        ...(patch.effort !== undefined ? { effort: next.effort } : {}),
        ...(serviceTierChanged ? { serviceTier: next.serviceTier } : {}),
        ...(patch.approvalPolicy !== undefined ? { approvalPolicy: next.approvalPolicy } : {}),
        ...(patch.approvalsReviewer !== undefined ? { approvalsReviewer: next.approvalsReviewer } : {}),
        ...(patch.sandboxMode !== undefined ? { sandboxPolicy: sandboxPolicy(next.sandboxMode) } : {}),
      })
    } catch (nextError) {
      setThreadSettings((current) => ({ ...current, [threadId]: previous }))
      setError(messageOf(nextError))
      throw nextError
    }

    const defaultsToPersist: Array<{ keyPath: 'model' | 'service_tier'; value: string }> = []
    if (patch.model !== undefined) defaultsToPersist.push({ keyPath: 'model', value: next.model })
    if (serviceTierChanged) defaultsToPersist.push({ keyPath: 'service_tier', value: next.serviceTier ?? 'default' })
    if (defaultsToPersist.length === 0) return

    try {
      await Promise.all(defaultsToPersist.map(({ keyPath, value }) => runtime.request('config/value/write', { keyPath, value, mergeStrategy: 'upsert' })))
      setConfig((current) => ({
        ...current,
        ...(patch.model !== undefined ? { model: next.model } : {}),
        ...(serviceTierChanged ? { service_tier: next.serviceTier ?? 'default' } : {}),
      }))
    } catch (nextError) {
      setError(`当前会话设置已生效，但无法保存为下次默认值：${messageOf(nextError)}`)
    }
  }, [defaults, models, threadSettings])

  const updateDefault = useCallback(async (key: 'model' | 'model_reasoning_effort' | 'service_tier' | 'approval_policy', value: string) => {
    setError(null)
    try {
      const selectedModel = key === 'model' ? models.find((model) => model.model === value) : null
      const configuredTier = config.service_tier && config.service_tier !== 'default' ? config.service_tier : null
      const clearUnsupportedTier = configuredTier !== null && selectedModel !== null && selectedModel !== undefined
        && !selectedModel.serviceTiers?.some((tier) => tier.id === configuredTier)
      await Promise.all([
        runtime.request('config/value/write', { keyPath: key, value, mergeStrategy: 'upsert' }),
        ...(clearUnsupportedTier ? [runtime.request('config/value/write', { keyPath: 'service_tier', value: 'default', mergeStrategy: 'upsert' })] : []),
      ])
      setConfig((current) => ({ ...current, [key]: value, ...(clearUnsupportedTier ? { service_tier: 'default' } : {}) }))
    } catch (nextError) {
      setError(messageOf(nextError))
    }
  }, [config.service_tier, models])

  const displayedMcpServers = useMemo(() => mcpServers.map((server) => {
    const update = mcpStartupUpdates[server.name]
    return update ? { ...server, runtimeStatus: update.runtimeStatus, startupError: update.error } : server
  }), [mcpServers, mcpStartupUpdates])

  return { models, config, defaults, loading, error, reload, settingsForThread, syncThreadSettings, updateThreadSettings, updateDefault, mcpServers: displayedMcpServers, mcpLoading, mcpError, reloadMcp }
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
    serviceTier: config.service_tier && config.service_tier !== 'default' ? config.service_tier : null,
    approvalPolicy: config.approval_policy ?? FALLBACK_APPROVAL,
    approvalsReviewer: config.approvals_reviewer ?? 'user',
    sandboxMode: config.sandbox_mode ?? 'danger-full-access',
  }
}

function normalizeThreadSettings(settings: ThreadCodexSettings, models: CodexModel[]): ThreadCodexSettings {
  const model = models.find((candidate) => candidate.model === settings.model)
  if (!model) return settings
  const effort = model.supportedReasoningEfforts.some((candidate) => candidate.reasoningEffort === settings.effort)
    ? settings.effort
    : model.defaultReasoningEffort
  const serviceTier = settings.serviceTier && model.serviceTiers?.some((tier) => tier.id === settings.serviceTier)
    ? settings.serviceTier
    : null
  return { ...settings, effort, serviceTier }
}

function settingsEqual(left: ThreadCodexSettings | undefined, right: ThreadCodexSettings): boolean {
  return left?.model === right.model
    && left?.effort === right.effort
    && left?.serviceTier === right.serviceTier
    && left?.approvalPolicy === right.approvalPolicy
    && left?.approvalsReviewer === right.approvalsReviewer
    && left?.sandboxMode === right.sandboxMode
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

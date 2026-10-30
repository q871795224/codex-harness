import net from 'node:net'
import { createInterface } from 'node:readline'
import { chmod, mkdir, open, readFile, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import process from 'node:process'

const ALLOWED_ENVIRONMENT = new Set([
  'HOME',
  'PATH',
  'TMPDIR',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'CODEX_HARNESS_CLAUDE_PATH',
  'CODEX_HARNESS_CLAUDE_SOCKET',
])
for (const key of Object.keys(process.env)) {
  if (!ALLOWED_ENVIRONMENT.has(key)) delete process.env[key]
}

// The SDK adds its own variables to process.env when creating a query. Keep
// those mutations out of both the launch allowlist and reuse comparisons.
const inheritedEnvironment = { ...process.env }

async function queryEnvironment() {
  const configured = Object.create(null)
  if (process.env.HOME) {
    let content
    try {
      content = await readFile(join(process.env.HOME, '.codex-harness', 'secrets'), 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error('无法读取 ~/.codex-harness/secrets')
    }
    // Match the Codex loader's plain KEY=value format; do not execute shell code.
    for (const rawLine of (content ?? '').split('\n')) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const separator = line.indexOf('=')
      if (separator < 1) continue
      const key = line.slice(0, separator).trim()
      if (key) configured[key] = line.slice(separator + 1).trim()
    }
  }
  // Keep explicit values local to this query so edits and removals take effect next time.
  return { ...configured, ...inheritedEnvironment, CLAUDE_AGENT_SDK_CLIENT_APP: 'codex-harness' }
}

let sdk
try {
  sdk = await import('@anthropic-ai/claude-agent-sdk')
} catch {
  sdk = await import('./sdk.mjs')
}
const { getSessionMessages, query } = sdk

const PROTOCOL_VERSION = 2
const MAX_REPLAY_EVENTS = 5_000
const DEFAULT_MAX_TURNS = 65_536
const socketPath = process.env.CODEX_HARNESS_CLAUDE_SOCKET
const lockPath = `${socketPath}.lock`
const claudePath = process.env.CODEX_HARNESS_CLAUDE_PATH || undefined
const daemonInstanceId = randomUUID()
const activeTurns = new Map()
const sessionQueries = new Map()
const QUERY_IDLE_MS = 5 * 60_000
const LEGACY_RESULT_GRACE_MS = 1_000
const INTERRUPT_GRACE_MS = 1_000
const pendingApprovals = new Map()
const sessionStates = new Map()
const modelCache = new Map()
const clients = new Set()
const replayEvents = []
let nextSequence = 1
let stopping = false
let lockHandle

const FALLBACK_MODELS = [
  { value: 'sonnet', resolvedModel: null, displayName: 'Claude Sonnet', description: 'Balanced speed and quality.', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'], supportsAdaptiveThinking: true, supportsFastMode: false, supportsAutoMode: false },
  { value: 'opus', resolvedModel: null, displayName: 'Claude Opus', description: 'Highest capability for complex tasks.', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'], supportsAdaptiveThinking: true, supportsFastMode: false, supportsAutoMode: false },
  { value: 'haiku', resolvedModel: null, displayName: 'Claude Haiku', description: 'Fast and efficient for routine tasks.', supportsEffort: false, supportedEffortLevels: [], supportsAdaptiveThinking: false, supportsFastMode: false, supportsAutoMode: false },
]

if (!socketPath) throw new Error('CODEX_HARNESS_CLAUDE_SOCKET is required')

function send(client, message) {
  if (!client.destroyed) client.write(`${JSON.stringify(message)}\n`)
}

function respond(client, id, result) {
  send(client, { id, result })
}

function fail(client, id, error) {
  send(client, { id, error: { message: errorMessage(error) } })
}

function emit(method, params) {
  const message = { method, params, seq: nextSequence++ }
  replayEvents.push(message)
  if (replayEvents.length > MAX_REPLAY_EVENTS) replayEvents.shift()
  for (const client of clients) send(client, message)
  return message
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function approvalEventParams(approval) {
  return {
    requestId: approval.requestId,
    sessionId: approval.sessionId,
    turnId: approval.turnId,
    toolName: approval.toolName,
    input: approval.input,
    suggestions: approval.suggestions,
  }
}

function approvalSnapshot() {
  return [...pendingApprovals.values()].map(approvalEventParams)
}

function runtimeSnapshot() {
  const snapshotSeq = nextSequence - 1
  return {
    daemonPid: process.pid,
    daemonInstanceId,
    latestEventSeq: snapshotSeq,
    snapshotSeq,
    activeTurns: activeTurnSnapshot(),
    sessionActivities: [...sessionQueries.values()].map(sessionActivity),
    pendingApprovals: approvalSnapshot(),
  }
}

function sessionState(sessionId, cwd = null) {
  let state = sessionStates.get(sessionId)
  if (!state) {
    state = {
      sessionId,
      cwd,
      providerSessionId: null,
      model: null,
      permissionMode: 'default',
      effort: null,
      lastStatus: null,
      lastResult: '',
      totalCostUsd: 0,
      totalUsage: emptyUsage(),
      lastUsage: null,
      modelContextWindow: null,
    }
    sessionStates.set(sessionId, state)
  }
  if (cwd) state.cwd = cwd
  return state
}

function emptyUsage() {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  }
}

function number(value) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0
}

function valueOf(source, ...keys) {
  for (const key of keys) {
    if (source && source[key] !== undefined) return source[key]
  }
  return 0
}

function usageBreakdown(usage) {
  const inputTokens = number(valueOf(usage, 'input_tokens', 'inputTokens'))
  const cachedInputTokens = number(valueOf(usage, 'cache_read_input_tokens', 'cacheReadInputTokens'))
  const cacheWriteInputTokens = number(valueOf(usage, 'cache_creation_input_tokens', 'cacheCreationInputTokens'))
  const outputTokens = number(valueOf(usage, 'output_tokens', 'outputTokens'))
  const reasoningOutputTokens = number(valueOf(usage, 'reasoning_output_tokens', 'reasoningOutputTokens'))
  const explicitTotal = valueOf(usage, 'total_tokens', 'totalTokens')
  const totalTokens = explicitTotal ? number(explicitTotal) : inputTokens + cachedInputTokens + cacheWriteInputTokens + outputTokens
  return { totalTokens, inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens }
}

function addUsage(left, right) {
  return Object.fromEntries(Object.keys(left).map((key) => [key, number(left[key]) + number(right[key])]))
}

function normalizeTurnUsage(sdkUsage, modelUsage, state) {
  const last = usageBreakdown(sdkUsage)
  state.totalUsage = addUsage(state.totalUsage, last)
  const contextWindow = Object.values(modelUsage && typeof modelUsage === 'object' ? modelUsage : {})
    .map((entry) => number(entry?.contextWindow))
    .filter((value) => value > 0)
    .reduce((current, value) => Math.max(current, value), state.modelContextWindow ?? 0)
  state.modelContextWindow = contextWindow || state.modelContextWindow || null
  state.lastUsage = {
    total: state.totalUsage,
    last,
    modelContextWindow: state.modelContextWindow,
  }
  return state.lastUsage
}

function modelInfo(model) {
  if (!model || typeof model !== 'object' || typeof model.value !== 'string') return null
  return {
    value: model.value,
    resolvedModel: typeof model.resolvedModel === 'string' ? model.resolvedModel : null,
    displayName: typeof model.displayName === 'string' ? model.displayName : model.value,
    description: typeof model.description === 'string' ? model.description : '',
    supportsEffort: model.supportsEffort === true,
    supportedEffortLevels: Array.isArray(model.supportedEffortLevels) ? model.supportedEffortLevels.filter((entry) => typeof entry === 'string') : [],
    supportsAdaptiveThinking: model.supportsAdaptiveThinking === true,
    supportsFastMode: model.supportsFastMode === true,
    supportsAutoMode: model.supportsAutoMode === true,
  }
}

function imageMediaType(path) {
  const normalized = path.toLowerCase()
  if (normalized.endsWith('.png')) return 'image/png'
  if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) return 'image/jpeg'
  if (normalized.endsWith('.gif')) return 'image/gif'
  if (normalized.endsWith('.webp')) return 'image/webp'
  throw new Error(`不支持的 Claude 图片格式: ${path}`)
}

async function userMessage(input, uuid) {
  const content = []
  for (const item of input ?? []) {
    if (item?.type === 'text' && typeof item.text === 'string') {
      content.push({ type: 'text', text: item.text })
    } else if (item?.type === 'localImage' && typeof item.path === 'string') {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: imageMediaType(item.path),
          data: await readFile(item.path, 'base64'),
        },
      })
    } else if (item?.type === 'mention' && typeof item.path === 'string') {
      content.push({ type: 'text', text: `请读取这个本地文件：${item.path}` })
    }
  }
  if (content.length === 0) throw new Error('Claude turn 输入不能为空')
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: content.length === 1 && content[0].type === 'text' ? content[0].text : content },
    parent_tool_use_id: null,
  }
}

function approvalRequest(sessionId, turnId, toolName, input, context) {
  const requestId = randomUUID()
  let resolveApproval
  let rejectApproval
  let removeAbortListener = () => {}
  const pending = {
    requestId,
    sessionId,
    turnId,
    toolName,
    input,
    suggestions: context?.suggestions ?? [],
    resolve: (decision) => {
      removeAbortListener()
      resolveApproval(decision)
    },
    expire: (reason) => {
      if (!pendingApprovals.delete(requestId)) return false
      removeAbortListener()
      emit('approval/expired', { ...approvalEventParams(pending), reason })
      rejectApproval(new Error('Claude approval was cancelled'))
      return true
    },
  }
  const promise = new Promise((resolve, reject) => {
    resolveApproval = resolve
    rejectApproval = reject
    const abort = () => pending.expire('turn-interrupted')
    removeAbortListener = () => context?.signal?.removeEventListener('abort', abort)
    context?.signal?.addEventListener('abort', abort, { once: true })
  })
  pendingApprovals.set(requestId, pending)
  emit('approval/requested', approvalEventParams(pending))
  if (context?.signal?.aborted) pending.expire('turn-interrupted')
  return promise
}

function assistantBlocks(message, sessionId, turnId) {
  for (const block of message.message?.content ?? []) {
    if (block.type === 'text') {
      emit('message/completed', {
        sessionId,
        turnId,
        itemId: `${turnId}:assistant`,
        text: block.text,
      })
    } else if (block.type === 'tool_use') {
      emit('tool/started', {
        sessionId,
        turnId,
        itemId: block.id,
        toolName: block.name,
        input: block.input,
      })
    }
  }
}

function streamDelta(message, sessionId, turnId) {
  const event = message.event
  if (event?.type !== 'content_block_delta' || event.delta?.type !== 'text_delta') return
  emit('message/delta', {
    sessionId,
    turnId,
    itemId: `${turnId}:assistant`,
    delta: event.delta.text,
  })
}

function userBlocks(message, sessionId, turnId) {
  const content = message.message?.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
    emit('tool/completed', {
      sessionId,
      turnId,
      itemId: block.tool_use_id,
      isError: Boolean(block.is_error),
    })
  }
}

// Input stays open across turns so SDK control responses and background work
// retain their channel. A result is not EOF: SDK idle is the turn-over signal.
function inputQueue() {
  const messages = []
  let wake
  let ended = false
  return {
    push(message) { messages.push(message); wake?.(); wake = undefined },
    end() { ended = true; wake?.(); wake = undefined },
    async *[Symbol.asyncIterator]() {
      while (!ended) {
        if (messages.length) yield messages.shift()
        else await new Promise(resolve => { wake = resolve })
      }
    },
  }
}

function finishTurn(runtime, status, message) {
  const active = activeTurns.get(runtime.sessionId)
  if (!active || active.runtime !== runtime) return
  clearTimeout(active.resultTimer)
  clearTimeout(active.interruptTimer)
  const result = active.result
  const state = sessionState(runtime.sessionId)
  for (const pending of pendingApprovals.values()) {
    if (pending.sessionId === runtime.sessionId && pending.turnId === active.turnId) pending.expire('turn-ended')
  }
  // Release ownership BEFORE notifying the UI (which can immediately drain a queue).
  activeTurns.delete(runtime.sessionId)
  publishSessionActivity(runtime)
  state.lastStatus = status
  emit(`turn/${status}`, {
    sessionId: runtime.sessionId, turnId: active.turnId,
    providerSessionId: state.providerSessionId,
    ...(status === 'completed' ? {
      result: result?.result ?? '', usage: state.lastUsage,
      totalCostUsd: state.totalCostUsd, model: state.model,
      queuedTurnCount: number(result?.queued_turn_count),
    } : { code: result?.subtype, message: message ?? (result?.errors?.join('\n') || result?.subtype || 'Claude turn 已中断') }),
  })
  scheduleQueryCleanup(runtime)
}

function userBackgroundTasks(runtime) {
  return [...runtime.backgroundTasks.values()].filter(task => !task.ambient)
}

function sessionActivity(runtime) {
  return {
    sessionId: runtime.sessionId,
    state: !runtime.busy ? 'idle' : runtime.sessionState ?? 'running',
    backgroundTaskCount: userBackgroundTasks(runtime).length,
  }
}

function publishSessionActivity(runtime) {
  const activity = sessionActivity(runtime)
  const signature = JSON.stringify(activity)
  if (signature !== runtime.lastActivity) {
    runtime.lastActivity = signature
    emit('session/activity', activity)
  }
  if (runtime.stopping && !runtime.busy && userBackgroundTasks(runtime).length === 0
    && !activeTurns.has(runtime.sessionId)) {
    clearTimeout(runtime.stopTimer)
    runtime.stopping = false
  }
}

async function stopSession(sessionId) {
  const active = activeTurns.get(sessionId)
  if (active && !active.runtime) throw new Error('Claude turn 正在准备，请稍后重试停止。')
  const runtime = sessionQueries.get(sessionId)
  if (!runtime) {
    return
  }
  if (runtime.stopping) return
  if (!active && !runtime.busy && userBackgroundTasks(runtime).length === 0) return
  runtime.stopping = true
  if (active) active.interrupted = true
  // ACKs do not prove work has stopped. Keep reporting activity until the SDK
  // confirms idle + no user tasks, or this session's transport has closed.
  runtime.stopTimer = setTimeout(() => {
    void closeSessionQuery(runtime).catch(() => undefined)
  }, INTERRUPT_GRACE_MS)
  runtime.stopTimer.unref()
  try {
    const controls = userBackgroundTasks(runtime).map(task => runtime.query.stopTask(task.task_id))
    if (active || runtime.busy) controls.push(runtime.query.interrupt())
    await Promise.race([Promise.all(controls), runtime.done])
  } catch {
    // An older CLI or a failed task-control call can still be stopped by closing
    // just this query. The shared daemon and other sessions remain untouched.
    await closeSessionQuery(runtime)
  }
}

function scheduleQueryCleanup(runtime) {
  clearTimeout(runtime.idleTimer)
  if (activeTurns.has(runtime.sessionId) || runtime.busy || runtime.backgroundTasks.size > 0 || runtime.closing) return
  runtime.idleTimer = setTimeout(() => void closeSessionQuery(runtime), QUERY_IDLE_MS)
  runtime.idleTimer.unref()
}

async function closeSessionQuery(runtime) {
  runtime.closing = true
  clearTimeout(runtime.idleTimer)
  clearTimeout(runtime.stopTimer)
  runtime.input.end()
  runtime.query.close?.()
  runtime.abortController.abort()
  await runtime.done
}

async function consumeSessionQuery(runtime) {
  const { sessionId } = runtime
  const state = sessionState(sessionId)
  let failure
  try {
    for await (const message of runtime.query) {
      if (message.session_id && message.session_id !== state.providerSessionId) {
        state.providerSessionId = message.session_id
        emit('session/started', { sessionId, providerSessionId: message.session_id })
      }
      if (typeof message.model === 'string' && message.model) state.model = message.model
      if (message.type === 'system' && message.subtype === 'background_tasks_changed') {
        runtime.backgroundTasks = new Map((message.tasks ?? []).map(task => [task.task_id, task]))
        publishSessionActivity(runtime)
        scheduleQueryCleanup(runtime)
      }
      if (message.type === 'system' && message.subtype === 'session_state_changed') {
        runtime.hasLifecycleEvents = true
        runtime.sessionState = message.state
        runtime.busy = message.state !== 'idle'
        publishSessionActivity(runtime)
        scheduleQueryCleanup(runtime)
      }
      const active = activeTurns.get(sessionId)
      const owned = active?.runtime === runtime ? active : null
      const turnId = owned?.turnId ?? runtime.lastTurnId
      if (message.type === 'stream_event') streamDelta(message, sessionId, turnId)
      else if (message.type === 'assistant') assistantBlocks(message, sessionId, turnId)
      else if (message.type === 'user') userBlocks(message, sessionId, turnId)
      else if (message.type === 'result') {
        // The SDK reports a running query total, including background results.
        runtime.queryCost = Math.max(runtime.queryCost ?? 0, number(message.total_cost_usd))
        state.totalCostUsd = runtime.costBase + runtime.queryCost
        // A delayed background result for a previous input cannot finish a new send.
        if (message.user_message_uuid) {
          runtime.resultIds = true
          if (message.user_message_uuid !== owned?.providerMessageId) continue
        } else if (runtime.resultIds && !owned?.result) continue
        if (!owned) continue
        owned.result = message
        state.lastUsage = normalizeTurnUsage(message.usage, message.modelUsage, state)
        if (message.subtype === 'success') state.lastResult = message.result ?? ''
        if (runtime.busy === false) {
          finishTurn(runtime, owned.interrupted ? 'interrupted'
            : message.subtype === 'success' ? 'completed' : 'failed')
        } else if (!runtime.hasLifecycleEvents) {
          // Older CLIs can report a final result without lifecycle notifications.
          // Keep their query open for background work, but release the logical turn.
          clearTimeout(owned.resultTimer)
          owned.resultTimer = setTimeout(() => {
            if (activeTurns.get(sessionId) !== owned || runtime.hasLifecycleEvents) return
            runtime.busy = false
            finishTurn(runtime, owned.interrupted ? 'interrupted'
              : owned.result.subtype === 'success' ? 'completed' : 'failed')
          }, LEGACY_RESULT_GRACE_MS)
          owned.resultTimer.unref()
        }
      } else if (message.type === 'system' && message.subtype === 'session_state_changed' && message.state === 'idle') {
        if (owned && (owned.result || owned.interrupted)) finishTurn(runtime, owned.interrupted ? 'interrupted'
          : owned.result?.subtype === 'success' ? 'completed' : 'failed')
      }
    }
  } catch (error) {
    failure = errorMessage(error)
  } finally {
    runtime.closing = true
    clearTimeout(runtime.idleTimer)
    clearTimeout(runtime.stopTimer)
    runtime.input.end()
    // Query.return() awaits the SDK's transport cleanup. Do not resume the same
    // provider session in a replacement CLI while that cleanup is still pending.
    try { await runtime.query.return?.() } catch (error) { failure ??= errorMessage(error) }
    runtime.busy = false
    runtime.backgroundTasks.clear()
    if (sessionQueries.get(sessionId) === runtime) sessionQueries.delete(sessionId)
    for (const pending of pendingApprovals.values()) {
      if (pending.sessionId === sessionId) pending.expire('query-ended')
    }
    publishSessionActivity(runtime)
    const active = activeTurns.get(sessionId)
    if (active?.runtime === runtime) {
      // Older CLIs can end the stream without emitting session_state_changed.
      finishTurn(runtime, active.interrupted ? 'interrupted'
        : !failure && active.result?.subtype === 'success' ? 'completed' : 'failed',
      failure ?? (active.result ? undefined : 'Claude 消息流在回合完成前结束'))
    }
  }
}

async function startTurn(params) {
  const { sessionId, turnId } = params
  if (!sessionId || !turnId || !params.cwd) throw new Error('Claude turn 缺少 sessionId、turnId 或 cwd')
  if (activeTurns.has(sessionId)) throw new Error('该 Claude 会话已有运行中的 turn')
  const active = { turnId, providerMessageId: randomUUID(), runtime: null, result: null, interrupted: false }
  activeTurns.set(sessionId, active)
  try {
    const message = await userMessage(params.input, active.providerMessageId)
    const env = await queryEnvironment()
    const permissionMode = params.permissionMode ?? 'default'
    const settings = { cwd: params.cwd, model: params.model ?? null, effort: params.effort ?? null,
      permissionMode, maxTurns: params.maxTurns ?? DEFAULT_MAX_TURNS }
    const key = createHash('sha256').update(JSON.stringify([settings,
      Object.keys(env).sort().map(key => [key, env[key]])])).digest('hex')
    let runtime = sessionQueries.get(sessionId)
    if (runtime?.stopping) throw new Error('Claude 会话正在停止，请稍后重试。')
    if (runtime && (runtime.key !== key || runtime.closing)) {
      if (runtime.busy || runtime.backgroundTasks.size > 0) throw new Error('Claude 后台任务仍在运行，请结束后台任务后再更改模型、权限或环境配置。')
      await closeSessionQuery(runtime)
      runtime = null
    }
    const state = sessionState(sessionId, params.cwd)
    state.providerSessionId = params.providerSessionId ?? state.providerSessionId
    state.model = params.model ?? state.model
    state.permissionMode = permissionMode
    state.effort = params.effort ?? state.effort
    state.lastStatus = 'inProgress'
    if (!runtime) {
      const abortController = new AbortController()
      runtime = { sessionId, key, input: inputQueue(), abortController,
        backgroundTasks: new Map(), costBase: state.totalCostUsd, closing: false }
      runtime.query = query({ prompt: runtime.input, options: {
        cwd: params.cwd,
        ...(state.providerSessionId ? { resume: state.providerSessionId } : {}),
        ...(params.model ? { model: params.model } : {}),
        ...(params.effort ? { effort: params.effort } : {}),
        ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
        settingSources: ['user', 'project', 'local'], permissionMode,
        ...(permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true }
          : { canUseTool: (toolName, input, context) => approvalRequest(sessionId,
            activeTurns.get(sessionId)?.turnId ?? runtime.lastTurnId, toolName, input, context) }),
        maxTurns: settings.maxTurns, includePartialMessages: true, abortController, env,
      } })
      sessionQueries.set(sessionId, runtime)
      active.runtime = runtime
      runtime.done = consumeSessionQuery(runtime)
    }
    clearTimeout(runtime.idleTimer)
    runtime.lastTurnId = turnId
    runtime.busy = true
    runtime.sessionState = 'running'
    active.runtime = runtime
    publishSessionActivity(runtime)
    emit('turn/started', { sessionId, turnId })
    emit('message/user', { sessionId, turnId, itemId: `${turnId}:user`, providerMessageId: active.providerMessageId, content: params.input ?? [] })
    runtime.input.push(message)
  } catch (error) {
    if (activeTurns.get(sessionId) === active) activeTurns.delete(sessionId)
    throw error
  }
}

async function* waitForInput() {
  await new Promise(() => {})
}

async function queryOptions(params, abortController) {
  const permissionMode = params.permissionMode ?? 'default'
  return {
    cwd: params.cwd,
    ...(params.providerSessionId ? { resume: params.providerSessionId } : {}),
    ...(params.model ? { model: params.model } : {}),
    ...(params.effort ? { effort: params.effort } : {}),
    ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
    settingSources: ['user', 'project', 'local'],
    permissionMode,
    ...(permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
    maxTurns: params.maxTurns ?? DEFAULT_MAX_TURNS,
    includePartialMessages: false,
    abortController,
    env: await queryEnvironment(),
  }
}

async function listModels(params) {
  const cwd = typeof params.cwd === 'string' && params.cwd ? params.cwd : process.cwd()
  const cached = modelCache.get(cwd)
  if (cached && cached.expiresAt > Date.now()) return { models: cached.models }
  const abortController = new AbortController()
  try {
    const modelQuery = query({ prompt: waitForInput(), options: await queryOptions({ cwd }, abortController) })
    const initialization = await modelQuery.initializationResult()
    const models = (initialization.models ?? []).map(modelInfo).filter(Boolean)
    const result = models.length > 0 ? models : FALLBACK_MODELS
    modelCache.set(cwd, { models: result, expiresAt: Date.now() + 5 * 60_000 })
    return { models: result }
  } catch (error) {
    return { models: FALLBACK_MODELS, warning: errorMessage(error) }
  } finally {
    abortController.abort()
  }
}

async function readContext(params) {
  const sessionId = params.sessionId
  const state = sessionState(sessionId, params.cwd)
  if (activeTurns.has(sessionId)) {
    if (state.lastUsage) return contextFromUsage(state.lastUsage, state.model)
    throw new Error('Claude 会话当前正在运行，请等待回合结束后读取上下文。')
  }
  if (!state.providerSessionId && !params.providerSessionId) {
    if (state.lastUsage) return contextFromUsage(state.lastUsage, state.model)
    return null
  }
  const owner = sessionQueries.get(sessionId)
  const abortController = new AbortController()
  try {
    const contextQuery = owner?.query ?? query({
      prompt: waitForInput(),
      options: await queryOptions({
        cwd: params.cwd ?? state.cwd,
        providerSessionId: params.providerSessionId ?? state.providerSessionId,
        model: state.model,
        permissionMode: state.permissionMode,
        effort: state.effort,
      }, abortController),
    })
    await contextQuery.initializationResult()
    const usage = await contextQuery.getContextUsage()
    return {
      totalTokens: number(usage.totalTokens),
      maxTokens: number(usage.maxTokens),
      rawMaxTokens: number(usage.rawMaxTokens),
      percentage: number(usage.percentage),
      model: typeof usage.model === 'string' ? usage.model : state.model,
    }
  } catch (error) {
    if (state.lastUsage) return contextFromUsage(state.lastUsage, state.model)
    throw error
  } finally {
    abortController.abort()
  }
}

async function listSkills(params) {
  if (typeof params.cwd !== 'string' || !params.cwd) throw new Error('读取 Claude Skills 缺少 cwd')
  const abortController = new AbortController()
  try {
    const skillsQuery = query({ prompt: waitForInput(), options: await queryOptions({ cwd: params.cwd }, abortController) })
    const commands = await skillsQuery.supportedCommands()
    return { source: 'Claude Agent SDK supportedCommands',
      coverage: 'user-invocable command surface; includes commands, omits user-invocable:false skills', complete: false,
      data: commands.map(({ name, description, argumentHint }) => ({ name, description, argumentHint })) }
  } finally {
    abortController.abort()
  }
}

async function readHistory(params) {
  const providerSessionId = typeof params.providerSessionId === 'string'
    ? params.providerSessionId.trim()
    : ''
  if (!providerSessionId) return { messages: [] }
  if (typeof getSessionMessages !== 'function') {
    throw new Error('当前 Claude Agent SDK 不支持读取历史会话')
  }

  const cwd = typeof params.cwd === 'string' && params.cwd ? params.cwd : undefined
  const messages = await getSessionMessages(providerSessionId, cwd ? { dir: cwd } : {})
  return {
    messages: messages.map((message) => ({
      type: message.type,
      uuid: message.uuid,
      sessionId: typeof message.session_id === 'string' ? message.session_id : providerSessionId,
      message: message.message,
      parentToolUseId: message.parent_tool_use_id ?? null,
      timestamp: typeof message.timestamp === 'string' ? message.timestamp : null,
    })),
  }
}

function contextFromUsage(usage, model) {
  const totalTokens = number(usage.last?.totalTokens ?? usage.total?.totalTokens)
  const maxTokens = number(usage.modelContextWindow)
  return {
    totalTokens,
    maxTokens,
    rawMaxTokens: maxTokens,
    percentage: maxTokens > 0 ? totalTokens / maxTokens * 100 : 0,
    model: model ?? '',
  }
}

function sessionStatus(params) {
  const state = sessionState(params.sessionId, params.cwd)
  const active = activeTurns.get(params.sessionId)
  return {
    sessionId: params.sessionId,
    providerSessionId: state.providerSessionId,
    active: Boolean(active),
    turnId: active?.turnId ?? null,
    lastTurnStatus: state.lastStatus,
    lastResult: state.lastResult,
    usage: state.lastUsage,
    costUsd: state.totalCostUsd,
  }
}

function activeTurnSnapshot() {
  return [...activeTurns.entries()].map(([sessionId, active]) => ({ sessionId, turnId: active.turnId }))
}

async function handle(client, request) {
  const { id, method, params = {} } = request
  if (method === 'initialize') {
    const lastEventSeq = Number.isSafeInteger(params.lastEventSeq) ? params.lastEventSeq : 0
    respond(client, id, { protocolVersion: PROTOCOL_VERSION, daemonVersion: '0.2.0', ...runtimeSnapshot() })
    for (const event of replayEvents) {
      if (event.seq > lastEventSeq) send(client, { ...event, replayed: true })
    }
    return
  }
  if (method === 'runtime/status') {
    respond(client, id, runtimeSnapshot())
    return
  }
  if (method === 'provider/models') {
    respond(client, id, await listModels(params))
    return
  }
  if (method === 'provider/skills') {
    respond(client, id, await listSkills(params))
    return
  }
  if (method === 'session/history') {
    respond(client, id, await readHistory(params))
    return
  }
  if (method === 'session/context') {
    respond(client, id, await readContext(params))
    return
  }
  if (method === 'session/status') {
    respond(client, id, sessionStatus(params))
    return
  }
  if (method === 'session/readLastMessage') {
    const result = sessionStatus(params).lastResult
    if (!result) throw new Error('Claude 会话尚未生成可读取的结果')
    respond(client, id, { text: result })
    return
  }
  if (method === 'turn/start') {
    if (activeTurns.has(params.sessionId)) throw new Error('该 Claude 会话已有运行中的 turn')
    await startTurn(params)
    respond(client, id, { accepted: true })
    return
  }
  if (method === 'turn/interrupt') {
    const active = activeTurns.get(params.sessionId)
    if (!active) throw new Error('Claude 会话当前没有运行中的 turn')
    if (!active.runtime) throw new Error('Claude turn 正在准备，请稍后重试停止。')
    active.interrupted = true
    // Control ACK is not a terminal event. If idle never follows (or the control
    // request hangs), close this session's query and let its consumer finish it.
    active.interruptTimer ??= setTimeout(() => {
      if (activeTurns.get(params.sessionId) !== active) return
      void closeSessionQuery(active.runtime).catch(() => undefined)
    }, INTERRUPT_GRACE_MS)
    active.interruptTimer.unref()
    try {
      await Promise.race([active.runtime.query.interrupt(), active.runtime.done])
    } catch (error) {
      // Closing the SDK rejects outstanding control requests before its consumer
      // has emitted the terminal event. That is expected during forced stop.
      if (active.runtime.closing) await active.runtime.done
      else {
        if (activeTurns.get(params.sessionId) === active) {
          clearTimeout(active.interruptTimer)
          active.interruptTimer = undefined
          active.interrupted = false
        }
        throw error
      }
    }
    respond(client, id, {})
    return
  }
  if (method === 'session/stop') {
    await stopSession(params.sessionId)
    respond(client, id, {})
    return
  }
  if (method === 'approval/respond') {
    const pending = pendingApprovals.get(params.requestId)
    if (!pending) throw new Error('Claude approval 已不存在')
    pendingApprovals.delete(params.requestId)
    const outcome = params.allow ? 'allowed' : 'denied'
    pending.resolve(params.allow
      ? { behavior: 'allow', updatedInput: params.updatedInput ?? params.input ?? {} }
      : { behavior: 'deny', message: params.message || 'User declined in Codex Harness' })
    const resolution = emit('approval/resolved', { ...approvalEventParams(pending), outcome })
    respond(client, id, { resolvedSeq: resolution.seq })
    return
  }
  if (method === 'shutdown') {
    respond(client, id, {})
    void stopDaemon()
    return
  }
  throw new Error(`未知 Claude Provider 方法: ${method}`)
}

async function socketIsReachable() {
  return new Promise((resolve) => {
    const probe = net.createConnection(socketPath)
    probe.once('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.once('error', () => resolve(false))
  })
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function acquireLock() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      lockHandle = await open(lockPath, 'wx', 0o600)
      await lockHandle.writeFile(String(process.pid))
      return
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const owner = Number.parseInt(await readFile(lockPath, 'utf8').catch(() => ''), 10)
      if (processIsAlive(owner)) throw new Error(`Claude Provider daemon is already starting or running (pid ${owner})`)
      await rm(lockPath, { force: true })
    }
  }
  throw new Error('无法取得 Claude Provider daemon lock')
}

async function prepareSocket() {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })
  if (await socketIsReachable()) throw new Error('Claude Provider daemon is already running')
  await acquireLock()
  if (await socketIsReachable()) throw new Error('Claude Provider daemon is already running')
  await rm(socketPath, { force: true })
}

const server = net.createServer((client) => {
  clients.add(client)
  client.on('close', () => clients.delete(client))
  const lines = createInterface({ input: client, crlfDelay: Infinity })
  lines.on('line', (line) => {
    if (!line.trim()) return
    let request
    try {
      request = JSON.parse(line)
    } catch (error) {
      send(client, { error: { message: `无效 JSON: ${errorMessage(error)}` } })
      return
    }
    void handle(client, request).catch((error) => fail(client, request.id, error))
  })
})

async function stopDaemon() {
  if (stopping) return
  stopping = true
  await Promise.allSettled([...sessionQueries.values()].map(closeSessionQuery))
  for (const client of clients) client.end()
  server.close()
}

await prepareSocket()
server.listen(socketPath, async () => {
  await chmod(socketPath, 0o600)
})

process.on('SIGINT', () => void stopDaemon())
process.on('SIGTERM', () => void stopDaemon())
server.on('close', () => {
  void (async () => {
    await rm(socketPath, { force: true }).catch(() => undefined)
    await lockHandle?.close().catch(() => undefined)
    await rm(lockPath, { force: true }).catch(() => undefined)
    process.exit(0)
  })()
})

import net from 'node:net'
import { createInterface } from 'node:readline'
import { chmod, mkdir, open, readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
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

let sdk
try {
  sdk = await import('@anthropic-ai/claude-agent-sdk')
} catch {
  sdk = await import('./sdk.mjs')
}
const { query } = sdk

const PROTOCOL_VERSION = 2
const MAX_REPLAY_EVENTS = 5_000
const DEFAULT_MAX_TURNS = 65_536
const socketPath = process.env.CODEX_HARNESS_CLAUDE_SOCKET
const lockPath = `${socketPath}.lock`
const claudePath = process.env.CODEX_HARNESS_CLAUDE_PATH || undefined
const daemonInstanceId = randomUUID()
const activeTurns = new Map()
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

async function userMessage(input) {
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
    message: { role: 'user', content: content.length === 1 && content[0].type === 'text' ? content[0].text : content },
    parent_tool_use_id: null,
  }
}

async function* singleMessage(message) {
  yield message
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

async function startTurn(params) {
  const sessionId = params.sessionId
  const turnId = params.turnId
  if (!sessionId || !turnId || !params.cwd) throw new Error('Claude turn 缺少 sessionId、turnId 或 cwd')
  if (activeTurns.has(sessionId)) throw new Error('该 Claude 会话已有运行中的 turn')

  const abortController = new AbortController()
  activeTurns.set(sessionId, { turnId, abortController })
  const state = sessionState(sessionId, params.cwd)
  state.providerSessionId = params.providerSessionId ?? state.providerSessionId
  state.model = params.model ?? state.model
  state.permissionMode = params.permissionMode ?? state.permissionMode
  state.effort = params.effort ?? state.effort
  state.lastStatus = 'inProgress'
  emit('turn/started', { sessionId, turnId })
  emit('message/user', { sessionId, turnId, itemId: `${turnId}:user`, content: params.input ?? [] })

  let providerSessionId = params.providerSessionId ?? null
  const permissionMode = params.permissionMode ?? 'default'
  try {
    const message = await userMessage(params.input)
    for await (const sdkMessage of query({
      prompt: singleMessage(message),
      options: {
        cwd: params.cwd,
        ...(providerSessionId ? { resume: providerSessionId } : {}),
        ...(params.model ? { model: params.model } : {}),
        ...(params.effort ? { effort: params.effort } : {}),
        ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
        settingSources: ['user', 'project', 'local'],
        permissionMode,
        ...(permissionMode === 'bypassPermissions'
          ? { allowDangerouslySkipPermissions: true }
          : { canUseTool: (toolName, input, context) => approvalRequest(sessionId, turnId, toolName, input, context) }),
        maxTurns: params.maxTurns ?? DEFAULT_MAX_TURNS,
        includePartialMessages: true,
        abortController,
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'codex-harness' },
      },
    })) {
      if (sdkMessage.session_id && sdkMessage.session_id !== providerSessionId) {
        providerSessionId = sdkMessage.session_id
        state.providerSessionId = providerSessionId
        emit('session/started', { sessionId, providerSessionId })
      }
      if (typeof sdkMessage.model === 'string' && sdkMessage.model) state.model = sdkMessage.model
      if (sdkMessage.type === 'stream_event') streamDelta(sdkMessage, sessionId, turnId)
      else if (sdkMessage.type === 'assistant') assistantBlocks(sdkMessage, sessionId, turnId)
      else if (sdkMessage.type === 'user') userBlocks(sdkMessage, sessionId, turnId)
      else if (sdkMessage.type === 'result') {
        if (sdkMessage.subtype === 'success') {
          const turnCostUsd = number(sdkMessage.total_cost_usd)
          emit('turn/completed', {
            sessionId,
            turnId,
            providerSessionId,
            result: sdkMessage.result ?? '',
            usage: normalizeTurnUsage(sdkMessage.usage, sdkMessage.modelUsage, state),
            totalCostUsd: state.totalCostUsd + turnCostUsd,
            model: state.model,
            queuedTurnCount: number(sdkMessage.queued_turn_count),
          })
          state.lastResult = sdkMessage.result ?? ''
          state.lastStatus = 'completed'
          state.totalCostUsd += turnCostUsd
        } else {
          emit('turn/failed', {
            sessionId,
            turnId,
            providerSessionId,
            code: sdkMessage.subtype,
            message: sdkMessage.errors?.join('\n') || sdkMessage.subtype,
          })
          state.lastStatus = 'failed'
        }
      }
    }
  } catch (error) {
    state.lastStatus = abortController.signal.aborted ? 'interrupted' : 'failed'
    emit(abortController.signal.aborted ? 'turn/interrupted' : 'turn/failed', {
      sessionId,
      turnId,
      providerSessionId,
      message: errorMessage(error),
    })
  } finally {
    for (const pending of pendingApprovals.values()) {
      if (pending.sessionId === sessionId && pending.turnId === turnId) pending.expire('turn-ended')
    }
    activeTurns.delete(sessionId)
  }
}

async function* waitForInput() {
  await new Promise(() => {})
}

function queryOptions(params, abortController) {
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
    env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'codex-harness' },
  }
}

async function listModels(params) {
  const cwd = typeof params.cwd === 'string' && params.cwd ? params.cwd : process.cwd()
  const cached = modelCache.get(cwd)
  if (cached && cached.expiresAt > Date.now()) return { models: cached.models }
  const abortController = new AbortController()
  try {
    const modelQuery = query({ prompt: waitForInput(), options: queryOptions({ cwd }, abortController) })
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
  const abortController = new AbortController()
  try {
    const contextQuery = query({
      prompt: waitForInput(),
      options: queryOptions({
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
    respond(client, id, { accepted: true })
    void startTurn(params)
    return
  }
  if (method === 'turn/interrupt') {
    const active = activeTurns.get(params.sessionId)
    if (!active) throw new Error('Claude 会话当前没有运行中的 turn')
    active.abortController.abort()
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
  for (const active of activeTurns.values()) active.abortController.abort()
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

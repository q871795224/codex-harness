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
const clients = new Set()
const replayEvents = []
let nextSequence = 1
let stopping = false
let lockHandle

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
        emit('session/started', { sessionId, providerSessionId })
      }
      if (sdkMessage.type === 'stream_event') streamDelta(sdkMessage, sessionId, turnId)
      else if (sdkMessage.type === 'assistant') assistantBlocks(sdkMessage, sessionId, turnId)
      else if (sdkMessage.type === 'user') userBlocks(sdkMessage, sessionId, turnId)
      else if (sdkMessage.type === 'result') {
        if (sdkMessage.subtype === 'success') {
          emit('turn/completed', {
            sessionId,
            turnId,
            providerSessionId,
            result: sdkMessage.result ?? '',
            usage: sdkMessage.usage ?? null,
            totalCostUsd: sdkMessage.total_cost_usd ?? null,
          })
        } else {
          emit('turn/failed', {
            sessionId,
            turnId,
            providerSessionId,
            code: sdkMessage.subtype,
            message: sdkMessage.errors?.join('\n') || sdkMessage.subtype,
          })
        }
      }
    }
  } catch (error) {
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

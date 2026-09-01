import { createInterface } from 'node:readline'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

let sdk
try {
  sdk = await import('@anthropic-ai/claude-agent-sdk')
} catch {
  sdk = await import('./sdk.mjs')
}
const { query } = sdk

const PROTOCOL_VERSION = 1
const activeTurns = new Map()
const pendingApprovals = new Map()
let claudePath = process.env.CODEX_HARNESS_CLAUDE_PATH || undefined

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function respond(id, result) {
  send({ id, result })
}

function fail(id, error) {
  send({ id, error: { message: errorMessage(error) } })
}

function emit(method, params) {
  send({ method, params })
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
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
  emit('approval/requested', {
    requestId,
    sessionId,
    turnId,
    toolName,
    input,
    suggestions: context?.suggestions ?? [],
  })
  return new Promise((resolve, reject) => {
    const abort = () => {
      pendingApprovals.delete(requestId)
      reject(new Error('Claude approval was cancelled'))
    }
    context?.signal?.addEventListener('abort', abort, { once: true })
    pendingApprovals.set(requestId, {
      resolve: (decision) => {
        context?.signal?.removeEventListener('abort', abort)
        resolve(decision)
      },
    })
  })
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

  let providerSessionId = params.providerSessionId ?? null
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
        permissionMode: params.permissionMode ?? 'default',
        maxTurns: params.maxTurns ?? 40,
        includePartialMessages: true,
        abortController,
        canUseTool: (toolName, input, context) => approvalRequest(sessionId, turnId, toolName, input, context),
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
    activeTurns.delete(sessionId)
  }
}

async function handle(request) {
  const { id, method, params = {} } = request
  if (method === 'initialize') {
    claudePath = params.claudePath || claudePath
    respond(id, { protocolVersion: PROTOCOL_VERSION, adapterVersion: '0.1.0' })
    return
  }
  if (method === 'turn/start') {
    if (activeTurns.has(params.sessionId)) throw new Error('该 Claude 会话已有运行中的 turn')
    respond(id, { accepted: true })
    void startTurn(params)
    return
  }
  if (method === 'turn/interrupt') {
    const active = activeTurns.get(params.sessionId)
    if (!active) throw new Error('Claude 会话当前没有运行中的 turn')
    active.abortController.abort()
    respond(id, {})
    return
  }
  if (method === 'approval/respond') {
    const pending = pendingApprovals.get(params.requestId)
    if (!pending) throw new Error('Claude approval 已不存在')
    pendingApprovals.delete(params.requestId)
    pending.resolve(params.allow
      ? { behavior: 'allow', updatedInput: params.updatedInput ?? params.input ?? {} }
      : { behavior: 'deny', message: params.message || 'User declined in Codex Harness' })
    respond(id, {})
    return
  }
  if (method === 'shutdown') {
    for (const active of activeTurns.values()) active.abortController.abort()
    respond(id, {})
    process.exitCode = 0
    process.stdin.pause()
    return
  }
  throw new Error(`未知 Claude adapter 方法: ${method}`)
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', (line) => {
  if (!line.trim()) return
  let request
  try {
    request = JSON.parse(line)
  } catch (error) {
    send({ error: { message: `无效 JSON: ${errorMessage(error)}` } })
    return
  }
  void handle(request).catch((error) => fail(request.id, error))
})

lines.on('close', () => {
  for (const active of activeTurns.values()) active.abortController.abort()
})

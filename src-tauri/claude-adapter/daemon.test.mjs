import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { setTimeout } from 'node:timers/promises'

// The copied daemon falls back to this SDK fixture, never the real SDK or a model.
const sdkFixture = `
import { execFileSync } from 'node:child_process'
const history = []
export async function getSessionMessages() { return history }
export function query({ prompt, options }) {
  const snapshot = execFileSync(process.execPath, ['-e',
    'console.log(JSON.stringify(Object.fromEntries(["DB_PASSWORD", "ENV", "UNCONFIGURED_SECRET", "LANG", "CLAUDE_AGENT_SDK_CLIENT_APP"].map(key => [key, process.env[key] ?? null]))))'
  ], { env: options.env, encoding: 'utf8' }).trim()
  return {
    async *[Symbol.asyncIterator]() {
      for await (const message of prompt) {
        history.push({ ...message, session_id: 'fixture-session' })
        yield { type: 'result', subtype: 'success', session_id: 'fixture-session', user_message_uuid: message.uuid, result: snapshot }
        yield { type: 'system', subtype: 'session_state_changed', state: 'idle' }
      }
    },
    async initializationResult() { return { models: [{ value: 'fixture', description: snapshot }] } },
    async supportedCommands() { return [{ name: 'fixture-skill', description: 'Fixture skill', argumentHint: 'file' }] },
    async getContextUsage() { return { model: snapshot } },
  }
}
`

async function waitFor(read) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await setTimeout(10)
  }
  throw new Error('Timed out waiting for fixture daemon')
}

async function fixture(t, sdkSource = sdkFixture, cliSource) {
  const home = await mkdtemp(join(tmpdir(), 'claude-env-'))
  const secrets = join(home, '.codex-harness', 'secrets')
  const socketPath = join(home, 'daemon.sock')
  await mkdir(join(home, '.codex-harness'))
  await copyFile(new URL('./daemon.mjs', import.meta.url), join(home, 'daemon.mjs'))
  await writeFile(join(home, 'sdk.mjs'), sdkSource)
  if (cliSource) {
    await writeFile(join(home, 'cli.mjs'), cliSource)
    await chmod(join(home, 'cli.mjs'), 0o700)
  }
  const child = spawn(process.execPath, [join(home, 'daemon.mjs')], {
    env: {
      HOME: home,
      PATH: process.env.PATH,
      LANG: 'fixture-lang',
      DB_PASSWORD: 'discard-this-inherited-value',
      UNCONFIGURED_SECRET: 'discard-this-too',
      CODEX_HARNESS_CLAUDE_SOCKET: socketPath,
      ...(cliSource ? { CODEX_HARNESS_CLAUDE_PATH: join(home, 'cli.mjs') } : {}),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const exited = once(child, 'exit')
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  let client
  t.after(async () => {
    client?.destroy()
    child.kill('SIGTERM')
    await exited
    await rm(home, { recursive: true, force: true })
  })
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Fixture daemon exited: ${stderr}`)
    return stat(socketPath).catch(() => null)
  })
  client = net.createConnection(socketPath)
  await once(client, 'connect')
  const messages = []
  const lines = createInterface({ input: client })
  lines.on('line', (line) => messages.push(JSON.parse(line)))
  let nextId = 0
  async function request(method, params = {}) {
    const id = ++nextId
    client.write(`${JSON.stringify({ id, method, params })}\n`)
    const response = await waitFor(() => messages.find((message) => message.id === id))
    if (response.error) throw new Error(response.error.message)
    return response.result
  }
  return {
    home,
    secrets,
    request,
    messages,
    async turn() {
      const turnId = `turn-${nextId}`
      await request('turn/start', { sessionId: 'session', turnId, cwd: home, input: [{ type: 'text', text: 'fixture' }] })
      const event = await waitFor(() => messages.find((message) =>
        message.params?.turnId === turnId && ['turn/completed', 'turn/failed'].includes(message.method)))
      assert.equal(event.method, 'turn/completed', event.params.message)
      return JSON.parse(event.params.result)
    },
    async models(cwd = home) {
      const result = await request('provider/models', { cwd })
      return JSON.parse(result.models[0].description)
    },
  }
}

test('passes explicitly configured values to Claude subprocesses after startup filtering', async (t) => {
  const daemon = await fixture(t)
  await writeFile(daemon.secrets, '\n # comment\r\ninvalid\n = ignored\n DB_PASSWORD = first \r\nDB_PASSWORD = local=p@ss$(literal)#text\nENV=dev\nLANG=file-lang\nCLAUDE_AGENT_SDK_CLIENT_APP=file-client\n')
  assert.deepEqual(await daemon.turn(), {
    DB_PASSWORD: 'local=p@ss$(literal)#text',
    ENV: 'dev',
    UNCONFIGURED_SECRET: null,
    LANG: 'fixture-lang',
    CLAUDE_AGENT_SDK_CLIENT_APP: 'codex-harness',
  })
})

test('uses the same unique prompt UUID for live events and SDK history, including repeated input', async (t) => {
  const daemon = await fixture(t)
  await daemon.turn()
  await daemon.turn()
  const events = daemon.messages.filter((message) => message.method === 'message/user')
  const history = await daemon.request('session/history', { providerSessionId: 'fixture-session' })
  assert.equal(events.length, 2)
  assert.equal(history.messages.length, 2)
  assert.deepEqual(history.messages.map((message) => message.uuid), events.map((event) => event.params.providerMessageId))
  assert.notEqual(history.messages[0].uuid, history.messages[1].uuid)
  assert.match(history.messages[0].uuid, /^[0-9a-f-]{36}$/)
})

test('lists the SDK command surface without submitting a model prompt', async (t) => {
  const daemon = await fixture(t)
  const result = await daemon.request('provider/skills', { cwd: '/fixture' })
  assert.equal(result.complete, false)
  assert.deepEqual(result.data, [{ name: 'fixture-skill', description: 'Fixture skill', argumentHint: 'file' }])
})

test('reloads edits, empty values, and removals without restarting the daemon', async (t) => {
  const daemon = await fixture(t)
  await writeFile(daemon.secrets, 'DB_PASSWORD=first\nENV=dev')
  assert.equal((await daemon.turn()).DB_PASSWORD, 'first')
  await writeFile(daemon.secrets, 'DB_PASSWORD=second')
  assert.equal((await daemon.turn()).DB_PASSWORD, 'second')
  assert.equal((await daemon.turn()).ENV, null)
  await writeFile(daemon.secrets, 'DB_PASSWORD=')
  assert.equal((await daemon.turn()).DB_PASSWORD, '')
  await rm(daemon.secrets)
  assert.equal((await daemon.turn()).DB_PASSWORD, null)
})

test('works without a secrets file and keeps unconfigured inherited values filtered', async (t) => {
  const daemon = await fixture(t)
  const environment = await daemon.turn()
  assert.equal(environment.DB_PASSWORD, null)
  assert.equal(environment.UNCONFIGURED_SECRET, null)
})

test('also injects file values for model discovery and context queries', async (t) => {
  const daemon = await fixture(t)
  await writeFile(daemon.secrets, 'DB_PASSWORD=models-value')
  assert.equal((await daemon.models()).DB_PASSWORD, 'models-value')
  await writeFile(daemon.secrets, 'DB_PASSWORD=context-value')
  const context = await daemon.request('session/context', { sessionId: 'session', providerSessionId: 'fixture-session' })
  assert.equal(JSON.parse(context.model).DB_PASSWORD, 'context-value')
})

test('reports unreadable configuration instead of silently dropping configured values', async (t) => {
  const daemon = await fixture(t)
  await mkdir(daemon.secrets)
  await assert.rejects(daemon.turn(), /无法读取 ~\/.codex-harness\/secrets/)
})

// Results deliberately do not end the output stream. This models a live SDK
// session and catches the old assumption that result and iterator EOF coincide.
const liveSdkFixture = `
import { existsSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'
let queries = 0
export async function getSessionMessages() { return [] }
export function query({ prompt, options }) {
  const queryId = ++queries
  let stopped = false
  let interrupted = false
  const output = []
  let wake
  const push = value => { output.push(value); wake?.(); wake = undefined }
  options.abortController.signal.addEventListener('abort', () => { stopped = true; wake?.() })
  return {
    async *[Symbol.asyncIterator]() {
      void (async () => {
        try {
          for await (const message of prompt) {
            if (stopped) break
            const text = message.message.content
            push({ type: 'system', subtype: 'session_state_changed', state: 'running' })
            if (text === 'crash') { stopped = true; wake?.(); break }
            if (text === 'approval') await options.canUseTool('Bash', { command: 'fixture' }, { signal: options.abortController.signal })
            if (text === 'wait') {
              while (!interrupted && !stopped) await setTimeout(5)
            }
            if (text === 'background') push({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'task' }] })
            if (text !== 'wait') push({ type: 'result', subtype: text === 'error' ? 'error_during_execution' : 'success', errors: ['fixture error'], user_message_uuid: message.uuid,
              result: JSON.stringify({ queryId }), total_cost_usd: queryId === 1 ? 2 : 1 })
            if (text === 'hold-idle') {
              while (!existsSync(options.cwd + '/release-idle') && !stopped) await setTimeout(5)
            }
            push({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
            // A late duplicate result must never finish the next user turn.
            if (text === 'late-result') {
              await setTimeout(80)
              if (text === 'background') push({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'task' }] })
            if (text !== 'wait') push({ type: 'result', subtype: text === 'error' ? 'error_during_execution' : 'success', errors: ['fixture error'], user_message_uuid: message.uuid, result: 'old' })
              push({ type: 'result', subtype: 'success', result: 'synthetic old result' })
              push({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
            }
            interrupted = false
          }
        } catch { stopped = true; wake?.() }
      })()
      while (!stopped) {
        if (output.length) yield output.shift()
        else await new Promise(resolve => { wake = resolve })
      }
    },
    async interrupt() { interrupted = true },
    async initializationResult() { return {} },
    async getContextUsage() { return { totalTokens: 17, maxTokens: 100, model: 'fixture' } },
    close() { stopped = true; wake?.() },
  }
}
`

async function startLiveTurn(daemon, turnId, text = 'normal', extra = {}) {
  return daemon.request('turn/start', {
    sessionId: 'session', turnId, cwd: daemon.home,
    input: [{ type: 'text', text }], ...extra,
  })
}

async function terminalEvent(daemon, turnId) {
  return waitFor(() => daemon.messages.find(message => message.params?.turnId === turnId
    && ['turn/completed', 'turn/failed', 'turn/interrupted'].includes(message.method)))
}

test('waits for SDK idle, then accepts the next turn on the same live query', async t => {
  const daemon = await fixture(t, liveSdkFixture)
  await startLiveTurn(daemon, 'first', 'hold-idle')
  await waitFor(async () => (await daemon.request('session/status', { sessionId: 'session' })).lastResult)
  assert.equal(daemon.messages.some(message => message.method === 'turn/completed'), false)
  assert.equal((await daemon.request('session/status', { sessionId: 'session' })).active, true)
  await writeFile(join(daemon.home, 'release-idle'), '')
  assert.equal((await terminalEvent(daemon, 'first')).method, 'turn/completed')
  assert.deepEqual((await daemon.request('runtime/status')).activeTurns, [])
  await startLiveTurn(daemon, 'second')
  const second = await terminalEvent(daemon, 'second')
  assert.equal(second.method, 'turn/completed')
  assert.equal(JSON.parse(second.params.result).queryId, 1)
  assert.equal(second.params.totalCostUsd, 2, 'SDK query cost is cumulative, not additive per result')
})

test('interrupts an active turn without making the live query unusable', async t => {
  const daemon = await fixture(t, liveSdkFixture)
  await startLiveTurn(daemon, 'first', 'wait')
  await daemon.request('turn/interrupt', { sessionId: 'session' })
  assert.equal((await terminalEvent(daemon, 'first')).method, 'turn/interrupted')
  await startLiveTurn(daemon, 'second')
  assert.equal((await terminalEvent(daemon, 'second')).method, 'turn/completed')
})

test('stream exit without a result fails the active turn and allows a fresh query', async t => {
  const daemon = await fixture(t, liveSdkFixture)
  await startLiveTurn(daemon, 'first', 'crash')
  assert.equal((await terminalEvent(daemon, 'first')).method, 'turn/failed')
  assert.deepEqual((await daemon.request('runtime/status')).activeTurns, [])
  await startLiveTurn(daemon, 'second')
  assert.equal(JSON.parse((await terminalEvent(daemon, 'second')).params.result).queryId, 2)
})

test('a late result for an older input cannot complete the next active turn', async t => {
  const daemon = await fixture(t, liveSdkFixture)
  await startLiveTurn(daemon, 'first', 'late-result')
  await terminalEvent(daemon, 'first')
  await startLiveTurn(daemon, 'second', 'hold-idle')
  await setTimeout(150)
  assert.equal(daemon.messages.filter(message => message.method === 'turn/completed').length, 1)
  assert.equal((await daemon.request('session/status', { sessionId: 'session' })).turnId, 'second')
  await writeFile(join(daemon.home, 'release-idle'), '')
  await terminalEvent(daemon, 'second')
})


test('rotates an idle query after model changes and keeps SDK cumulative costs correct', async t => {
  const daemon = await fixture(t, liveSdkFixture)
  await startLiveTurn(daemon, 'first', 'normal', { model: 'one' })
  await terminalEvent(daemon, 'first')
  await startLiveTurn(daemon, 'second', 'normal', { model: 'two' })
  const second = await terminalEvent(daemon, 'second')
  assert.equal(JSON.parse(second.params.result).queryId, 2)
  assert.equal(second.params.totalCostUsd, 3)
})

test('preserves background work and refuses configuration changes until it finishes', async t => {
  const daemon = await fixture(t, liveSdkFixture)
  await startLiveTurn(daemon, 'first', 'background', { model: 'one' })
  await terminalEvent(daemon, 'first')
  await assert.rejects(startLiveTurn(daemon, 'rejected', 'normal', { model: 'two' }), /后台任务仍在运行/)
  assert.deepEqual((await daemon.request('runtime/status')).activeTurns, [])
  await startLiveTurn(daemon, 'second', 'normal', { model: 'one' })
  assert.equal(JSON.parse((await terminalEvent(daemon, 'second')).params.result).queryId, 1)
})

test('an SDK error result ends once at idle and the next turn can still run', async t => {
  const daemon = await fixture(t, liveSdkFixture)
  await startLiveTurn(daemon, 'first', 'error')
  const failed = await terminalEvent(daemon, 'first')
  assert.equal(failed.method, 'turn/failed')
  assert.equal(failed.params.message, 'fixture error')
  await startLiveTurn(daemon, 'second')
  await terminalEvent(daemon, 'second')
  assert.equal(daemon.messages.filter(message => message.params?.turnId === 'first'
    && ['turn/completed', 'turn/failed', 'turn/interrupted'].includes(message.method)).length, 1)
})


test('approvals on a reused query belong to the current turn', async t => {
  const daemon = await fixture(t, liveSdkFixture)
  for (const turnId of ['first', 'second']) {
    await startLiveTurn(daemon, turnId, 'approval')
    const approval = await waitFor(() => daemon.messages.find(message => message.method === 'approval/requested'
      && message.params.turnId === turnId))
    assert.equal((await daemon.request('runtime/status')).pendingApprovals.length, 1)
    await daemon.request('approval/respond', { requestId: approval.params.requestId, allow: true })
    assert.equal((await terminalEvent(daemon, turnId)).method, 'turn/completed')
    assert.deepEqual((await daemon.request('runtime/status')).pendingApprovals, [])
  }
})

// Exercise the actual pinned SDK transport against a fake CLI executable. No
// real Claude executable, model endpoint, credentials or user state are used.
test('official SDK keeps one CLI process across completed turns and supports interruption', async t => {
  const sdkSource = `export * from ${JSON.stringify(import.meta.resolve('@anthropic-ai/claude-agent-sdk'))}`
  const cliSource = String.raw`#!/usr/bin/env node
import { createInterface } from 'node:readline'
const send = message => process.stdout.write(JSON.stringify(message) + '\n')
const idle = () => send({ type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: 'fixture-session' })
const lines = createInterface({ input: process.stdin })
lines.on('close', () => process.exit(0))
lines.on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id,
      response: { models: [], commands: [], account: {} } } })
    if (message.request.subtype === 'interrupt') idle()
  } else if (message.type === 'user') {
    send({ type: 'system', subtype: 'session_state_changed', state: 'running', session_id: 'fixture-session' })
    if (message.message.content === 'wait') return
    send({ type: 'result', subtype: 'success', session_id: 'fixture-session', user_message_uuid: message.uuid,
      result: JSON.stringify({ pid: process.pid }), usage: {}, modelUsage: {}, total_cost_usd: 1 })
    idle()
  }
})
`
  const daemon = await fixture(t, sdkSource, cliSource)
  await startLiveTurn(daemon, 'first')
  const first = await terminalEvent(daemon, 'first')
  assert.equal(first.method, 'turn/completed', first.params.message)
  await startLiveTurn(daemon, 'second')
  const second = await terminalEvent(daemon, 'second')
  assert.equal(second.method, 'turn/completed', second.params.message)
  assert.equal(JSON.parse(first.params.result).pid, JSON.parse(second.params.result).pid)
  await startLiveTurn(daemon, 'third', 'wait')
  await daemon.request('turn/interrupt', { sessionId: 'session' })
  assert.equal((await terminalEvent(daemon, 'third')).method, 'turn/interrupted')
  await startLiveTurn(daemon, 'fourth')
  const fourth = await terminalEvent(daemon, 'fourth')
  assert.equal(fourth.method, 'turn/completed', fourth.params.message)
  assert.equal(JSON.parse(fourth.params.result).pid, JSON.parse(first.params.result).pid)
})


test('rejects a concurrent start without enqueueing a second input', async t => {
  const daemon = await fixture(t, liveSdkFixture)
  const starts = await Promise.allSettled([
    startLiveTurn(daemon, 'first', 'hold-idle'),
    startLiveTurn(daemon, 'rejected'),
  ])
  assert.equal(starts[0].status, 'fulfilled')
  assert.equal(starts[1].status, 'rejected')
  assert.match(starts[1].reason.message, /已有运行中的 turn/)
  assert.equal(daemon.messages.filter(message => message.method === 'message/user').length, 1)
  await writeFile(join(daemon.home, 'release-idle'), '')
  await terminalEvent(daemon, 'first')
})

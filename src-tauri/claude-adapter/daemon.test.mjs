import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { setTimeout } from 'node:timers/promises'

// The copied daemon falls back to this SDK fixture, never the real SDK or a model.
const sdkFixture = `
import { execFileSync } from 'node:child_process'
export function query({ options }) {
  const snapshot = execFileSync(process.execPath, ['-e',
    'console.log(JSON.stringify(Object.fromEntries(["DB_PASSWORD", "ENV", "UNCONFIGURED_SECRET", "LANG", "CLAUDE_AGENT_SDK_CLIENT_APP"].map(key => [key, process.env[key] ?? null]))))'
  ], { env: options.env, encoding: 'utf8' }).trim()
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'result', subtype: 'success', session_id: 'fixture-session', result: snapshot }
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

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'claude-env-'))
  const secrets = join(home, '.codex-harness', 'secrets')
  const socketPath = join(home, 'daemon.sock')
  await mkdir(join(home, '.codex-harness'))
  await copyFile(new URL('./daemon.mjs', import.meta.url), join(home, 'daemon.mjs'))
  await writeFile(join(home, 'sdk.mjs'), sdkFixture)
  const child = spawn(process.execPath, [join(home, 'daemon.mjs')], {
    env: {
      HOME: home,
      PATH: process.env.PATH,
      LANG: 'fixture-lang',
      DB_PASSWORD: 'discard-this-inherited-value',
      UNCONFIGURED_SECRET: 'discard-this-too',
      CODEX_HARNESS_CLAUDE_SOCKET: socketPath,
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
    assert.equal(response.error, undefined)
    return response.result
  }
  return {
    secrets,
    request,
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

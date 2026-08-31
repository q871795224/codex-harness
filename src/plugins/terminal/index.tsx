import { useEffect, useMemo, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XtermTerminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { ExternalLink, RotateCcw, SquareTerminal } from 'lucide-react'
import type { TerminalEvent, TerminalService } from '../../core/terminal/types'
import type { ConversationTabProps, HarnessPlugin, PluginInstanceRecord } from '../../extensions/types'

const MAX_OUTPUT_CHARS = 2_000_000
const TERMINAL_STARTUP_OUTPUT_GRACE_MS = 3_000
const TERMINAL_SLOW_CREATE_MS = 5_000

export type SessionStatus = 'starting' | 'running' | 'exited' | 'failed'

interface ManagedTerminalSession {
  key: string
  cwd: string
  id: string | null
  shell: string
  output: string
  status: SessionStatus
  error: string | null
  requestedAt: number
  runningAt: number | null
  receivedOutput: boolean
  pendingInput: string
  listeners: Set<(data: string) => void>
}

export class TerminalController {
  private readonly sessions = new Map<string, ManagedTerminalSession>()
  private readonly pendingEvents = new Map<string, TerminalEvent[]>()
  private readonly ignoredSessionIds = new Set<string>()

  constructor(private readonly service: TerminalService) {}

  get(key: string, cwd: string): ManagedTerminalSession {
    const current = this.sessions.get(key)
    if (current) return current
    const session: ManagedTerminalSession = {
      key,
      cwd,
      id: null,
      shell: '',
      output: '',
      status: 'starting',
      error: null,
      requestedAt: Date.now(),
      runningAt: null,
      receivedOutput: false,
      pendingInput: '',
      listeners: new Set(),
    }
    this.sessions.set(key, session)
    void this.start(session)
    return session
  }

  handleEvent(event: TerminalEvent): void {
    if (this.ignoredSessionIds.has(event.sessionId)) {
      if (event.type === 'exit') this.ignoredSessionIds.delete(event.sessionId)
      return
    }
    const session = [...this.sessions.values()].find((candidate) => candidate.id === event.sessionId)
    if (!session) {
      const pending = this.pendingEvents.get(event.sessionId) ?? []
      pending.push(event)
      this.pendingEvents.set(event.sessionId, pending.slice(-100))
      return
    }
    if (event.type === 'output') {
      if (!session.receivedOutput) {
        session.receivedOutput = true
        console.info('[terminal] first output', {
          sessionId: event.sessionId,
          bytes: event.data.length,
          elapsedMs: Date.now() - session.requestedAt,
        })
      }
      session.output = appendTerminalOutput(session.output, event.data)
      this.notify(session, event.data)
      return
    }
    console.info('[terminal] exited', { sessionId: event.sessionId, elapsedMs: Date.now() - session.requestedAt })
    session.status = 'exited'
    session.id = null
    this.notify(session, '')
  }

  subscribe(session: ManagedTerminalSession, listener: (data: string) => void): () => void {
    session.listeners.add(listener)
    return () => session.listeners.delete(listener)
  }

  async write(session: ManagedTerminalSession, data: string): Promise<void> {
    if (!session.id) {
      if (session.status === 'starting') session.pendingInput += data
      return
    }
    try {
      await this.service.write(session.id, data)
    } catch (error) {
      this.fail(session, error)
    }
  }

  async resize(session: ManagedTerminalSession, cols: number, rows: number): Promise<void> {
    if (!session.id) return
    try {
      await this.service.resize(session.id, cols, rows)
    } catch (error) {
      if (session.status !== 'exited') this.fail(session, error)
    }
  }

  async restart(key: string, cwd: string): Promise<ManagedTerminalSession> {
    const current = this.sessions.get(key)
    this.sessions.delete(key)
    if (current?.id) {
      this.ignoredSessionIds.add(current.id)
      await this.service.close(current.id).catch(() => undefined)
    }
    return this.get(key, cwd)
  }

  async dispose(): Promise<void> {
    const ids = [...this.sessions.values()].flatMap((session) => session.id ? [session.id] : [])
    this.sessions.clear()
    this.pendingEvents.clear()
    this.ignoredSessionIds.clear()
    await Promise.all(ids.map((id) => this.service.close(id).catch(() => undefined)))
  }

  private async start(session: ManagedTerminalSession): Promise<void> {
    console.info('[terminal] create requested', { key: session.key, cwd: session.cwd })
    const slowCreateTimer = globalThis.setTimeout(() => {
      console.warn('[terminal] create is taking longer than expected', {
        key: session.key,
        cwd: session.cwd,
        elapsedMs: Date.now() - session.requestedAt,
      })
    }, TERMINAL_SLOW_CREATE_MS)
    try {
      const created = await this.service.create(session.cwd, 100, 30)
      session.id = created.sessionId
      session.shell = created.shell
      session.status = 'running'
      session.runningAt = Date.now()
      console.info('[terminal] created', {
        sessionId: created.sessionId,
        shell: created.shell,
        elapsedMs: session.runningAt - session.requestedAt,
      })
      this.notify(session, '')
      if (session.pendingInput) {
        const pendingInput = session.pendingInput
        session.pendingInput = ''
        await this.service.write(created.sessionId, pendingInput)
      }
      const pending = this.pendingEvents.get(created.sessionId) ?? []
      this.pendingEvents.delete(created.sessionId)
      for (const event of pending) this.handleEvent(event)
    } catch (error) {
      this.fail(session, error)
    } finally {
      globalThis.clearTimeout(slowCreateTimer)
    }
  }

  private fail(session: ManagedTerminalSession, error: unknown): void {
    session.status = 'failed'
    session.error = messageOf(error)
    console.error('[terminal] failed', { key: session.key, error: session.error, elapsedMs: Date.now() - session.requestedAt })
    this.notify(session, '')
  }

  private notify(session: ManagedTerminalSession, data: string): void {
    for (const listener of session.listeners) listener(data)
  }
}

export const terminalPlugin: HarnessPlugin = {
  manifest: {
    schemaVersion: 1,
    id: 'builtin.terminal',
    name: '终端',
    description: '在当前工作目录中运行本机 login shell。',
    version: '1.0.2',
    engine: { codexHarness: '^0.1.0' },
    supportedScopes: ['global'],
    permissions: ['process:terminal'],
  },
  async activate(ctx) {
    const service = ctx.services.get<TerminalService>('harness.terminal')
    const controller = new TerminalController(service)
    const unlisten = await service.onEvent((event) => controller.handleEvent(event))
    ctx.effect(unlisten)
    ctx.effect(() => controller.dispose())
    ctx.slots.conversationTabs.register({
      id: 'terminal',
      label: '终端',
      order: 40,
      icon: SquareTerminal,
      render: (props) => <TerminalTab controller={controller} service={service} context={props} />,
    })
  },
}

export const terminalDefaultInstance: PluginInstanceRecord = {
  instanceId: 'builtin.terminal:default',
  pluginId: terminalPlugin.manifest.id,
  scope: { kind: 'global' },
  enabled: true,
  config: {},
  createdAt: 0,
  updatedAt: 0,
}

export function appendTerminalOutput(current: string, data: string, limit = MAX_OUTPUT_CHARS): string {
  return `${current}${data}`.slice(-limit)
}

export function hasVisibleTerminalOutput(output: string): boolean {
  return output
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)?)/g, '')
    .replace(/[\x00-\x20\x7f]/g, '')
    .length > 0
}

export function shouldShowTerminalStartup(status: SessionStatus, output: string, error: string | null, runningForMs: number): boolean {
  if (error || status === 'failed' || status === 'exited' || hasVisibleTerminalOutput(output)) return false
  return status === 'starting' || runningForMs < TERMINAL_STARTUP_OUTPUT_GRACE_MS
}

function TerminalTab({ controller, service, context }: {
  controller: TerminalController
  service: TerminalService
  context: ConversationTabProps
}) {
  const cwd = context.threadCwd ?? context.workspaceRoot
  const sessionKey = context.threadId ?? (cwd ? `workspace:${cwd}` : null)
  const [generation, setGeneration] = useState(0)
  const [, setRevision] = useState(0)
  const session = useMemo(() => cwd && sessionKey ? controller.get(sessionKey, cwd) : null, [controller, cwd, generation, sessionKey])

  useEffect(() => session
    ? controller.subscribe(session, () => setRevision((current) => current + 1))
    : undefined, [controller, session])

  if (!cwd || !sessionKey || !session) {
    return (
      <div className="terminal-unavailable">
        <SquareTerminal size={26} />
        <strong>选择一个带工作目录的会话</strong>
        <span>终端会在当前会话的目录中启动。</span>
      </div>
    )
  }

  const restart = async () => {
    await controller.restart(sessionKey, cwd)
    setGeneration((current) => current + 1)
  }

  return (
    <section className="terminal-shell">
      <header className="terminal-toolbar">
        <div className="terminal-location">
          <span className={`terminal-status ${session.status}`} />
          <strong>{shortPath(cwd)}</strong>
          <code>{cwd}</code>
        </div>
        <div className="terminal-actions">
          <span>{session.shell ? `${shortPath(session.shell)} · login shell` : 'starting shell…'}</span>
          <button type="button" onClick={() => void service.openIterm(cwd)} title="在 iTerm2 中打开当前目录"><ExternalLink size={13} />iTerm2</button>
          <button type="button" onClick={() => void restart()} title="重新启动终端"><RotateCcw size={13} />重启</button>
        </div>
      </header>
      {session.error && <div className="terminal-error">{session.error}</div>}
      <TerminalCanvas key={`${cwd}:${generation}`} controller={controller} session={session} />
    </section>
  )
}

function TerminalCanvas({ controller, session }: {
  controller: TerminalController
  session: ManagedTerminalSession
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [, setStartupClock] = useState(0)

  useEffect(() => {
    if (session.error || hasVisibleTerminalOutput(session.output)) return undefined
    const deadline = session.status === 'starting'
      ? session.requestedAt + TERMINAL_SLOW_CREATE_MS
      : session.status === 'running' && session.runningAt
        ? session.runningAt + TERMINAL_STARTUP_OUTPUT_GRACE_MS
        : null
    if (!deadline) return undefined
    const remaining = deadline - Date.now()
    if (remaining <= 0) return undefined
    const timer = window.setTimeout(() => setStartupClock((current) => current + 1), remaining)
    return () => window.clearTimeout(timer)
  }, [session.error, session.output, session.requestedAt, session.runningAt, session.status])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined
    const terminal = new XtermTerminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 12,
      lineHeight: 1.28,
      scrollback: 10_000,
      theme: {
        background: '#111417',
        foreground: '#cdd3d7',
        cursor: '#7fc7a4',
        cursorAccent: '#111417',
        selectionBackground: '#355247',
        black: '#23282d',
        red: '#e06c75',
        green: '#8bc49b',
        yellow: '#d8b66f',
        blue: '#7fa7d8',
        magenta: '#bd95c8',
        cyan: '#77bfc0',
        white: '#d6dadd',
        brightBlack: '#626a71',
      },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(container)
    terminal.write(session.output)
    const removeListener = controller.subscribe(session, (data) => {
      if (data) terminal.write(data)
      else fitTerminal(fit, terminal, controller, session)
    })
    const input = terminal.onData((data) => void controller.write(session, data))
    const observer = new ResizeObserver(() => fitTerminal(fit, terminal, controller, session))
    observer.observe(container)
    const focus = () => terminal.focus()
    container.addEventListener('pointerdown', focus, true)
    requestAnimationFrame(() => {
      fitTerminal(fit, terminal, controller, session)
      terminal.focus()
    })
    return () => {
      observer.disconnect()
      container.removeEventListener('pointerdown', focus, true)
      input.dispose()
      removeListener()
      terminal.dispose()
    }
  }, [controller, session])

  const runningForMs = session.runningAt ? Date.now() - session.runningAt : 0
  const showStartup = shouldShowTerminalStartup(session.status, session.output, session.error, runningForMs)
  const slowCreate = session.status === 'starting' && Date.now() - session.requestedAt >= TERMINAL_SLOW_CREATE_MS

  return (
    <div className="terminal-canvas" aria-label="终端输入区域">
      <div ref={containerRef} className="terminal-surface" />
      {showStartup && (
        <div className="terminal-starting" aria-live="polite">
          <span>{slowCreate ? '终端创建时间较长，请尝试重启' : session.status === 'starting' ? '正在创建终端…' : `正在启动 ${shortPath(session.shell)}…`}</span>
          <code>{session.cwd}</code>
        </div>
      )}
    </div>
  )
}

function fitTerminal(
  fit: FitAddon,
  terminal: XtermTerminal,
  controller: TerminalController,
  session: ManagedTerminalSession,
): void {
  try {
    fit.fit()
    void controller.resize(session, terminal.cols, terminal.rows)
  } catch {
    // The container can briefly have no dimensions while tabs are switching.
  }
}

function shortPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

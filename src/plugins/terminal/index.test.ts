import { describe, expect, it } from 'vitest'
import type { TerminalService, TerminalSessionInfo } from '../../core/terminal/types'
import { appendTerminalOutput, hasVisibleTerminalOutput, shouldShowTerminalStartup, TerminalController, terminalPlugin } from './index'

describe('terminal plugin', () => {
  it('registers as a native-process plugin', () => {
    expect(terminalPlugin.manifest.id).toBe('builtin.terminal')
    expect(terminalPlugin.manifest.permissions).toContain('process:terminal')
  })

  it('keeps only the configured terminal scrollback text', () => {
    expect(appendTerminalOutput('abc', 'def', 4)).toBe('cdef')
  })

  it('keeps startup feedback visible for control-only shell output', () => {
    expect(hasVisibleTerminalOutput('\u001b[?2004h\r\n')).toBe(false)
    expect(hasVisibleTerminalOutput('\u001b[32m❯\u001b[0m ')).toBe(true)
    expect(shouldShowTerminalStartup('starting', '', null)).toBe(true)
    expect(shouldShowTerminalStartup('starting', '\u001b[?2004h\r\n', null)).toBe(true)
    expect(shouldShowTerminalStartup('running', '\u001b[?2004h\r\n', null)).toBe(false)
    expect(shouldShowTerminalStartup('running', 'prompt', null)).toBe(false)
  })

  it('replays output that arrives before the create response', async () => {
    let resolveCreate!: (value: TerminalSessionInfo) => void
    const create = new Promise<TerminalSessionInfo>((resolve) => { resolveCreate = resolve })
    const service: TerminalService = {
      create: () => create,
      write: async () => undefined,
      resize: async () => undefined,
      close: async () => undefined,
      openIterm: async () => undefined,
      onEvent: async () => () => undefined,
      recordDiagnostic: async () => undefined,
    }
    const controller = new TerminalController(service)
    const session = controller.get('thread-1', '/tmp')
    controller.handleEvent({ type: 'output', sessionId: 'session-1', data: 'prompt' })
    resolveCreate({ sessionId: 'session-1', shell: '/bin/zsh' })
    await create
    await Promise.resolve()
    expect(session.output).toBe('prompt')
  })

  it('drops input typed while the native session is starting', async () => {
    let resolveCreate!: (value: TerminalSessionInfo) => void
    const writes: string[] = []
    const create = new Promise<TerminalSessionInfo>((resolve) => { resolveCreate = resolve })
    const service: TerminalService = {
      create: () => create,
      write: async (_sessionId, data) => { writes.push(data) },
      resize: async () => undefined,
      close: async () => undefined,
      openIterm: async () => undefined,
      onEvent: async () => () => undefined,
      recordDiagnostic: async () => undefined,
    }
    const controller = new TerminalController(service)
    const session = controller.get('thread-1', '/tmp')
    await controller.write(session, 'pwd\r')
    resolveCreate({ sessionId: 'session-1', shell: '/bin/zsh' })
    await create
    await Promise.resolve()
    await Promise.resolve()
    expect(writes).toEqual([])
    expect(session.status).toBe('starting')

    controller.handleEvent({ type: 'output', sessionId: 'session-1', data: 'project % ' })
    expect(session.status).toBe('running')
    await controller.write(session, 'pwd\r')
    expect(writes).toEqual(['pwd\r'])
  })
})

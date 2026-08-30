import { describe, expect, it } from 'vitest'
import type { TerminalService, TerminalSessionInfo } from '../../core/terminal/types'
import { appendTerminalOutput, TerminalController, terminalPlugin } from './index'

describe('terminal plugin', () => {
  it('registers as a native-process plugin', () => {
    expect(terminalPlugin.manifest.id).toBe('builtin.terminal')
    expect(terminalPlugin.manifest.permissions).toContain('process:terminal')
  })

  it('keeps only the configured terminal scrollback text', () => {
    expect(appendTerminalOutput('abc', 'def', 4)).toBe('cdef')
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
    }
    const controller = new TerminalController(service)
    const session = controller.get('thread-1', '/tmp')
    controller.handleEvent({ type: 'output', sessionId: 'session-1', data: 'prompt' })
    resolveCreate({ sessionId: 'session-1', shell: '/bin/zsh' })
    await create
    await Promise.resolve()
    expect(session.output).toBe('prompt')
  })
})

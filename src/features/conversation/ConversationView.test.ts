import { describe, expect, it } from 'vitest'
import type { Thread, Turn } from '../../core/domain/codex'
import { CHOOSE_WORKSPACE_VALUE, isChooseWorkspaceSelection, isExternalWebUrl, titleEditorKeyAction } from './ConversationView'
import { resolveNewThreadWorkspaceRoot, shouldDiscardDraftThread, threadTitlePrompt, threadTurnContext } from './useHarness'

function makeThread(cwd: string): Thread {
  return {
    id: 'thread-1', preview: '', cwd, name: null, createdAt: 1, updatedAt: 1, recencyAt: 1,
    status: { type: 'idle' }, ephemeral: false, canAcceptDirectInput: true,
  }
}

describe('titleEditorKeyAction', () => {
  it('does not finish editing while an IME composition is active', () => {
    expect(titleEditorKeyAction('Enter', true)).toBeNull()
    expect(titleEditorKeyAction('Escape', true)).toBeNull()
  })

  it('supports the legacy IME keyCode fallback', () => {
    expect(titleEditorKeyAction('Enter', false, 229)).toBeNull()
  })

  it('saves or cancels outside IME composition', () => {
    expect(titleEditorKeyAction('Enter', false)).toBe('save')
    expect(titleEditorKeyAction('Escape', false)).toBe('cancel')
  })
})

describe('markdown links', () => {
  it('only delegates web URLs to the system browser', () => {
    expect(isExternalWebUrl('https://openai.com/docs')).toBe(true)
    expect(isExternalWebUrl('http://localhost:1420')).toBe(true)
    expect(isExternalWebUrl('/workspace/readme.md')).toBe(false)
    expect(isExternalWebUrl('javascript:alert(1)')).toBe(false)
  })
})

describe('new thread workspace', () => {
  it('routes only the directory option to the native picker', () => {
    expect(isChooseWorkspaceSelection(CHOOSE_WORKSPACE_VALUE)).toBe(true)
    expect(isChooseWorkspaceSelection('/repo/current')).toBe(false)
  })

  it('inherits the workspace of the open thread', () => {
    expect(resolveNewThreadWorkspaceRoot('thread-1', [makeThread('/repo/current')], '/repo/sidebar')).toBe('/repo/current')
  })

  it('falls back to the selected workspace without an open thread mapping', () => {
    expect(resolveNewThreadWorkspaceRoot('missing', [makeThread('/repo/current')], '/repo/sidebar')).toBe('/repo/sidebar')
    expect(resolveNewThreadWorkspaceRoot(null, [], '/repo/sidebar')).toBe('/repo/sidebar')
  })
})

describe('thread runtime workspace', () => {
  it('sends the checkout as both cwd and the runtime writable root', () => {
    const thread = makeThread('/repo/worktree')
    const context = threadTurnContext({
      thread,
      turns: [],
      items: [],
      nextTurnsCursor: null,
      activeTurnId: null,
      foreignActive: false,
      runtimeWorkspaceRoots: ['/repo/old'],
      sandbox: {
        type: 'workspaceWrite', writableRoots: ['/repo/old'], networkAccess: false,
        excludeTmpdirEnvVar: false, excludeSlashTmp: false,
      },
      activePermissionProfile: null,
      model: null,
    }, thread.cwd)
    expect(context).toMatchObject({
      cwd: '/repo/worktree',
      runtimeWorkspaceRoots: ['/repo/worktree'],
      sandboxPolicy: { type: 'workspaceWrite' },
    })
    expect((context.sandboxPolicy as { writableRoots: string[] }).writableRoots[0]).toBe('/repo/worktree')
  })
})

describe('generated thread title prompt', () => {
  it('includes the completed user and assistant exchange', () => {
    const turn: Turn = {
      id: 'turn-1', status: 'completed', error: null, startedAt: 1, completedAt: 2, durationMs: 1,
      items: [
        { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: '修复 workspace', text_elements: [] }] },
        { id: 'assistant-1', type: 'agentMessage', text: '已经定位问题。' },
      ],
    }
    expect(threadTitlePrompt(turn)).toContain('User: 修复 workspace')
    expect(threadTitlePrompt(turn)).toContain('Assistant: 已经定位问题。')
  })
})

describe('new thread draft lifecycle', () => {
  it('keeps an unstarted thread when its composer has content', () => {
    expect(shouldDiscardDraftThread(true, true)).toBe(false)
  })

  it('discards only an unstarted thread with an empty composer', () => {
    expect(shouldDiscardDraftThread(true, false)).toBe(true)
    expect(shouldDiscardDraftThread(false, false)).toBe(false)
  })
})

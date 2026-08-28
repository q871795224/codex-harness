import { describe, expect, it } from 'vitest'
import type { Thread, ThreadDetail } from '../../core/domain/codex'
import { textInput } from '../../core/domain/codex'
import { CHOOSE_WORKSPACE_VALUE, isChooseWorkspaceSelection, isExternalWebUrl, isNearConversationBottom, titleEditorKeyAction } from './ConversationView'
import { isFirstUserTurn, parseThreadTitleGenerationSettings, resolveNewThreadWorkspaceRoot, shouldDiscardDraftThread, threadTitlePrompt, threadTurnContext } from './useHarness'

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

describe('conversation scrolling', () => {
  it('keeps following content only while the viewport is near the bottom', () => {
    expect(isNearConversationBottom({ scrollTop: 452, clientHeight: 500, scrollHeight: 1_000 })).toBe(true)
    expect(isNearConversationBottom({ scrollTop: 400, clientHeight: 500, scrollHeight: 1_000 })).toBe(false)
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
  it('uses only the first user input', () => {
    const prompt = threadTitlePrompt('  修复 workspace\n权限问题  ')
    expect(prompt).toContain('User: 修复 workspace\n权限问题')
    expect(prompt).not.toContain('Assistant:')
    expect(threadTitlePrompt('   ')).toBeNull()
  })
})

describe('thread title trigger', () => {
  it('only treats a detail without user messages as a new conversation', () => {
    const detail = {
      thread: makeThread('/repo/current'),
      turns: [],
      items: [],
      nextTurnsCursor: null,
      activeTurnId: null,
      foreignActive: false,
      runtimeWorkspaceRoots: ['/repo/current'],
      sandbox: null,
      activePermissionProfile: null,
      model: null,
    } satisfies ThreadDetail
    expect(isFirstUserTurn(detail)).toBe(true)
    expect(isFirstUserTurn({
      ...detail,
      items: [{ turnId: 'turn-1', item: { type: 'userMessage', content: [textInput('已有消息')] } }],
    })).toBe(false)
  })
})

describe('thread title generation settings', () => {
  it('defaults to Luna low and preserves valid custom settings', () => {
    expect(parseThreadTitleGenerationSettings(null)).toMatchObject({ model: 'gpt-5.6-luna', effort: 'low' })
    expect(parseThreadTitleGenerationSettings(JSON.stringify({ model: 'custom', effort: 'high', prompt: 'Only a title' }))).toEqual({
      model: 'custom', effort: 'high', prompt: 'Only a title',
    })
  })

  it('falls back for empty or invalid values', () => {
    expect(parseThreadTitleGenerationSettings('{broken')).toMatchObject({ model: 'gpt-5.6-luna', effort: 'low' })
    expect(parseThreadTitleGenerationSettings(JSON.stringify({ model: '', effort: '', prompt: '' }))).toMatchObject({
      model: 'gpt-5.6-luna', effort: 'low',
    })
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

import { describe, expect, it } from 'vitest'
import type { Thread, ThreadDetail } from '../../core/domain/codex'
import { textInput } from '../../core/domain/codex'
import { activityStatusLabel, CHOOSE_WORKSPACE_VALUE, collabToolLabel, copyableTranscriptText, isChooseWorkspaceSelection, isExternalWebUrl, isNearConversationBottom, latestAgentMessageIndex, parseLocalFileReference, threadGitContextLabel, titleEditorKeyAction } from './ConversationView'
import { formatWorkingElapsed, workingElapsedMilliseconds } from './ConversationStats'
import { parseThreadTitleGenerationSettings } from './useHarness'
import { draftThreadStartRequest, isFirstUserTurn, resolveNewThreadWorkspaceRoot, shouldDiscardDraftThread, shouldRecreateDraftThread, threadTitlePrompt, threadTurnContext } from './threadLifecycle'

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

describe('thread Git context', () => {
  it('uses the resolved branch, detached commit, or a non-Git placeholder', () => {
    expect(threadGitContextLabel({ branch: 'main', sha: 'abcdef0123456789' }, true)).toBe('main')
    expect(threadGitContextLabel({ branch: null, sha: 'c8f2f1ecd9682c007d9dd732190306333a45c65f' }, true)).toBe('c8f2f1e')
    expect(threadGitContextLabel(null, true)).toBe('-')
  })

  it('does not render stale Git metadata before the current CWD is resolved', () => {
    expect(threadGitContextLabel({ branch: 'main', sha: 'abcdef0123456789' }, false)).toBe('-')
  })
})

describe('markdown links', () => {
  it('only delegates web URLs to the system browser', () => {
    expect(isExternalWebUrl('https://openai.com/docs')).toBe(true)
    expect(isExternalWebUrl('http://localhost:1420')).toBe(true)
    expect(isExternalWebUrl('/workspace/readme.md')).toBe(false)
    expect(isExternalWebUrl('javascript:alert(1)')).toBe(false)
  })

  it('parses local file links with line and column locations', () => {
    expect(parseLocalFileReference('/repo/src/main.go:42')).toEqual({ path: '/repo/src/main.go', line: 42 })
    expect(parseLocalFileReference('src/main.go:42:7')).toEqual({ path: 'src/main.go', line: 42 })
    expect(parseLocalFileReference('file:///repo/My%20File.go#L9')).toEqual({ path: '/repo/My File.go', line: 9 })
    expect(parseLocalFileReference('../shared/types.ts')).toEqual({ path: '../shared/types.ts' })
  })

  it('does not treat web, command, or bare labels as local files', () => {
    expect(parseLocalFileReference('https://example.com/file.go:42')).toBeNull()
    expect(parseLocalFileReference('javascript:alert(1)')).toBeNull()
    expect(parseLocalFileReference('README')).toBeNull()
  })
})

describe('native sub-agent activity', () => {
  it('uses readable labels for collaboration tools and states', () => {
    expect(collabToolLabel('spawnAgent')).toBe('启动子 Agent')
    expect(collabToolLabel('followupTask')).toBe('追加子 Agent 任务')
    expect(collabToolLabel('futureTool')).toBe('协作 Agent')
    expect(activityStatusLabel('pendingInit')).toBe('初始化中')
    expect(activityStatusLabel('errored')).toBe('出错')
  })
})

describe('conversation scrolling', () => {
  it('keeps following content only while the viewport is near the bottom', () => {
    expect(isNearConversationBottom({ scrollTop: 452, clientHeight: 500, scrollHeight: 1_000 })).toBe(true)
    expect(isNearConversationBottom({ scrollTop: 400, clientHeight: 500, scrollHeight: 1_000 })).toBe(false)
  })
})

describe('message copying', () => {
  it('copies final answer fragments as Markdown paragraphs', () => {
    expect(copyableTranscriptText([
      { entry: { turnId: 'turn-1', item: { type: 'agentMessage', text: '第一段' } }, agentText: '第一段' },
      { entry: { turnId: 'turn-1', item: { type: 'agentMessage', text: '**第二段**' } }, agentText: '**第二段**' },
    ])).toBe('第一段\n\n**第二段**')
  })
})

describe('working status', () => {
  it('formats elapsed time as a stable minute clock', () => {
    expect(formatWorkingElapsed(0)).toBe('0:00')
    expect(formatWorkingElapsed(65_900)).toBe('1:05')
  })

  it('treats turn timestamps as milliseconds', () => {
    expect(workingElapsedMilliseconds(12_000, 8_500, 10_000)).toBe(3_500)
    expect(workingElapsedMilliseconds(12_000, null, 10_000)).toBe(2_000)
  })

  it('attaches to the latest Codex message in the active turn', () => {
    const rows = [
      { entry: { turnId: 'turn-1', item: { type: 'agentMessage' } } },
      { entry: { turnId: 'turn-2', item: { type: 'userMessage' } } },
      { entry: { turnId: 'turn-2', item: { type: 'agentMessage' } } },
      { entry: { turnId: 'turn-2', item: { type: 'agentMessage' } } },
    ]
    expect(latestAgentMessageIndex(rows, 'turn-2')).toBe(3)
    expect(latestAgentMessageIndex(rows, 'turn-3')).toBe(-1)
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

  it('uses the explicitly remembered cwd after the selected thread is archived', () => {
    expect(resolveNewThreadWorkspaceRoot('missing', [makeThread('/repo/current')], '/repo/remembered')).toBe('/repo/remembered')
    expect(resolveNewThreadWorkspaceRoot(null, [], '/repo/remembered')).toBe('/repo/remembered')
  })

  it('requires an explicit cwd without a selected thread or remembered target', () => {
    expect(resolveNewThreadWorkspaceRoot(null, [], null)).toBeNull()
  })

  it('recreates an unstarted thread when the workspace changed before the first turn', () => {
    expect(shouldRecreateDraftThread('/repo/old', '/repo/new')).toBe(true)
    expect(shouldRecreateDraftThread('/repo/current', '/repo/current')).toBe(false)
    expect(shouldRecreateDraftThread(undefined, '/repo/current')).toBe(false)
  })

  it('starts the replacement thread in the selected cwd with the draft settings', () => {
    const detail = {
      thread: makeThread('/repo/new'), turns: [], items: [], nextTurnsCursor: null,
      activeTurnId: null, foreignActive: false, runtimeWorkspaceRoots: ['/repo/new'],
      sandbox: null, activePermissionProfile: null, model: 'gpt-test',
      threadSettings: {
        model: 'gpt-test', effort: 'high', serviceTier: 'fast', approvalPolicy: 'never',
        approvalsReviewer: 'user', sandboxMode: 'danger-full-access',
      },
    } satisfies ThreadDetail
    expect(draftThreadStartRequest('/repo/new', detail)).toEqual({
      cwd: '/repo/new',
      runtimeWorkspaceRoots: ['/repo/new'],
      model: 'gpt-test',
      serviceTier: 'fast',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'danger-full-access',
    })
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

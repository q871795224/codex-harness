import { describe, expect, it } from 'vitest'
import { DEFAULT_TODO_FILTER, DEFAULT_TODO_SCOPE, insertPlainText, normalizeTodoStorage, todoScopePatch, todoThreadLabel, todoWorkspaceLabel, visibleTodos, type TodoItem } from './index'

function todo(id: string, scope: TodoItem['scope'], owner: string | null = null): TodoItem {
  return {
    id,
    content: id,
    completed: false,
    dueAt: null,
    scope,
    workspaceRoot: scope === 'workspace' ? owner : null,
    threadId: scope === 'thread' ? owner : null,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('visibleTodos', () => {
  it('combines global items with the current workspace and thread', () => {
    const items = [
      todo('global', 'global'),
      todo('workspace-a', 'workspace', '/a'),
      todo('workspace-b', 'workspace', '/b'),
      todo('thread-a', 'thread', 'thread-a'),
      todo('thread-b', 'thread', 'thread-b'),
    ]
    expect(visibleTodos(items, { workspaceRoot: '/a', threadId: 'thread-a', threadCwd: '/a' }).map((item) => item.id))
      .toEqual(['global', 'workspace-a', 'thread-a'])
  })

  it('sorts incomplete and scheduled items first', () => {
    const later = { ...todo('later', 'global'), dueAt: 20 }
    const done = { ...todo('done', 'global'), completed: true, dueAt: 1 }
    const sooner = { ...todo('sooner', 'global'), dueAt: 10 }
    expect(visibleTodos([later, done, sooner], { workspaceRoot: null, threadId: null, threadCwd: null }).map((item) => item.id))
      .toEqual(['sooner', 'later', 'done'])
  })

  it('shows global and every workspace item in the all-workspaces view', () => {
    const items = [
      todo('global', 'global'),
      todo('workspace-a', 'workspace', '/a'),
      todo('workspace-b', 'workspace', '/b'),
      todo('thread-a', 'thread', 'thread-a'),
    ]

    expect(visibleTodos(items, { workspaceRoot: '/a', threadId: 'thread-a', threadCwd: '/a' }, 'workspaces').map((item) => item.id))
      .toEqual(['global', 'workspace-a', 'workspace-b'])
  })

  it('shows all scopes in the all-threads view', () => {
    const items = [
      todo('global', 'global'),
      todo('thread-a', 'thread', 'thread-a'),
      todo('thread-b', 'thread', 'thread-b'),
      todo('workspace-a', 'workspace', '/a'),
    ]

    expect(visibleTodos(items, { workspaceRoot: '/a', threadId: 'thread-a', threadCwd: '/a' }, 'threads').map((item) => item.id))
      .toEqual(['global', 'thread-a', 'thread-b', 'workspace-a'])
  })
})

describe('todoWorkspaceLabel', () => {
  it('uses the registered workspace name and falls back to its directory name', () => {
    expect(todoWorkspaceLabel(todo('global', 'global'), [])).toBe('全局')
    expect(todoWorkspaceLabel(todo('named', 'workspace', '/projects/named'), [
      { root: '/projects/named', checkoutRoot: '/projects/named', name: 'Named project', branch: null, sha: null, createdAt: 0, lastOpenedAt: 0 },
    ])).toBe('Named project')
    expect(todoWorkspaceLabel(todo('fallback', 'workspace', '/projects/fallback'), [])).toBe('fallback')
    expect(todoThreadLabel(todo('unknown', 'thread', 'thread-unknown'), [])).toBe('thread-unknown')
  })
})

describe('todo defaults', () => {
  it('creates new todos at the global scope by default', () => {
    expect(DEFAULT_TODO_SCOPE).toBe('global')
  })

  it('shows todos from all threads by default', () => {
    expect(DEFAULT_TODO_FILTER).toBe('threads')
  })
})

describe('todo note plain text', () => {
  it('inserts clipboard text exactly at the current selection', () => {
    expect(insertPlainText('before <b>old</b> after', 7, 17, '<b>new</b>\nraw'))
      .toBe('before <b>new</b>\nraw after')
  })

  it('does not trim whitespace or blank lines', () => {
    expect(insertPlainText('ab', 1, 1, '  value  \n\n')).toBe('a  value  \n\nb')
  })

  it('migrates the previous per-item note into the single global note', () => {
    const stored = [{ ...todo('first', 'global'), note: 'global draft' }, { ...todo('second', 'global'), note: 'ignored legacy draft' }]
    expect(normalizeTodoStorage(stored)).toEqual({
      items: [todo('first', 'global'), todo('second', 'global')],
      legacyNote: 'global draft',
      changed: true,
    })
  })
})

describe('todoScopePatch', () => {
  it('moves a todo between global and the current thread', () => {
    const context = { workspaceRoot: '/repo', threadId: 'thread-a', threadCwd: '/repo' }

    expect(todoScopePatch('thread', context)).toEqual({
      scope: 'thread',
      workspaceRoot: null,
      threadId: 'thread-a',
    })
    expect(todoScopePatch('global', context)).toEqual({
      scope: 'global',
      workspaceRoot: null,
      threadId: null,
    })
  })

  it('rejects a scope that has no current owner', () => {
    expect(todoScopePatch('thread', { workspaceRoot: '/repo', threadId: null, threadCwd: '/repo' })).toBeNull()
    expect(todoScopePatch('workspace', { workspaceRoot: null, threadId: 'thread-a', threadCwd: null })).toBeNull()
  })
})

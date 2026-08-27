import { describe, expect, it } from 'vitest'
import { visibleTodos, type TodoItem } from './index'

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
    expect(visibleTodos(items, { workspaceRoot: '/a', threadId: 'thread-a' }).map((item) => item.id))
      .toEqual(['global', 'workspace-a', 'thread-a'])
  })

  it('sorts incomplete and scheduled items first', () => {
    const later = { ...todo('later', 'global'), dueAt: 20 }
    const done = { ...todo('done', 'global'), completed: true, dueAt: 1 }
    const sooner = { ...todo('sooner', 'global'), dueAt: 10 }
    expect(visibleTodos([later, done, sooner], { workspaceRoot: null, threadId: null }).map((item) => item.id))
      .toEqual(['sooner', 'later', 'done'])
  })
})

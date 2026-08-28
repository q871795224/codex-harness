import { describe, expect, it } from 'vitest'
import { orderConversationTabs, parseConversationTabOrder, reorderConversationTabs } from './tabOrder'

describe('conversation tab order', () => {
  it('loads a unique saved order and rejects invalid state', () => {
    expect(parseConversationTabOrder('["tasks","chat","tasks"]')).toEqual(['tasks', 'chat'])
    expect(parseConversationTabOrder('{"chat":1}')).toEqual([])
    expect(parseConversationTabOrder('broken')).toEqual([])
  })

  it('appends newly available tabs after the saved order', () => {
    expect(orderConversationTabs(['chat', 'tasks', 'runs'], ['runs', 'chat'])).toEqual(['runs', 'chat', 'tasks'])
  })

  it('reorders visible tabs without losing temporarily hidden tabs', () => {
    expect(reorderConversationTabs(
      ['chat', 'runs', 'tasks'],
      ['chat', 'thread-only', 'runs', 'tasks'],
      'tasks',
      'chat',
    )).toEqual(['tasks', 'chat', 'runs', 'thread-only'])
    expect(reorderConversationTabs(
      ['chat', 'runs', 'tasks'],
      ['chat', 'runs', 'tasks'],
      'chat',
      'tasks',
      'after',
    )).toEqual(['runs', 'tasks', 'chat'])
  })
})

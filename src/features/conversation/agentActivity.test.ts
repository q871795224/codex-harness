import { describe, expect, it } from 'vitest'
import { collectNativeAgentActivities } from './agentActivity'

describe('native agent activity', () => {
  it('keeps the latest state while retaining the original task', () => {
    const activities = collectNativeAgentActivities([
      { turnId: 'turn-1', item: { id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', prompt: '检查测试', receiverThreadIds: ['child-1'], agentsStates: { 'child-1': { status: 'running' } } } },
      { turnId: 'turn-1', item: { id: 'wait', type: 'collabAgentToolCall', tool: 'wait', status: 'completed', receiverThreadIds: ['child-1'], agentsStates: { 'child-1': { status: 'completed', message: '测试通过' } } } },
    ], { 'child-1': 2 })

    expect(activities).toEqual([{
      threadId: 'child-1', tool: 'wait', status: 'completed', task: '检查测试', message: '测试通过', approvalCount: 2,
    }])
  })
})

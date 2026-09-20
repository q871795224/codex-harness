import { describe, expect, it } from 'vitest'
import type { ThreadItemEntry } from '../../core/domain/codex'
import { trajectoryRows, trajectoryTimeline } from './trajectoryModel'
import { inspectItem } from './itemInspection'

const entry = (item: ThreadItemEntry['item'], turnId = 't1'): ThreadItemEntry => ({ turnId, item })

describe('role message projection', () => {
  it('splits calls/results without inventing a system message and numbers steps per turn', () => {
    const rows = trajectoryRows([
      entry({ id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'run tests', text_elements: [] }] }),
      entry({ id: 'c', type: 'commandExecution', command: 'npm test', status: 'completed', aggregatedOutput: 'ok', exitCode: 0 }),
      entry({ id: 'a', type: 'agentMessage', text: 'done' }),
      entry({ id: 'u2', type: 'userMessage', content: [] }, 't2'),
    ])
    expect(rows.map((row) => [row.role, row.turn, row.step])).toEqual([['user', 1, 1], ['assistant', 1, 2], ['tool', 1, 3], ['assistant', 1, 4], ['user', 2, 1]])
    expect(rows[1].input).toContain('npm test')
    expect(rows[2].output).toContain('ok')
  })
  it('keeps row identity during streaming and retains failed/empty results', () => {
    const call = { id: 'm', type: 'mcpToolCall', arguments: { a: 1 }, server: 's', tool: 't' }
    const running = trajectoryRows([entry({ ...call, status: 'inProgress' })])
    const done = trajectoryRows([entry({ ...call, status: 'failed', error: { message: 'denied' } })])
    expect(running).toHaveLength(1)
    expect(done).toHaveLength(2)
    expect(done[0].id).toBe(running[0].id)
    expect(done[1].output).toContain('denied')
    expect(trajectoryRows([entry({ ...call, status: 'completed' })])).toHaveLength(2)
  })
  it('does not classify unknown infrastructure events as system messages', () => {
    const rows = trajectoryRows([entry({ type: 'contextCompaction' }), entry({ type: 'customMessage', role: 'system', text: 'explicit system' }), entry({ type: 'reasoning', text: 'hidden' })])
    expect(rows.map((row) => row.role)).toEqual(['event', 'system'])
  })
  it('preserves structured tool inputs, results and file diffs', () => {
    expect(inspectItem({ type: 'dynamicToolCall', tool: 'lookup', arguments: { q: 'x' }, contentItems: [{ type: 'inputText', text: 'found' }], success: false })).toMatchObject({ input: { q: 'x' }, output: { success: false } })
    expect(inspectItem({ type: 'fileChange', changes: [{ path: 'x', diff: '-a\n+b' }] }).input).toEqual([{ path: 'x', diff: '-a\n+b' }])
  })
})

describe('timeline', () => {
  it('does not invent wall time from command duration or double count result rows', () => {
    const rows = trajectoryRows([entry({ type: 'commandExecution', id: 'c', durationMs: 200, status: 'completed' })])
    const timeline = trajectoryTimeline(rows)
    expect(timeline.timed).toBe(false)
    expect(timeline.segments).toHaveLength(1)
  })
  it('preserves overlapping observed intervals', () => {
    const rows = trajectoryRows([
      { ...entry({ id: 'a', type: 'agentMessage', text: 'hello' }), timing: { startedAt: 100, completedAt: 300 } },
      { ...entry({ id: 'b', type: 'commandExecution', status: 'completed' }), timing: { startedAt: 200, completedAt: 500 } },
    ])
    const { segments, timed } = trajectoryTimeline(rows)
    expect(timed).toBe(true)
    expect(segments.map(({ left, width }) => [left, width])).toEqual([[0, 50], [25, 75]])
  })
})

import { describe, expect, it } from 'vitest'
import { parseProjectBoard } from './board'

const DOC = `# 项目文档

## Status

公共状态：本周目标是完成速率限制。

### run-abc: 实现限流
已完成代码改动，测试通过。
还剩灰度。

### run-def: 补看板 UI
进行中。

## Log

run-abc 提交了初始版本。

run-def 发现冲突，重读后重写。

## Decisions

用 CAS 不用锁。
`

describe('parseProjectBoard', () => {
  it('parses Status into shared + run sections and Log into entries', () => {
    const board = parseProjectBoard(DOC)
    expect(board.hasStatus).toBe(true)
    expect(board.hasLog).toBe(true)
    expect(board.shared).toContain('本周目标')
    expect(board.runs.map((run) => run.runId)).toEqual(['run-abc', 'run-def'])
    expect(board.runs[0].title).toBe('实现限流')
    expect(board.runs[0].body).toContain('测试通过')
    expect(board.runs[1].body).toContain('进行中')
    expect(board.logEntries).toHaveLength(2)
    // 新的在前
    expect(board.logEntries[0]).toContain('重读后重写')
    expect(board.logEntries[1]).toContain('初始版本')
  })

  it('handles doc without Status/Log sections', () => {
    const board = parseProjectBoard('# 只有标题\n\n一些正文。\n')
    expect(board.hasStatus).toBe(false)
    expect(board.hasLog).toBe(false)
    expect(board.runs).toEqual([])
    expect(board.logEntries).toEqual([])
  })

  it('handles Status with no run subsections (all shared)', () => {
    const board = parseProjectBoard('## Status\n\n只有公共状态，没有 run 子区。\n')
    expect(board.runs).toEqual([])
    expect(board.shared).toContain('公共状态')
  })

  it('stops section at next same-or-higher heading', () => {
    const board = parseProjectBoard('## Status\n\n甲\n\n## Log\n\n乙\n\n## Decisions\n\n丙\n')
    expect(board.shared).toBe('甲')
    expect(board.logEntries).toEqual(['乙'])
  })
})

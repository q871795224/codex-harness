import { describe, expect, it } from 'vitest'
import {
  checkWrite,
  extractProjectDocUpdates,
  isSectionKey,
  renderProjectDocFrontMatter,
  requiresBaseSeq,
} from './document'

describe('isSectionKey', () => {
  it('识别推荐分区', () => {
    expect(isSectionKey('status')).toBe(true)
    expect(isSectionKey('log')).toBe(true)
    expect(isSectionKey('decisions')).toBe(true)
    expect(isSectionKey('openQuestions')).toBe(true)
  })

  it('拒绝未知分区', () => {
    expect(isSectionKey('Status')).toBe(false)
    expect(isSectionKey('random')).toBe(false)
    expect(isSectionKey('')).toBe(false)
  })
})

describe('extractProjectDocUpdates', () => {
  it('提取单个受控区提议（含 base_seq 与 version）', () => {
    const output = [
      '前文',
      '<project-doc-update>',
      'section: status',
      'base_seq: 5',
      'version: 1',
      '',
      '### run-abc: 当前在做 X',
      '已完成 A、B',
      '</project-doc-update>',
      '后文',
    ].join('\n')
    expect(extractProjectDocUpdates(output)).toEqual([
      { section: 'status', baseSeq: 5, version: 1, content: '### run-abc: 当前在做 X\n已完成 A、B' },
    ])
  })

  it('提取追加区提议（无 base_seq）', () => {
    const output = [
      '<project-doc-update>',
      'section: log',
      '',
      '跑完测试，全绿',
      '</project-doc-update>',
    ].join('\n')
    expect(extractProjectDocUpdates(output)).toEqual([
      { section: 'log', baseSeq: undefined, version: undefined, content: '跑完测试，全绿' },
    ])
  })

  it('一次输出提取多个块', () => {
    const output = [
      '<project-doc-update>',
      'section: decisions',
      '',
      '决定用 seq 而非锁',
      '</project-doc-update>',
      '中间文字',
      '<project-doc-update>',
      'section: openQuestions',
      '',
      '要不要加 Log 审批？',
      '</project-doc-update>',
    ].join('\n')
    const result = extractProjectDocUpdates(output)
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ section: 'decisions', content: '决定用 seq 而非锁' })
    expect(result[1]).toMatchObject({ section: 'openQuestions', content: '要不要加 Log 审批？' })
  })

  it('忽略未知 header 字段（前向兼容）', () => {
    const output = [
      '<project-doc-update>',
      'section: log',
      'future_field: whatever',
      '',
      '内容',
      '</project-doc-update>',
    ].join('\n')
    expect(extractProjectDocUpdates(output)).toEqual([
      { section: 'log', baseSeq: undefined, version: undefined, content: '内容' },
    ])
  })

  it('section 未知时跳过该块', () => {
    const output = [
      '<project-doc-update>',
      'section: unknown',
      '',
      '内容',
      '</project-doc-update>',
    ].join('\n')
    expect(extractProjectDocUpdates(output)).toEqual([])
  })

  it('没有块时返回空数组', () => {
    expect(extractProjectDocUpdates('普通输出，没有标记')).toEqual([])
  })

  it('缺少空行分隔（无内容）时跳过', () => {
    const output = ['<project-doc-update>', 'section: status', '</project-doc-update>'].join('\n')
    expect(extractProjectDocUpdates(output)).toEqual([])
  })

  it('内容为空时跳过', () => {
    const output = ['<project-doc-update>', 'section: log', '', '   ', '</project-doc-update>'].join('\n')
    expect(extractProjectDocUpdates(output)).toEqual([])
  })

  it('只有开标记没有闭标记时不提取', () => {
    const output = ['<project-doc-update>', 'section: log', '', '内容没有闭合'].join('\n')
    expect(extractProjectDocUpdates(output)).toEqual([])
  })

  it('base_seq 非整数时跳过', () => {
    const output = ['<project-doc-update>', 'section: status', 'base_seq: abc', '', '内容', '</project-doc-update>'].join(
      '\n',
    )
    expect(extractProjectDocUpdates(output)).toEqual([])
  })
})

describe('requiresBaseSeq', () => {
  it('受控区需要 base_seq，追加区不需要', () => {
    expect(requiresBaseSeq('status')).toBe(true)
    expect(requiresBaseSeq('log')).toBe(false)
    expect(requiresBaseSeq('decisions')).toBe(false)
    expect(requiresBaseSeq('openQuestions')).toBe(false)
  })
})

describe('checkWrite', () => {
  it('受控区 base_seq 匹配则允许并推进 seq', () => {
    expect(checkWrite('status', 5, 5)).toEqual({ ok: true, nextSeq: 6 })
  })

  it('受控区 base_seq 过期则冲突', () => {
    expect(checkWrite('status', 5, 7)).toEqual({ ok: false, reason: 'conflict', currentSeq: 7, baseSeq: 5 })
  })

  it('受控区缺 base_seq 视为冲突', () => {
    expect(checkWrite('status', undefined, 7)).toEqual({
      ok: false,
      reason: 'conflict',
      currentSeq: 7,
      baseSeq: undefined,
    })
  })

  it('追加区不校验 base_seq，始终允许', () => {
    expect(checkWrite('log', undefined, 7)).toEqual({ ok: true, nextSeq: 8 })
    expect(checkWrite('log', 3, 7)).toEqual({ ok: true, nextSeq: 8 })
  })
})

describe('renderProjectDocFrontMatter', () => {
  it('渲染簿记文件头（含 task）', () => {
    const fm = renderProjectDocFrontMatter({
      docId: 'wb-1',
      seq: 12,
      updatedBy: 'run-abc',
      updatedAt: '2026-09-03T10:00:00.000Z',
      task: 'thread-1',
    })
    expect(fm).toBe(
      [
        '---',
        'doc_id: wb-1',
        'seq: 12',
        'updated_by: run-abc',
        'updated_at: 2026-09-03T10:00:00.000Z',
        'task: thread-1',
        '---',
      ].join('\n'),
    )
  })

  it('无 task 时省略该行', () => {
    const fm = renderProjectDocFrontMatter({
      docId: 'wb-1',
      seq: 0,
      updatedBy: 'user',
      updatedAt: '2026-09-03T10:00:00.000Z',
    })
    expect(fm).toBe(
      ['---', 'doc_id: wb-1', 'seq: 0', 'updated_by: user', 'updated_at: 2026-09-03T10:00:00.000Z', '---'].join('\n'),
    )
  })
})

import { describe, expect, it } from 'vitest'
import {
  checkWrite,
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

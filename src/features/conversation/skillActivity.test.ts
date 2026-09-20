import { describe, expect, it } from 'vitest'
import type { CodexSkill, ThreadItem } from '../../core/domain/codex'
import { skillReads, skillReadStatus } from './skillActivity'
import { summarizeProcessRows } from './transcript'

const item: ThreadItem = {
  type: 'commandExecution', cwd: '/repo', status: 'completed', exitCode: 0,
  commandActions: [{ type: 'read', path: './skills/../skills/中文 skill/SKILL.md' }],
}
const catalog: CodexSkill[] = [{ name: 'review-code', path: '/repo/skills/中文 skill/SKILL.md', description: '', enabled: true, scope: 'user', pluginId: null }]

describe('skill read evidence', () => {
  it('resolves relative paths and uses the catalog name without parsing skill contents', () => {
    expect(skillReads(item, catalog)).toEqual([{ name: 'review-code', path: catalog[0].path }])
    expect(skillReads(item)[0].name).toBe('中文 skill')
  })
  it('deduplicates paths, handles multiple skills and ignores shell mentions/searches', () => {
    const reads = skillReads({ ...item, commandActions: [
      { type: 'read', path: './skills/中文 skill/SKILL.md' },
      { type: 'read', path: '/repo/skills/中文 skill/SKILL.md' },
      { type: 'read', path: '/skills/other/SKILL.md' },
      { type: 'search', path: '/skills/not-read/SKILL.md' },
      { type: 'read', path: '/repo/AGENTS.md' }, null, { type: 'read', path: 12 },
    ] })
    expect(reads.map((read) => read.name)).toEqual(['中文 skill', 'other'])
    expect(skillReads({ type: 'commandExecution', command: 'echo /skills/demo/SKILL.md' })).toEqual([])
    expect(skillReads({ ...item, type: 'agentMessage' })).toEqual([])
  })
  it.each([
    ['inProgress', null, '读取中'], ['completed', 0, '已读取'], ['failed', 1, '读取失败'],
    ['completed', 2, '读取失败'], ['declined', null, '未读取'], ['interrupted', null, '已中断'],
    ['completed', null, '结果未确认'],
  ])('labels %s / %s as %s', (status, exitCode, expected) => {
    expect(skillReadStatus({ type: 'commandExecution', status: String(status), exitCode: exitCode as number | null })).toBe(expected)
  })
  it('includes distinct skill names in the collapsed process summary', () => {
    const rows = [item, item].map((item) => ({ entry: { turnId: 't', item }, showAgentLabel: false }))
    expect(summarizeProcessRows(rows, catalog)).toBe('2 项 · 技能读取：review-code · 运行 2 条命令')
  })
})

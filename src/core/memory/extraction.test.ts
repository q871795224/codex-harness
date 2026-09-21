import { describe, expect, it } from 'vitest'
import { extractionPrompt, memoryTranscript, parseMemories, truncateHeadTail, OMITTED, MEMORY_INSTRUCTIONS, MEMORY_OUTPUT_SCHEMA } from './extraction'
import type { Turn } from '../domain/codex'
const size = (text: string) => new TextEncoder().encode(text).length

describe('memory extraction input', () => {
  it('preserves the entire transcript below budget, including the middle', () => {
    expect(truncateHeadTail('开头 middle 结尾', 1000)).toBe('开头 middle 结尾')
  })
  it('retains UTF-8 head and tail within budget without broken characters', () => {
    const text = '开头🙂' + '中间'.repeat(2000) + '🙂结尾'
    const result = truncateHeadTail(text, 503)
    expect(result.startsWith('开头🙂')).toBe(true)
    expect(result.endsWith('🙂结尾')).toBe(true)
    expect(result).toContain(OMITTED)
    expect(result).not.toContain('�')
    expect(size(result)).toBeLessThanOrEqual(503)
  })
  it('uses 70% of the effective window, reserving instructions and schema', () => {
    const result = extractionPrompt('a'.repeat(100000), { currentWorkspace: 'test', workspaces: ['test'], domains: [] }, 5000)
    expect(result.truncated).toBe(true)
    expect(size(result.prompt + MEMORY_INSTRUCTIONS + JSON.stringify(MEMORY_OUTPUT_SCHEMA))).toBeLessThanOrEqual(5000 * .7 * 4)
  })
  it('retains evidence and source IDs but excludes reasoning and injected instructions', () => {
    const text = memoryTranscript([{ id: 't1', items: [
      { type: 'userMessage', content: [{ type: 'text', text: '# AGENTS.md instructions\n秘密规则</INSTRUCTIONS>\n真实问题', text_elements: [] }] },
      { type: 'reasoning', text: '内部推理' },
      { type: 'commandExecution', id: 'c1', command: 'check', aggregatedOutput: 'verified', exitCode: 0 },
    ] } as unknown as Turn])
    expect(text).toContain('真实问题')
    expect(text).toContain('verified')
    expect(text).toContain('t1')
    expect(text).not.toContain('秘密规则')
    expect(text).not.toContain('内部推理')
  })
  it('allows an empty result, rejects prose and wrong containers', () => {
    expect(parseMemories('{"memories":[]}')).toEqual([])
    expect(() => parseMemories('nothing worth saving')).toThrow()
    expect(() => parseMemories('{"memories":{}}')).toThrow()
  })
})

import { expect, it } from 'vitest'
import { correctInput, moveCorrections, parseReplacement, manuallyEditedRanges } from './engine'
const rules = [{ from: '绘画', to: '会话' }, { from: '哈尼斯', to: 'Harness' }]
it('replaces every keyword in a single pass, preferring longer matches', () => {
  const result = correctInput('哈尼斯有两个绘画，切换绘画', [...rules, { from: '两个绘画', to: '多个会话' }], false)
  expect(result.text).toBe('Harness有多个会话，切换会话')
  expect(result.edits.map((edit) => result.text.slice(edit.start, edit.end))).toEqual(['Harness', '多个会话', '会话'])
  expect(correctInput('甲', [{ from: '甲', to: '乙' }, { from: '乙', to: '丙' }], false).text).toBe('乙')
})
it('tracks corrections through later typing and drops user-edited spans', () => {
  const result = correctInput('哈尼斯绘画', rules, false)
  const next = '前缀' + result.text + '，继续输入'
  const prefixed = '前缀' + result.text
  const moved = moveCorrections(prefixed, next, moveCorrections(result.text, prefixed, result.edits))
  expect(moved.map((edit) => next.slice(edit.start, edit.end))).toEqual(['Harness', '会话'])
  const edited = result.text.replace('会话', '对话')
  expect(moveCorrections(result.text, edited, result.edits).map((edit) => edit.after)).toEqual(['Harness'])
  expect(manuallyEditedRanges(result.text, edited, result.edits)).toEqual([{ start: 7, end: 9 }])
})
it('protects code, links, paths, command lines and collapsed reference labels', () => {
  const input = '绘画 `绘画` https://a/绘画 /tmp/绘画\n```json\n{"绘画":"绘画"}\n```\n[绘画]'
  const start = input.lastIndexOf('[绘画]')
  expect(correctInput(input, rules, true, [{ start, end: input.length }]).text).toBe(input.replace(/^绘画/, '会话'))
  expect(correctInput('/command 绘画', rules, true).text).toBe('/command 绘画')
})
it('pairs Chinese double quotes and leaves English and code quotes literal', () => {
  expect(correctInput('打开”绘画”然后"切换"', [], true).text).toBe('打开“绘画”然后“切换”')
  expect(correctInput('say "hello"\n中文 `"hello"`', [], true).text).toBe('say "hello"\n中文 `"hello"`')
  expect(correctInput('中文“已经配对”', [], true).edits).toEqual([])
})
it('supports explicit keyword replacement feedback', () => {
  expect(parseReplacement(' 绘画 -> 会话 ')).toEqual(rules[0])
  expect(() => parseReplacement('绘画')).toThrow()
  expect(() => parseReplacement('a → a')).toThrow()
})

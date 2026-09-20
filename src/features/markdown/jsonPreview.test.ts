import { expect, it } from 'vitest'
import { parseJsonPreview } from './jsonPreview'

it('parses objects and root arrays without mistaking string content for syntax', () => {
  expect(parseJsonPreview('{"text":"[9007199254740993] \\"quoted\\"", "items":[true,null,1.5]}'))
    .toEqual({ text: '[9007199254740993] "quoted"', items: [true, null, 1.5] })
  expect(parseJsonPreview('[{"x":1}]')).toEqual([{ x: 1 }])
  expect(parseJsonPreview('{}')).toEqual({})
})

it.each(['null', 'true', '123', '"text"', '{"x":', '{"x":1,}', '{/* comment */}'])('rejects non-tree JSON: %s', (code) => {
  expect(parseJsonPreview(code)).toBeNull()
})

it.each(['9007199254740993', '-9007199254740993', '1e20', '1e400'])('rejects unsafe numeric values: %s', (number) => {
  expect(parseJsonPreview(`{"id":${number}}`)).toBeNull()
})

it('bounds source size, depth and tree size before rendering', () => {
  expect(parseJsonPreview(JSON.stringify({ value: 'x'.repeat(100_000) }))).toBeNull()
  expect(parseJsonPreview('['.repeat(65) + '0' + ']'.repeat(65))).toBeNull()
  expect(parseJsonPreview(JSON.stringify(Array.from({ length: 5_000 }, () => true)))).toBeNull()
  expect(parseJsonPreview(JSON.stringify(Array.from({ length: 1_000 }, (_, i) => ({ id: i }))))).toHaveLength(1_000)
})

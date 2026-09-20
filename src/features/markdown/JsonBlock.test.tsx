// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Markdown } from './Markdown'
import { JsonBlock } from './JsonBlock'
import { writeClipboard } from './clipboard'

vi.mock('./clipboard', () => ({ writeClipboard: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./MermaidBlock', () => ({ MermaidBlock: () => <div>图表</div> }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const code = '{\n  "data": {"items": [{"name": "nested value"}]},\n  "status": "ok"\n}'
const fenced = (source: string) => `\`\`\`json\n${source}\n\`\`\``

it('expands two levels initially and lets objects and arrays expand independently', () => {
  render(<Markdown text={fenced(code)} collapsibleJson />)
  expect(screen.getAllByRole('button', { name: '折叠 JSON 节点' })).toHaveLength(2)
  expect(screen.queryByText('"nested value"')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '展开 JSON 节点' }))
  fireEvent.click(screen.getByRole('button', { name: '展开 JSON 节点' }))
  expect(screen.getByText('"nested value"')).toBeTruthy()
  fireEvent.click(screen.getAllByRole('button', { name: '折叠 JSON 节点' })[1])
  expect(screen.queryByText('"nested value"')).toBeNull()
  expect(screen.getByText('"ok"')).toBeTruthy()
})

it('preserves folding across message updates and source-view switches, and copies the original source', async () => {
  const { rerender, container } = render(<Markdown text={fenced(code)} collapsibleJson />)
  fireEvent.click(screen.getAllByRole('button', { name: '折叠 JSON 节点' })[1])
  rerender(<Markdown text={`${fenced(code)}\n\nMore streamed text`} collapsibleJson />)
  expect(screen.getAllByRole('button', { name: '折叠 JSON 节点' })).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: '原文' }))
  expect(container.querySelector('pre code')?.textContent).toBe(code)
  fireEvent.click(screen.getByRole('button', { name: '结构' }))
  expect(screen.getAllByRole('button', { name: '折叠 JSON 节点' })).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: '复制代码' }))
  await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith(code))
})

it('keeps an incomplete stream as code and enables the tree when the JSON becomes valid', () => {
  const { rerender, container } = render(<Markdown text={'```json\n{"data":'} collapsibleJson />)
  expect(screen.queryByRole('button', { name: '结构' })).toBeNull()
  expect(container.querySelector('pre code')?.textContent).toContain('{"data":')
  rerender(<Markdown text={fenced('{"data": [1,2]}')} collapsibleJson />)
  expect(screen.getByRole('tree', { name: 'JSON 结构' })).toBeTruthy()
})

it.each([
  '```\n{"data":{}}\n```',
  '```js\n{"data":{}}\n```',
  '`{"data":{}}`',
  '```json\n{"data": ...}\n```',
])('leaves unsupported input as ordinary Markdown: %s', (text) => {
  render(<Markdown text={text} collapsibleJson />)
  expect(screen.queryByRole('button', { name: '结构' })).toBeNull()
})

it('does not enable JSON trees in other Markdown consumers', () => {
  render(<Markdown text={fenced(code)} />)
  expect(screen.queryByRole('tree')).toBeNull()
})

it('preserves large integer source without rounding and copies all trailing source whitespace', async () => {
  const source = '{"id": 9007199254740993}\n\n'
  render(<Markdown text={fenced(source)} collapsibleJson />)
  expect(screen.queryByRole('tree')).toBeNull()
  expect(screen.getByText(/9007199254740993/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '复制代码' }))
  await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith(source))
})

it('supports keyboard folding and renders HTML-like values as text', () => {
  render(<JsonBlock code={'{"html":"<img src=x onerror=alert(1)>","items":[{}]}'} />)
  fireEvent.keyDown(screen.getAllByRole('button', { name: '折叠 JSON 节点' })[1], { key: 'ArrowLeft' })
  expect(screen.getByRole('button', { name: '展开 JSON 节点' })).toBeTruthy()
  expect(document.querySelector('img')).toBeNull()
  expect(screen.getByText('"<img src=x onerror=alert(1)>"')).toBeTruthy()
})

it('reports copy failures', async () => {
  vi.mocked(writeClipboard).mockRejectedValueOnce(new Error('clipboard unavailable'))
  render(<JsonBlock code={code} />)
  fireEvent.click(screen.getByRole('button', { name: '复制代码' }))
  expect(await screen.findByText('失败')).toBeTruthy()
})

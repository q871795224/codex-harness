// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
  openExternalUrl: vi.fn(),
  openWorkspacePath: vi.fn(),
  recordClientDiagnostic: vi.fn(),
}))

vi.mock('../../core/runtime/bridge', () => ({
  runtime,
  diagnosticErrorCode: () => 'request_failed',
}))

vi.mock('./MermaidBlock', () => ({
  MermaidBlock: ({ code }: { code: string }) => <div data-testid="mermaid-block">{code}</div>,
}))

import { Markdown } from './Markdown'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

it('renders markdown content', () => {
  render(<Markdown text={'# 标题\n\n正文 **加粗**'} />)
  expect(screen.getByRole('heading', { name: '标题' })).toBeTruthy()
  expect(screen.getByText('加粗').tagName).toBe('STRONG')
})

describe('table column resizing', () => {
  const text = '| 日期 / 编号 | 新增内容 | 意义 |\n| --- | --- | --- |\n| 10/7 · Day 2 | 内容 | [公告](https://example.com) |'

  function mockColumnSizes() {
    screen.getAllByRole('columnheader').forEach((cell, index) => {
      vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue({ width: [140, 240, 400][index] } as DOMRect)
    })
  }

  it('preserves markdown semantics and adjusted widths as more rows stream in', () => {
    const { container, rerender } = render(<Markdown text={text} />)
    mockColumnSizes()
    expect(screen.getAllByRole('columnheader')).toHaveLength(3)
    expect(screen.getByRole('link', { name: /公告/ })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('separator', { name: '调整第 1 列宽度' }), { key: 'ArrowRight' })
    expect(screen.getByRole('table').style.width).toBe('796px')
    expect(container.querySelector('col')?.style.width).toBe('156px')
    rerender(<Markdown text={`${text}\n| 10/8 | 追加的长文本 | 意义 |`} />)
    expect(screen.getAllByRole('row')).toHaveLength(3)
    expect(container.querySelector('col')?.style.width).toBe('156px')
    fireEvent.doubleClick(screen.getByRole('separator', { name: '调整第 1 列宽度' }))
    expect(container.querySelector('colgroup')).toBeNull()
    expect(screen.getByRole('table').style.width).toBe('')
  })

  it('clamps dragging at the minimum width and ends resizing on cancellation', () => {
    vi.stubGlobal('PointerEvent', MouseEvent)
    const { container } = render(<Markdown text={text} />)
    mockColumnSizes()
    const handle = screen.getByRole('separator', { name: '调整第 1 列宽度' })
    Object.assign(handle, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() })
    fireEvent.pointerDown(handle, { button: 0, clientX: 140 })
    fireEvent.pointerMove(handle, { clientX: 0 })
    expect(container.querySelector('col')?.style.width).toBe('112px')
    fireEvent.pointerCancel(handle)
    fireEvent.pointerMove(handle, { clientX: 300 })
    expect(container.querySelector('col')?.style.width).toBe('112px')
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(container.querySelector('colgroup')).toBeNull()
  })

  it('returns to automatic layout when the streamed table changes column count', () => {
    const { container, rerender } = render(<Markdown text={text} />)
    mockColumnSizes()
    fireEvent.keyDown(screen.getByRole('separator', { name: '调整第 1 列宽度' }), { key: 'ArrowRight' })
    rerender(<Markdown text={'| 日期 | 内容 |\n| --- | --- |\n| 10/8 | 新内容 |'} />)
    expect(screen.getAllByRole('columnheader')).toHaveLength(2)
    expect(container.querySelector('colgroup')).toBeNull()
    expect(screen.getByRole('table').style.width).toBe('')
  })

  it('keeps alignment and independent widths for multiple tables', () => {
    const { container } = render(<Markdown text={`${text}\n\n| 金额 |\n| ---: |\n| 100 |`} />)
    mockColumnSizes()
    const handles = screen.getAllByRole('separator', { name: '调整第 1 列宽度' })
    fireEvent.keyDown(handles[0], { key: 'ArrowRight' })
    const tables = screen.getAllByRole('table')
    expect(tables[0].style.width).toBe('796px')
    expect(tables[1].style.width).toBe('')
    expect(container.querySelectorAll('th')[3].style.textAlign).toBe('right')
  })
})

it('renders mermaid fenced blocks with the MermaidBlock component', () => {
  render(<Markdown text={'```mermaid\ngraph TD; A-->B\n```'} />)
  expect(screen.getByTestId('mermaid-block').textContent).toBe('graph TD; A-->B')
})

it('keeps regular code blocks as code blocks with a copy button', () => {
  render(<Markdown text={'```ts\nconst a = 1\n```'} />)
  expect(screen.queryByTestId('mermaid-block')).toBeNull()
  expect(screen.getByRole('button', { name: '复制代码' })).toBeTruthy()
  expect(screen.getByText('const a = 1')).toBeTruthy()
})

it('does not treat inline code as a mermaid block', () => {
  render(<Markdown text={'这是 `mermaid` 内联代码'} />)
  expect(screen.queryByTestId('mermaid-block')).toBeNull()
  expect(screen.getByText('mermaid').tagName).toBe('CODE')
})

it('opens external links through the runtime when cwd is provided', () => {
  runtime.openExternalUrl.mockResolvedValue(undefined)
  render(<Markdown text={'[docs](https://example.com/docs)'} cwd="/repo" />)
  fireEvent.click(screen.getByRole('link', { name: /docs/ }))
  expect(runtime.openExternalUrl).toHaveBeenCalledWith('https://example.com/docs')
})

it('opens external links before and after workspace context becomes available', () => {
  runtime.openExternalUrl.mockResolvedValue(undefined)
  const text = '[#104](https://github.com/q871795224/codex-harness/pull/104)'
  const { rerender } = render(<Markdown text={text} />)
  expect(fireEvent.click(screen.getByRole('link', { name: /#104/ }))).toBe(false)
  expect(runtime.openExternalUrl).toHaveBeenCalledWith('https://github.com/q871795224/codex-harness/pull/104')
  rerender(<Markdown text={text} cwd="/repo" />)
  expect(fireEvent.click(screen.getByRole('link', { name: /#104/ }))).toBe(false)
  expect(runtime.openExternalUrl).toHaveBeenCalledTimes(2)
})

it('waits for workspace context before opening relative files', () => {
  runtime.openWorkspacePath.mockResolvedValue(undefined)
  const { rerender } = render(<Markdown text="[file](src/main.ts)" />)
  expect(screen.queryByRole('link')).toBeNull()
  expect(screen.queryByRole('button')).toBeNull()
  fireEvent.click(screen.getByText('file'))
  expect(runtime.openWorkspacePath).not.toHaveBeenCalled()
  rerender(<Markdown text="[file](src/main.ts)" cwd="/repo" />)
  fireEvent.click(screen.getByRole('button', { name: 'file' }))
  expect(runtime.openWorkspacePath).toHaveBeenCalledWith('goland', '/repo', 'src/main.ts', undefined)
})

describe('CJK autolink repair', () => {
  it('keeps full-width parenthesis text out of an autolink wrapped in failed bold markers', () => {
    const { container } = render(
      <Markdown text={'PR：**https://github.com/q871795224/codex-harness/pull/76**（base `main`，MERGEABLE）'} />,
    )
    const link = screen.getByRole('link')
    expect(link.getAttribute('href')).toBe('https://github.com/q871795224/codex-harness/pull/76')
    expect(link.textContent).toBe('https://github.com/q871795224/codex-harness/pull/76')
    expect(link.parentElement?.tagName).toBe('STRONG')
    expect(container.textContent).toBe('PR：https://github.com/q871795224/codex-harness/pull/76（base main，MERGEABLE）')
  })

  it('splits trailing CJK annotation off bare autolinks', () => {
    const { container } = render(<Markdown text={'见 https://github.com/a/b（中文说明）谢谢'} />)
    const link = screen.getByRole('link')
    expect(link.getAttribute('href')).toBe('https://github.com/a/b')
    expect(container.textContent).toBe('见 https://github.com/a/b（中文说明）谢谢')
  })

  it('repairs www autolinks while keeping the synthesized protocol', () => {
    const { container } = render(<Markdown text={'见 www.example.com/a（b）即可'} />)
    const link = screen.getByRole('link')
    expect(link.getAttribute('href')).toBe('http://www.example.com/a')
    expect(container.textContent).toBe('见 www.example.com/a（b）即可')
  })

  it('restores strikethrough and underline-style bold wrappers around repaired autolinks', () => {
    const { container: strike } = render(<Markdown text={'看 ~~https://x.com/a~~（b）'} />)
    const strikeLink = strike.querySelector('del a')
    expect(strikeLink?.getAttribute('href')).toBe('https://x.com/a')
    expect(strike.textContent).toBe('看 https://x.com/a（b）')

    const { container: bold } = render(<Markdown text={'看 __https://x.com/a__（b）'} />)
    const boldLink = bold.querySelector('strong a')
    expect(boldLink?.getAttribute('href')).toBe('https://x.com/a')
    expect(bold.textContent).toBe('看 https://x.com/a（b）')
  })

  it('restores single-asterisk emphasis around repaired autolinks', () => {
    const { container } = render(<Markdown text={'看 *https://x.com/a*（b）'} />)
    const link = container.querySelector('em a')
    expect(link?.getAttribute('href')).toBe('https://x.com/a')
    expect(container.textContent).toBe('看 https://x.com/a（b）')
  })

  it('keeps unpaired markers literal while still cleaning the URL', () => {
    const { container } = render(<Markdown text={'看 **https://x.com/a（b）'} />)
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://x.com/a')
    expect(container.querySelector('strong')).toBeNull()
    expect(container.textContent).toBe('看 **https://x.com/a（b）')
  })

  it('splits full-width sentence punctuation off autolinks', () => {
    const { container } = render(<Markdown text={'链接是 https://x.com/a。下一句'} />)
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://x.com/a')
    expect(container.textContent).toBe('链接是 https://x.com/a。下一句')
  })

  it('leaves angle-bracket autolinks untouched', () => {
    render(<Markdown text={'见 <https://x.com/a（b）> 即可'} />)
    const href = screen.getByRole('link').getAttribute('href') ?? ''
    expect(decodeURI(href)).toBe('https://x.com/a（b）')
  })

  it('leaves explicit links with CJK destinations untouched', () => {
    render(<Markdown text={'见 [文字](https://x.com/a（b）) 即可'} />)
    const href = screen.getByRole('link', { name: '文字' }).getAttribute('href') ?? ''
    expect(decodeURI(href)).toBe('https://x.com/a（b）')
  })

  it('leaves legitimate CJK URL paths untouched', () => {
    render(<Markdown text={'见 https://zh.wikipedia.org/wiki/测试 即可'} />)
    const href = screen.getByRole('link').getAttribute('href') ?? ''
    expect(decodeURI(href)).toBe('https://zh.wikipedia.org/wiki/测试')
  })

  it('leaves underscores and tildes inside URL paths untouched', () => {
    render(<Markdown text={'见 https://x.com/a_b/c~d 即可'} />)
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://x.com/a_b/c~d')
  })
})

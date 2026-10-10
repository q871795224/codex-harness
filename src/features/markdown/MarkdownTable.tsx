import { Children, cloneElement, isValidElement, useRef, useState, type ComponentPropsWithoutRef, type PointerEvent, type ReactNode } from 'react'

const MIN_COLUMN_WIDTH = 112

export function MarkdownTable({ children, ...props }: ComponentPropsWithoutRef<'table'>) {
  const tableRef = useRef<HTMLTableElement>(null)
  const [widths, setWidths] = useState<number[] | null>(null)
  const drag = useRef<{ pointerId: number; column: number; startX: number; widths: number[] } | null>(null)
  let columnCount = 0

  function measuredWidths() {
    return Array.from(tableRef.current?.querySelectorAll('thead th') ?? [], (cell) => Math.max(MIN_COLUMN_WIDTH, cell.getBoundingClientRect().width))
  }

  function startResize(event: PointerEvent<HTMLButtonElement>, column: number) {
    if (event.button !== 0) return
    event.preventDefault()
    const current = measuredWidths()
    drag.current = { pointerId: event.pointerId, column, startX: event.clientX, widths: current }
    event.currentTarget.setPointerCapture(event.pointerId)
    setWidths(current)
  }

  function resize(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    const next = [...current.widths]
    next[current.column] = Math.max(MIN_COLUMN_WIDTH, next[current.column] + event.clientX - current.startX)
    setWidths(next)
  }

  function stopResize(event: PointerEvent<HTMLButtonElement>) {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  function decorate(node: ReactNode): ReactNode {
    return Children.map(node, (child) => {
      if (!isValidElement<ComponentPropsWithoutRef<'th'>>(child)) return child
      if (child.type !== 'th') return child.props.children ? cloneElement(child, {}, decorate(child.props.children)) : child
      const column = columnCount++
      return cloneElement(child, {}, child.props.children, <button
        type="button"
        className="markdown-column-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={`调整第 ${column + 1} 列宽度`}
        aria-valuemin={MIN_COLUMN_WIDTH}
        aria-valuenow={widths?.[column]}
        title="拖动调整列宽；方向键微调；双击或 Home 恢复自动宽度"
        onPointerDown={(event) => startResize(event, column)}
        onPointerMove={resize}
        onPointerUp={stopResize}
        onPointerCancel={stopResize}
        onLostPointerCapture={() => { drag.current = null }}
        onDoubleClick={() => setWidths(null)}
        onKeyDown={(event) => {
          if (event.key === 'Home') { event.preventDefault(); setWidths(null); return }
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          const next = measuredWidths()
          next[column] = Math.max(MIN_COLUMN_WIDTH, next[column] + (event.key === 'ArrowRight' ? 16 : -16))
          setWidths(next)
        }}
      />)
    })
  }

  const content = decorate(children)
  // A streamed row update keeps widths; a changed column structure returns to automatic layout.
  const activeWidths = widths?.length === columnCount ? widths : null
  return <div className="markdown-table-scroll" tabIndex={0} role="region" aria-label="表格，可横向滚动">
    <table {...props} ref={tableRef} style={activeWidths ? { tableLayout: 'fixed', width: activeWidths.reduce((sum, width) => sum + width, 0) } : undefined}>
      {activeWidths && <colgroup>{activeWidths.map((width, column) => <col key={column} style={{ width }} />)}</colgroup>}
      {content}
    </table>
  </div>
}

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react'
import { X } from 'lucide-react'
import type { ThreadItemEntry, Turn } from '../../core/domain/codex'
import { formatDuration } from '../../core/domain/format'
import { DetailValue, ItemInput, ItemOutput } from './ItemDetails'
import { trajectoryRows, trajectoryTimeline, type TrajectoryRow } from './trajectoryModel'
import './trajectory.css'

const tabs = ['概述', '参数', '结果', 'Schema', '计时'] as const
const roleLabels = { user: '用户', assistant: '助手', tool: '工具', system: '系统', developer: '开发者', event: '事件' }
// Six quiet, distinct turn bands; the turn label also identifies boundaries without color.
const palette = [210, 145, 38, 275, 185, 345]
const emptyTurns: Turn[] = []

export function TrajectoryView({ items, turns = emptyTurns, hasEarlierTurns = false }: { items: ThreadItemEntry[]; turns?: Turn[]; hasEarlierTurns?: boolean }) {
  const rows = useMemo(() => trajectoryRows(items, turns), [items, turns])
  const rowsById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows])
  const timeline = useMemo(() => trajectoryTimeline(rows), [rows])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = rows.find((row) => row.id === selectedId)
  const rowElements = useRef(new Map<string, HTMLButtonElement>())
  const select = (id: string, scroll = false) => {
    setSelectedId(id)
    if (scroll) rowElements.current.get(id)?.scrollIntoView?.({ block: 'nearest' })
  }
  const close = () => {
    setSelectedId(null)
    if (selectedId) rowElements.current.get(selectedId)?.focus()
  }
  if (rows.length === 0) return <div className="trajectory-empty">这里会显示 App Server 已公开的消息、工具调用与结果。</div>
  return <div className="trajectory-inspector">
    <header className="trajectory-overview">
      <div className="trajectory-overview-caption"><span>{rows.length} 步 · {new Set(rows.map((row) => row.entry.turnId)).size} 轮</span><span>{timeline.timed ? '时间分布 · 客户端接收时间' : '顺序概览 · 缺少完整步骤时间'}</span></div>
      <div className="trajectory-timeline" aria-label="轨迹时间条">
        {(['input', 'model', 'tool'] as const).map((lane) => <div className={`trajectory-lane ${lane}`} key={lane}>
          <span>{lane === 'input' ? '输入' : lane === 'model' ? '模型' : '工具'}</span>
          <div>{timeline.segments.filter((segment) => segment.lane === lane).map((segment) => {
            const row = rowsById.get(segment.rowId)!
            return <button key={segment.rowId} type="button" className={selectedId === segment.rowId ? 'selected' : ''}
              style={{ left: `${segment.left}%`, width: `${Math.min(segment.width, 100 - segment.left)}%` }}
              title={`第 ${row.turn} 轮 · 第 ${row.step} 步 · ${row.name}`} aria-label={`定位第 ${row.turn} 轮第 ${row.step} 步`}
              onClick={() => select(segment.rowId, true)} />
          })}</div>
        </div>)}
      </div>
      <p className="trajectory-source">按公开条目映射 role；工具调用与结果分行，不包含未公开的系统上下文。{hasEarlierTurns && ' 当前仅展示已加载历史，轮次从已加载部分开始编号。'}</p>
    </header>
    <div className="trajectory-workspace">
      <div className="trajectory-table-scroll">
        <div className="trajectory-table" role="table" aria-label="消息轨迹">
          <div className="trajectory-table-head" role="row"><span role="columnheader" aria-label="预留列" /><span role="columnheader">Role</span><span role="columnheader">输入 / 调用</span><span role="columnheader">输出 / 消息</span></div>
          {rows.map((row, index) => <button type="button" role="row" key={row.id}
            ref={(element) => { if (element) rowElements.current.set(row.id, element); else rowElements.current.delete(row.id) }}
            className={`trajectory-table-row ${selectedId === row.id ? 'selected' : ''} ${index === 0 || rows[index - 1].entry.turnId !== row.entry.turnId ? 'turn-start' : ''}`}
            style={{ '--turn-hue': palette[(row.turn - 1) % palette.length] } as CSSProperties}
            aria-label={`第 ${row.turn} 轮 · 第 ${row.step} 步 · ${row.role} · ${row.name}`} aria-selected={selectedId === row.id}
            onClick={() => select(row.id)}>
            <span role="cell" className="trajectory-gutter" />
            <span role="cell" className="trajectory-role-cell"><span className={`trajectory-role role-${row.role}`} title={roleLabels[row.role]}>{row.role}</span><small>#{row.turn}.{row.step}</small></span>
            <span role="cell" className="trajectory-preview" title={row.input}>{row.kind === 'call' && <b>{row.name} </b>}{row.input || '—'}</span>
            <span role="cell" className="trajectory-preview" title={row.output}>{row.output || '—'}</span>
          </button>)}
        </div>
      </div>
      {selected && <TrajectoryDetails row={selected} turn={turns.find((turn) => turn.id === selected.entry.turnId)} onClose={close} />}
    </div>
  </div>
}

function TrajectoryDetails({ row, turn, onClose }: { row: TrajectoryRow; turn?: Turn; onClose: () => void }) {
  const [tab, setTab] = useState<typeof tabs[number]>('概述')
  const id = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { closeRef.current?.focus() }, [])
  const { item, timing } = row.entry
  const duration = typeof item.durationMs === 'number' && item.durationMs >= 0 ? item.durationMs
    : timing?.startedAt != null && timing?.completedAt != null ? Math.max(0, timing.completedAt - timing.startedAt) : null
  const schema = item.inputSchema || item.outputSchema ? { inputSchema: item.inputSchema, outputSchema: item.outputSchema } : null
  return <aside className="trajectory-drawer" aria-label="步骤详情" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
    <header><span className={`trajectory-role role-${row.role}`}>{row.role}</span><span>第 {row.turn} 轮 · 第 {row.step} 步</span><button ref={closeRef} type="button" aria-label="关闭步骤详情" onClick={onClose}><X size={16} /></button></header>
    <div className="trajectory-detail-tabs" role="tablist" aria-label="步骤详情分类">{tabs.map((name, index) => <button key={name} type="button" role="tab" id={`${id}-tab-${index}`} aria-controls={`${id}-panel`} aria-selected={tab === name} tabIndex={tab === name ? 0 : -1}
      onClick={() => setTab(name)} onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
        setTab(tabs[next]); document.getElementById(`${id}-tab-${next}`)?.focus()
      }}>{name}</button>)}</div>
    <div className="trajectory-detail-body item-inspection" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${tabs.indexOf(tab)}`} tabIndex={0}>
      {tab === '概述' && <>
        <dl className="inspection-properties"><dt>类型</dt><dd>{row.name}</dd><dt>Role</dt><dd>{row.role}{row.kind === 'call' || row.kind === 'result' ? ' · 公开条目映射' : ''}</dd><dt>状态</dt><dd>{item.status ?? '—'}</dd><dt>Turn ID</dt><dd>{row.entry.turnId}</dd><dt>Item ID</dt><dd>{item.id ?? '未提供'}</dd></dl>
        <section><h4>{row.kind === 'call' ? '调用' : '消息内容'}</h4><DetailValue value={row.input || row.output} /></section>
        {row.kind === 'call' && <section><h4>结果</h4><ItemOutput item={item} /></section>}
        <details className="inspection-raw"><summary>原始条目</summary><DetailValue value={item} /></details>
      </>}
      {tab === '参数' && (row.kind === 'call' || row.kind === 'result' ? <ItemInput item={item} /> : <DetailValue value={row.input} empty="此消息没有调用参数" />)}
      {tab === '结果' && (row.kind === 'call' || row.kind === 'result' ? <ItemOutput item={item} /> : <DetailValue value={row.output} empty="此消息没有返回结果" />)}
      {tab === 'Schema' && <DetailValue value={schema} empty="此步骤未提供工具 Schema；不使用当前定义替代历史定义。" />}
      {tab === '计时' && <dl className="inspection-properties">
        <dt>步骤开始</dt><dd>{formatTime(timing?.startedAt)}</dd><dt>步骤结束</dt><dd>{formatTime(timing?.completedAt)}</dd>
        <dt>步骤耗时</dt><dd>{duration == null ? '未提供' : `${duration} ms · ${formatDuration(duration)}`}</dd>
        <dt>耗时来源</dt><dd>{item.durationMs != null ? 'App Server' : duration != null ? '客户端事件接收时间差' : '未提供'}</dd>
        <dt>时间来源</dt><dd>{timing ? '本次连接的事件接收时间，非服务端执行时间' : '历史条目未提供步骤时间'}</dd>
        <dt>轮次开始</dt><dd>{formatTime(turn?.startedAt == null ? undefined : turn.startedAt * 1000)}</dd>
        <dt>轮次结束</dt><dd>{formatTime(turn?.completedAt == null ? undefined : turn.completedAt * 1000)}</dd>
        <dt>轮次耗时</dt><dd>{turn?.durationMs == null ? '未提供' : formatDuration(turn.durationMs)}</dd>
      </dl>}
    </div>
  </aside>
}

function formatTime(value?: number): string {
  return value === undefined ? '未提供' : new Date(value).toLocaleString('zh-CN', { hour12: false }) + `.${String(value % 1000).padStart(3, '0')}`
}

import type { ThreadItem } from '../../core/domain/codex'
import { JsonBlock } from '../markdown/JsonBlock'
import { MarkdownCodeBlock } from '../markdown/MarkdownCodeBlock'
import { inspectItem, inspectionText } from './itemInspection'

export function DetailValue({ value, empty = 'App Server 未提供此内容' }: { value: unknown; empty?: string }) {
  const text = inspectionText(value)
  if (!text) return <p className="inspection-empty">{empty}</p>
  return typeof value === 'string'
    ? <MarkdownCodeBlock><code>{text}</code></MarkdownCodeBlock>
    : <JsonBlock code={text} />
}

export function ItemInput({ item }: { item: ThreadItem }) {
  if (item.type === 'commandExecution') return <>
    <DetailValue value={item.command} />
    {item.cwd && <p className="inspection-meta">工作目录：{String(item.cwd)}</p>}
  </>
  if (item.type === 'fileChange' && Array.isArray(item.changes)) return <>
    {item.changes.map((change, index) => <section key={`${change.path}:${index}`}>
      <p className="inspection-meta">{change.path ?? '未知文件'} · {inspectionText(change.kind)}</p>
      <DetailValue value={change.diff} empty="App Server 未提供 diff" />
    </section>)}
  </>
  return <DetailValue value={inspectItem(item).input} />
}

export function ItemOutput({ item }: { item: ThreadItem }) {
  if (item.type === 'commandExecution') return <>
    <DetailValue value={item.aggregatedOutput} empty={item.status === 'inProgress' ? '等待输出' : '暂无可展示的输出'} />
    {item.exitCode != null && <p className="inspection-meta">退出码：{String(item.exitCode)}</p>}
  </>
  return <DetailValue value={inspectItem(item).output} />
}

export function ToolCallDetails({ item }: { item: ThreadItem }) {
  return <div className="item-inspection">
    <section><h4>调用</h4><ItemInput item={item} /></section>
    <section><h4>结果</h4><ItemOutput item={item} /></section>
  </div>
}

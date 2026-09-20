import { useMemo, useState, type ComponentProps } from 'react'
import { Check, Copy } from 'lucide-react'
import { JsonView } from 'react-json-view-lite'
import { MarkdownCodeBlock } from './MarkdownCodeBlock'
import { writeClipboard } from './clipboard'
import { parseJsonPreview } from './jsonPreview'

const treeStyle: ComponentProps<typeof JsonView>['style'] = {
  container: 'json-tree',
  basicChildStyle: 'json-tree-node',
  childFieldsContainer: 'json-tree-children',
  label: 'json-tree-label',
  clickableLabel: 'json-tree-label',
  stringValue: 'json-tree-string',
  numberValue: 'json-tree-number',
  booleanValue: 'json-tree-literal',
  nullValue: 'json-tree-literal',
  undefinedValue: 'json-tree-literal',
  otherValue: 'json-tree-literal',
  punctuation: 'json-tree-punctuation',
  expandIcon: 'json-tree-toggle collapsed',
  collapseIcon: 'json-tree-toggle expanded',
  collapsedContent: 'json-tree-ellipsis',
  quotesForFieldNames: true,
  stringifyStringValues: true,
  ariaLables: { collapseJson: '折叠 JSON 节点', expandJson: '展开 JSON 节点' },
}

// A stable callback preserves manual expansion when the surrounding message updates.
const expandFirstTwoLevels = (level: number) => level < 2

export function JsonBlock({ code }: { code: string }) {
  const data = useMemo(() => parseJsonPreview(code), [code])
  const [view, setView] = useState<'tree' | 'code'>('tree')
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  const copy = async () => {
    try {
      await writeClipboard(code)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
    window.setTimeout(() => setCopyState('idle'), 1_500)
  }

  if (data === null) return <MarkdownCodeBlock><code className="language-json">{`${code}\n`}</code></MarkdownCodeBlock>

  return (
    <div className="json-block">
      <header className="json-block-toolbar">
        <span className="json-view-toggle">
          <button type="button" className={view === 'tree' ? 'selected' : ''} aria-pressed={view === 'tree'} onClick={() => setView('tree')}>结构</button>
          <button type="button" className={view === 'code' ? 'selected' : ''} aria-pressed={view === 'code'} onClick={() => setView('code')}>原文</button>
        </span>
        <button type="button" className={copyState} onClick={() => void copy()} aria-label="复制代码" title={copyState === 'failed' ? '复制失败' : '复制代码'}>
          {copyState === 'copied' ? <Check size={13} /> : <Copy size={13} />}
          {copyState === 'copied' ? '已复制' : copyState === 'failed' ? '失败' : '复制'}
        </button>
      </header>
      <div className="json-block-tree" hidden={view !== 'tree'}>
        <JsonView data={data} style={treeStyle} shouldExpandNode={expandFirstTwoLevels} aria-label="JSON 结构" />
      </div>
      {view === 'code' && <pre className="json-block-code"><code>{code}</code></pre>}
    </div>
  )
}

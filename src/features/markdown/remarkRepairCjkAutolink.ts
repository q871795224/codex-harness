// remark 插件：修复 GFM autolink 吞掉后续全角标点和失效强调标记的问题。
//
// 背景：中文语境下 LLM 常写出 `**https://…**（说明` 或 `https://…（说明）`。
// 按 CommonMark 定界符规则，闭合 `**` 后接全角括号时不构成合法闭合，加粗失效、`**` 变为字面文本；
// remark-gfm 的 autolink-literal 再把 `**（…` 一并吞进 URL（GitHub 渲染结果相同，但链接已损坏）。
// 本插件在 remark-gfm 之后运行：
// 1. 把 autolink 链接中第一个全角标点起的内容拆回普通文本（尖括号 autolink 和显式链接不动）；
// 2. 修剪因此遗留在 URL 尾部的 * _ ~ 标记（GFM 规范本就要求修剪尾部标记）；
// 3. 若链接前后出现配对的失效标记（如 `**…**`），恢复为 strong/emphasis/delete 包裹。

// mdast 节点的最小结构类型，避免为此引入 @types/mdast 依赖。
interface MdastNode {
  type: string
  value?: string
  url?: string
  children?: MdastNode[]
  position?: {
    start: { offset?: number }
    end: { offset?: number }
  }
}

const CJK_PUNCTUATION = /[（）【】《》〈〉「」『』，。、；：？！…]/
const TRAILING_MARKERS = /[*_~]+$/
// 只做配对恢复的标记；单个 _ 和 ~ 在 URL 中常见，不参与配对（尾部修剪仍按 GFM 规范执行）。
const PAIRABLE_MARKERS = ['**', '__', '~~', '*']

export function remarkRepairCjkAutolink() {
  return (tree: unknown) => {
    const root = tree as MdastNode
    if (Array.isArray(root.children)) {
      root.children = repairChildren(root.children)
    }
  }
}

function repairChildren(children: MdastNode[]): MdastNode[] {
  const out: MdastNode[] = []
  for (const child of children) {
    const repaired = repairAutolink(child)
    if (repaired === null) {
      if (child.type !== 'link' && Array.isArray(child.children)) {
        child.children = repairChildren(child.children)
      }
      pushNode(out, child)
      continue
    }
    let text = repaired.tail
    let node: MdastNode = repaired.link
    const prev = out[out.length - 1]
    if (prev?.type === 'text' && typeof prev.value === 'string') {
      const prevText = prev.value
      const marker = PAIRABLE_MARKERS.find((m) => prevText.endsWith(m) && text.startsWith(m))
      if (marker) {
        const remaining = prevText.slice(0, -marker.length)
        if (remaining === '') out.pop()
        else prev.value = remaining
        text = text.slice(marker.length)
        node = { type: markerWrapperType(marker), children: [repaired.link] }
      }
    }
    out.push(node)
    if (text !== '') pushNode(out, { type: 'text', value: text })
  }
  return out
}

function repairAutolink(node: MdastNode): { link: MdastNode; tail: string } | null {
  if (node.type !== 'link' || typeof node.url !== 'string') return null
  const children = node.children
  if (!children || children.length !== 1) return null
  const labelNode = children[0]
  if (labelNode.type !== 'text' || typeof labelNode.value !== 'string') return null
  const label = labelNode.value
  // autolink 的特征：显示文本即 URL 本身；www 自动链接会被补上 http:// 前缀。
  if (node.url !== label && node.url !== 'http://' + label) return null
  // 排除 <…> 尖括号 autolink：其 link 节点位置包含尖括号，与文本子节点范围不同。
  const linkPos = node.position
  const labelPos = labelNode.position
  if (
    linkPos && labelPos &&
    linkPos.start.offset !== undefined && labelPos.start.offset !== undefined &&
    (linkPos.start.offset !== labelPos.start.offset || linkPos.end.offset !== labelPos.end.offset)
  ) {
    return null
  }
  const stop = label.search(CJK_PUNCTUATION)
  if (stop === -1) return null
  let clean = label.slice(0, stop)
  let tail = label.slice(stop)
  const trailing = TRAILING_MARKERS.exec(clean)
  if (trailing) {
    clean = clean.slice(0, trailing.index)
    tail = trailing[0] + tail
  }
  if (clean === '') return null
  const urlPrefix = node.url.slice(0, node.url.length - label.length)
  return {
    link: { ...node, url: urlPrefix + clean, children: [{ ...labelNode, value: clean }] },
    tail,
  }
}

function markerWrapperType(marker: string): string {
  if (marker === '~~') return 'delete'
  return marker.length === 2 ? 'strong' : 'emphasis'
}

// 合并相邻 text 节点，保持树整洁。
function pushNode(out: MdastNode[], node: MdastNode): void {
  const last = out[out.length - 1]
  if (node.type === 'text' && last?.type === 'text' && typeof last.value === 'string' && typeof node.value === 'string') {
    last.value += node.value
    return
  }
  out.push(node)
}

import type { ThreadItemEntry } from '../../core/domain/codex'
import { itemText } from '../../core/domain/codex'

/**
 * 归档按钮（用户主动把会话进展提炼进项目文档 Status 区）的纯逻辑。
 *
 * 设计见 .harness/project-doc-plugin-plan.md 第 2 节：
 * - 取最近 N 轮核心消息（user / agent），过滤命令执行、工具调用、文件改动等噪声。
 * - 起匿名 detached run，prompt 自带格式要求，产出"提炼后的 Status 草稿"。
 * - 产出先暂存，经人在编辑界面看 diff、可再改、点保存后才 writeSection 落盘。
 */

/** 进入归档上下文的消息类型（其余视为噪声过滤掉）。 */
const CORE_MESSAGE_TYPES = new Set(['userMessage', 'agentMessage'])

export interface ArchiveTranscriptMessage {
  role: 'user' | 'agent'
  text: string
}

/**
 * 从会话 items 提取最近 maxTurns 个"轮"的核心对话。
 * 一轮以 userMessage 开头；agentMessage 归入最近一轮。过滤空文本。
 * 返回按时间正序的消息列表（旧→新）。
 */
export function collectArchiveMessages(items: ThreadItemEntry[], maxTurns: number): ArchiveTranscriptMessage[] {
  const messages: ArchiveTranscriptMessage[] = []
  for (const entry of items) {
    const type = entry.item.type
    if (!CORE_MESSAGE_TYPES.has(type)) continue
    const text = itemText(entry.item).trim()
    if (!text) continue
    messages.push({ role: type === 'userMessage' ? 'user' : 'agent', text })
  }
  // 按"轮"（user 消息）计最近 maxTurns 轮：从末尾往前数 user 消息。
  if (maxTurns > 0) {
    let userCount = 0
    let cutoff = 0
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'user') {
        userCount += 1
        if (userCount > maxTurns) {
          // index 是第 maxTurns+1 个 user（要丢弃的那一轮的 user）。
          // 保留点 = 其后第一个 user（即最近第 maxTurns 轮的开始）。
          let start = messages.length
          for (let scan = index + 1; scan < messages.length; scan += 1) {
            if (messages[scan].role === 'user') { start = scan; break }
          }
          cutoff = start
          break
        }
      }
    }
    return messages.slice(cutoff)
  }
  return messages
}

/** 把核心消息渲染成归档 prompt 用的纯文本转录。 */
export function renderArchiveTranscript(messages: ArchiveTranscriptMessage[]): string {
  return messages
    .map((message) => `${message.role === 'user' ? '用户' : 'Agent'}：\n${message.text}`)
    .join('\n\n---\n\n')
}

export const DEFAULT_ARCHIVE_PROMPT_TEMPLATE = `下面是某个工作会话最近几轮的对话记录，以及该项目当前的项目文档（Status 区）。

请把这段会话中**对项目有长期价值的进展**提炼成项目文档 Status 区的最新内容：完成的结论、已拍板的决定、当前进行到哪、下一步、遗留问题。忽略闲聊、过程性试探和已被后续推翻的中间态。

要求：
- 只输出 Status 区的**完整新内容**（markdown 正文，不要带 \`## Status\` 标题行，不要带 YAML front matter）。
- 基于"当前 Status"做覆盖式更新：保留仍然有效的内容，用本次会话的新进展刷新它。
- 不要编造会话里没有的结论；没有新进展时原样返回当前 Status。

【当前 Status】
{{currentStatus}}

【最近会话】
{{transcript}}`

export interface ArchivePromptInput {
  template: string
  currentStatus: string
  transcript: string
}

/** 用占位符渲染归档 prompt。未知占位符原样保留。 */
export function renderArchivePrompt(input: ArchivePromptInput): string {
  return input.template
    .replaceAll('{{currentStatus}}', input.currentStatus)
    .replaceAll('{{transcript}}', input.transcript)
}

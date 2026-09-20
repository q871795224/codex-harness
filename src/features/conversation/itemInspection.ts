import type { ThreadItem } from '../../core/domain/codex'

export const toolItemTypes = new Set(['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'fileChange', 'collabAgentToolCall', 'webSearch', 'imageView', 'imageGeneration', 'sleep'])

export function inspectionText(value: unknown): string {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function fields(item: ThreadItem, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => item[key] !== undefined && item[key] !== null).map((key) => [key, item[key]]))
}

export function inspectItem(item: ThreadItem): { name: string; input: unknown; output: unknown } {
  switch (item.type) {
    case 'commandExecution': return { name: 'command', input: fields(item, ['command', 'cwd', 'source']), output: fields(item, ['aggregatedOutput', 'exitCode']) }
    case 'mcpToolCall': return { name: `${item.server ?? 'MCP'}/${item.tool ?? ''}`, input: item.arguments, output: fields(item, ['result', 'error']) }
    case 'dynamicToolCall': return { name: [item.namespace, item.tool].filter(Boolean).join('/'), input: item.arguments, output: fields(item, ['contentItems', 'success']) }
    case 'fileChange': return { name: 'apply_patch', input: item.changes, output: fields(item, ['status']) }
    case 'collabAgentToolCall': return { name: item.tool ?? 'agent', input: fields(item, ['prompt', 'senderThreadId', 'receiverThreadIds', 'model', 'reasoningEffort']), output: item.agentsStates }
    case 'webSearch': return { name: 'webSearch', input: fields(item, ['query', 'action']), output: fields(item, ['status', 'result']) }
    case 'imageView': return { name: 'imageView', input: fields(item, ['path']), output: item.result }
    case 'imageGeneration': return { name: 'imageGeneration', input: fields(item, ['revisedPrompt']), output: fields(item, ['status', 'result']) }
    case 'sleep': return { name: 'sleep', input: fields(item, ['durationMs']), output: fields(item, ['status']) }
    default: return { name: item.type, input: item.arguments ?? item.content, output: item.text ?? item.output ?? item.result ?? item }
  }
}

export function hasToolResult(item: ThreadItem): boolean {
  return ['completed', 'failed', 'interrupted', 'declined'].includes(item.status ?? '')
    || item.exitCode != null || item.result != null || item.error != null || item.contentItems != null
    || typeof item.aggregatedOutput === 'string' && item.aggregatedOutput.length > 0
    || item.agentsStates != null && Object.keys(item.agentsStates).length > 0
}

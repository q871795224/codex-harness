import type { McpRuntimeStatus } from '../../core/domain/codex'

export function startupRuntimeStatus(value: unknown): McpRuntimeStatus | null {
  if (value === 'ready') return 'connected'
  if (value === 'starting' || value === 'failed' || value === 'cancelled') return value
  return null
}

export function mcpStatusLabel(status: McpRuntimeStatus): string {
  if (status === 'connected') return '已连接'
  if (status === 'starting') return '启动中'
  if (status === 'failed') return '启动失败'
  if (status === 'authenticationRequired') return '需要认证'
  if (status === 'cancelled') return '已取消'
  if (status === 'disabled') return '已停用'
  return '未启动'
}

export function mcpNeedsAttention(status: McpRuntimeStatus | null): boolean {
  return status === 'failed' || status === 'authenticationRequired' || status === 'cancelled'
}

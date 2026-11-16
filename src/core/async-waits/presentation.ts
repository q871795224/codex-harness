import type { AsyncWaitTask } from './types'

export const asyncWaitStatusLabels: Record<AsyncWaitTask['status'], string> = {
  awaitingApproval: '等待用户确认',
  notified: '已通知，未自动发送',
  waiting: '等待外部结果',
  ready: '已就绪，等待会话空闲',
  paused: '已暂停',
  expired: '等待已到期',
  dispatching: '提交中／待核对',
  uncertain: '提交结果待核对',
  delivered: '已继续处理',
  cancelled: '已取消',
  closed: '已核对结束',
}

export function asyncWaitEnded(status: AsyncWaitTask['status']) {
  return ['delivered', 'notified', 'cancelled', 'closed'].includes(status)
}

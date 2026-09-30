import { useEffect, useMemo } from 'react'
import { appServer } from '../runtime/appServerClient'
import { runtime } from '../runtime/bridge'
import { notifications } from '../notifications/service'
import type { AgentRunService } from '../agent-runs/types'
import { TeamCoordinator } from './service'

export function useTeamsService(runs: AgentRunService) {
  const service = useMemo(() => new TeamCoordinator({
    read: runtime.teamReadDocument,
    write: runtime.teamWriteDocument,
    runs,
    async settings(member, readOnly, cwd) {
      let model = member.model
      let effort = member.effort
      if (member.provider === 'codex') {
        const { config } = await appServer.readConfig(cwd)
        model ||= config.model ?? ''
        if (!member.model) effort ||= config.model_reasoning_effort ?? ''
        const { data } = await appServer.listModels()
        const selected = model ? data.find((m) => m.model === model || m.id === model) : data.find((m) => m.isDefault)
        model ||= selected?.model ?? ''
        effort ||= selected?.defaultReasoningEffort ?? ''
        if (!model) throw new Error('没有可用的 Codex 模型，请在成员配置中选择')
        if (effort && selected && !selected.supportedReasoningEfforts.some((e) => e.reasoningEffort === effort)) throw new Error('成员推理强度不受当前模型支持，请修正配置后新建任务')
      }
      return { model, effort, serviceTier: null, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxMode: readOnly ? 'read-only' : 'workspace-write' }
    },
    async models() {
      const [codex, claude] = await Promise.allSettled([appServer.listModels(), runtime.listClaudeModels('')])
      if (codex.status === 'rejected' && claude.status === 'rejected') throw new Error('模型列表读取失败，请检查 Provider 连接')
      return [
        ...(codex.status === 'fulfilled' ? codex.value.data.map((m) => ({ id: m.model, name: m.displayName, efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort), provider: 'codex' as const })) : []),
        ...(claude.status === 'fulfilled' ? claude.value.models.map((m) => ({ id: m.value, name: m.displayName, efforts: m.supportedEffortLevels, provider: 'claude' as const })) : []),
      ]
    },
    async skills(cwd) {
      const { data } = await appServer.listSkills(cwd)
      return data.flatMap((entry) => entry.skills).filter((skill) => skill.enabled)
    },
    notify(title, message) { notifications.publish({ source: 'teams', level: 'info', title, message }) },
  }), [runs])
  useEffect(() => {
    void service.initialize().catch(() => undefined)
    return () => service.dispose()
  }, [service])
  return service
}

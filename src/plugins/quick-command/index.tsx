import { useEffect, useState } from 'react'
import { Save, Terminal } from 'lucide-react'
import type { QuickCommandService } from '../../core/quick-commands/types'
import type { HarnessPlugin, PluginInstanceRecord, PluginSettingsProps } from '../../extensions/types'
import { QUICK_COMMANDS, quickCommandDefinition, readQuickCommandId } from './config'

export const quickCommandPlugin: HarnessPlugin = {
  manifest: {
    schemaVersion: 1,
    id: 'builtin.quick-command',
    name: '快捷命令',
    description: '在后台执行受控的本地登录与连接命令。',
    version: '1.0.0',
    engine: { codexHarness: '^0.4.11' },
    supportedScopes: ['global', 'workspace'],
    permissions: ['process:quick-command'],
  },
  allowMultipleInstancesPerScope: true,
  createInstanceConfig: () => ({ commandId: 'vpn-on' }),
  instanceLabel: (instance) => quickCommandDefinition(readQuickCommandId(instance.config)).label,
  settings: QuickCommandSettings,
  activate(ctx) {
    const service = ctx.services.get<QuickCommandService>('harness.quickCommands')
    const command = quickCommandDefinition(readQuickCommandId(ctx.config))
    ctx.slots.quickCommands.register({
      id: command.id,
      label: command.label,
      command: command.command,
      order: command.order,
      run: () => service.run(command.id),
    })
  },
}

export const quickCommandDefaultInstances: PluginInstanceRecord[] = QUICK_COMMANDS.map((command, index) => ({
  instanceId: `builtin.quick-command:${command.id}`,
  pluginId: quickCommandPlugin.manifest.id,
  scope: { kind: 'global' },
  enabled: true,
  config: { commandId: command.id },
  createdAt: index,
  updatedAt: index,
}))

function QuickCommandSettings({ instance, saveConfig }: PluginSettingsProps) {
  const [commandId, setCommandId] = useState(() => readQuickCommandId(instance.config))
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const command = quickCommandDefinition(commandId)

  useEffect(() => {
    setCommandId(readQuickCommandId(instance.config))
    setMessage(null)
  }, [instance.config, instance.instanceId])

  const save = async () => {
    setSaving(true)
    setMessage(null)
    try {
      await saveConfig({ commandId })
      setMessage('已保存')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="quick-command-settings">
      <div className="quick-command-settings-intro"><Terminal size={15} /><span>当前实例对应一个受控后台命令；使用左侧 + 新增其他实例。</span></div>
      <label className="quick-command-setting-row">
        <span>命令</span>
        <select value={commandId} onChange={(event) => { setCommandId(event.target.value as typeof commandId); setMessage(null) }}>
          {QUICK_COMMANDS.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label} · {candidate.command}</option>)}
        </select>
      </label>
      <div className="quick-command-preview"><span>EXEC</span><code>{command.command}</code></div>
      <div className="quick-command-settings-save">
        <button type="button" disabled={saving} onClick={() => void save()}><Save size={14} />{saving ? '保存中…' : '保存命令'}</button>
        {message && <span>{message}</span>}
      </div>
    </div>
  )
}

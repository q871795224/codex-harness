import { useState } from 'react'
import { LoaderCircle, MoonStar } from 'lucide-react'
import type { ComposerActionProps, HarnessPlugin, PluginInstanceRecord } from '../../extensions/types'

export const LUNA_DELEGATE_PROMPT = '$plan-delegate 请基于当前会话已经对齐的目标、约束和验收要求，\n整理一份独立 handoff，并交给 Luna Max 实施。'

export const lunaPlugin: HarnessPlugin = {
  manifest: {
    schemaVersion: 1,
    id: 'builtin.temporary-agent',
    name: 'Luna',
    description: '把当前会话已经对齐的内容整理成 handoff，再交给 Luna Max 实施。',
    version: '1.1.0',
    engine: { codexHarness: '^0.1.0' },
    supportedScopes: ['global', 'workspace', 'thread'],
  },
  activate(ctx) {
    ctx.slots.composerActions.register({
      id: 'delegate-to-luna',
      order: 20,
      render: (props) => <LunaComposerAction {...props} />,
    })
  },
}

export const lunaDefaultInstance: PluginInstanceRecord = {
  instanceId: 'builtin.temporary-agent:default',
  pluginId: lunaPlugin.manifest.id,
  scope: { kind: 'global' },
  enabled: true,
  config: {},
  createdAt: 0,
  updatedAt: 0,
}

function LunaComposerAction({ disabled, insertSkillPrompt }: ComposerActionProps) {
  const [busy, setBusy] = useState(false)
  const insert = async () => {
    setBusy(true)
    try {
      await insertSkillPrompt('plan-delegate', LUNA_DELEGATE_PROMPT)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      className="luna-composer-button"
      disabled={disabled || busy}
      onClick={() => void insert()}
      title="将 plan-delegate 请求填入输入框"
    >
      {busy ? <LoaderCircle className="spin" size={13} /> : <MoonStar size={13} />}
      交给 Luna
    </button>
  )
}

import { version } from '../../../package.json'
import harnessIcon from '../../../icon/codex-harness.svg'
import harnessDevIcon from '../../../icon/codex-harness-dev.svg'
import type { InterfaceMode } from '../interface/useInterfaceMode'

export function BrandRow({ view, onSwitchView }: { view: InterfaceMode; onSwitchView?: () => void }) {
  const development = import.meta.env.MODE === 'dev'
  const current = view === 'conversation' ? '会话视图' : '团队视图'
  const target = view === 'conversation' ? '团队视图' : '会话视图'
  return <div className="brand-row">
    <button className="brand-switch" type="button" onClick={onSwitchView} aria-label={`切换到${target}`} title={`${current} · 点击切换到${target}`}>
      <img className="brand-mark" src={development ? harnessDevIcon : harnessIcon} alt="" />
      <span className="brand-name">codex <strong>HARNESS</strong></span>
    </button>
    <span className="brand-version">{development ? `DEV · v${version}` : `v${version}`}</span>
  </div>
}

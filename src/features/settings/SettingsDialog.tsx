import { useEffect } from 'react'
import { Check, Palette, Type, X } from 'lucide-react'
import type { FontSize } from '../../core/domain/codex'

interface SettingsDialogProps {
  fontSize: FontSize
  onFontSize: (fontSize: FontSize) => void
  onClose: () => void
}

const fontSizeOptions: Array<{ value: FontSize; label: string; detail: string }> = [
  { value: 'compact', label: '紧凑', detail: '信息密度更高' },
  { value: 'standard', label: '标准', detail: '当前推荐大小' },
  { value: 'large', label: '大', detail: '更舒适的阅读' },
]

export function SettingsDialog({ fontSize, onFontSize, onClose }: SettingsDialogProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
        <aside className="settings-nav" aria-label="设置菜单">
          <div className="settings-nav-brand">
            <span className="settings-kicker">HARNESS</span>
            <h2>设置</h2>
          </div>
          <nav>
            <button type="button" className="selected" aria-current="page">
              <Palette size={16} />
              外观
            </button>
          </nav>
        </aside>

        <div className="settings-panel">
          <header className="settings-panel-head">
            <div>
              <span className="settings-kicker">外观</span>
              <h2 id="settings-title">外观</h2>
            </div>
            <button type="button" className="settings-close" onClick={onClose} aria-label="关闭设置"><X size={18} /></button>
          </header>

          <section className="settings-section" aria-labelledby="font-size-title">
            <div className="settings-section-title">
              <Type size={17} />
              <div>
                <h3 id="font-size-title">字体大小</h3>
                <p>立即应用，并仅保存在这台设备上。</p>
              </div>
            </div>
            <div className="font-size-options" role="radiogroup" aria-label="字体大小">
              {fontSizeOptions.map((option) => {
                const selected = fontSize === option.value
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={selected ? 'selected' : ''}
                    onClick={() => onFontSize(option.value)}
                  >
                    <span>{option.label}</span>
                    <small>{option.detail}</small>
                    {selected && <Check size={16} aria-hidden />}
                  </button>
                )
              })}
            </div>
          </section>
        </div>
      </section>
    </div>
  )
}

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CodexUpdatePanel } from './CodexUpdatePanel'

describe('CodexUpdatePanel', () => {
  it('explains the shared CLI and App Server update and exposes all decisions', () => {
    const html = renderToStaticMarkup(
      <CodexUpdatePanel
        status={{
          currentVersion: '0.150.1',
          appServerVersion: '0.150.1',
          latestVersion: '0.151.0',
          updateAvailable: true,
          skipped: false,
          lastCheckedAt: 1,
          checkError: null,
        }}
        updating={false}
        error={null}
        onInstall={() => undefined}
        onDefer={() => undefined}
        onSkip={() => undefined}
      />,
    )

    expect(html).toContain('v0.150.1')
    expect(html).toContain('v0.151.0')
    expect(html).toContain('Codex CLI 与 App Server 会一起更新')
    expect(html).toContain('>更新<')
    expect(html).toContain('>跳过<')
    expect(html).toContain('>跳过直到下个版本<')
  })
})

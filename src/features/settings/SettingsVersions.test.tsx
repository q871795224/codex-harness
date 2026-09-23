// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SettingsVersions } from './SettingsDialog'

afterEach(cleanup)
const status = { currentVersion: '0.156.1', appServerVersion: '0.156.1', latestVersion: '0.157.0', updateAvailable: true, skipped: false, lastCheckedAt: 1, checkError: null }
const props = { versions: null, loading: false, error: null, updateStatus: status, onRefresh: vi.fn(), diagnosticsError: null, onOpenDiagnostics: vi.fn() }

it('keeps the refresh action and displays an available update at the version footer', () => {
  render(<SettingsVersions {...props} />)
  fireEvent.click(screen.getByRole('button', { name: '刷新版本并检查更新' }))
  expect(props.onRefresh).toHaveBeenCalledOnce()
  expect(screen.getByRole('status').textContent).toBe('（有新版本）')
})

it('keeps check errors in the refresh tooltip without adding another line', () => {
  render(<SettingsVersions {...props} updateStatus={{ ...status, updateAvailable: false, checkError: '检查更新失败：HTTP 403' }} />)
  expect(screen.getByRole('button', { name: '刷新版本并检查更新' }).title).toContain('HTTP 403')
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.queryByText('当前 Codex 已是最新版本')).toBeNull()
})

it('disables repeated refreshes while checking', () => {
  render(<SettingsVersions {...props} loading />)
  expect((screen.getByRole('button', { name: '刷新版本并检查更新' }) as HTMLButtonElement).disabled).toBe(true)
})

it('only shows the version summary when Codex is current', () => {
  render(<SettingsVersions {...props} versions={{ harness: '0.9.6', appServer: '0.156.1', codexCli: '0.156.1' }} updateStatus={{ ...status, updateAvailable: false }} />)
  expect(screen.getByText('v0.9.6')).toBeTruthy()
  expect(screen.getAllByText('v0.156.1')).toHaveLength(2)
  expect(screen.queryByText('版本信息')).toBeNull()
  expect(screen.queryByText('诊断日志不记录对话正文或凭证')).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
})

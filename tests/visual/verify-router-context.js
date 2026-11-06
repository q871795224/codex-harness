async (page) => {
  const base = 'http://127.0.0.1:1439/tests/visual/router-context.html'
  const checkWidth = async () => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
    if (overflow) throw new Error('Router UI overflows the window')
  }
  await page.setViewportSize({ width: 1200, height: 1000 })
  await page.goto(base)
  await page.getByRole('button', { name: '不准' }).click()
  await page.getByRole('combobox', { name: '实际工作区' }).selectOption('/workspace/dns-api')
  await page.getByRole('button', { name: '保存并切换工作区' }).waitFor()
  if (!await page.getByRole('button', { name: '保存并切换工作区' }).isEnabled()) throw new Error('Idle correction disabled')
  await page.getByText('DNS资源管理API、配置变更和服务端接口；节点解析运行时由dns-agent处理。').waitFor()
  if (await page.getByRole('spinbutton', { name: 'Router 文本预算' }).inputValue() !== '8192') throw new Error('Budget missing')
  await checkWidth()
  await page.screenshot({ path: 'docs/review/workspace-router/dark-wide.png', fullPage: true })
  await page.getByRole('button', { name: '保存并切换工作区' }).click()
  await page.getByRole('status').filter({ hasText: '已切换工作区' }).waitFor()
  await page.goto(base + '?running=1')
  await page.getByRole('button', { name: '不准' }).click()
  if (await page.getByRole('button', { name: '保存并切换工作区' }).isEnabled()) throw new Error('Running correction enabled')
  if (!await page.getByRole('button', { name: '保存反馈' }).isEnabled()) throw new Error('Feedback blocked')
  await page.screenshot({ path: 'docs/review/workspace-router/running.png', fullPage: true })
  await page.setViewportSize({ width: 640, height: 900 })
  await page.goto(base + '?theme=light')
  await page.getByRole('button', { name: '不准' }).click()
  await checkWidth()
  await page.screenshot({ path: 'docs/review/workspace-router/light-narrow.png', fullPage: true })
}

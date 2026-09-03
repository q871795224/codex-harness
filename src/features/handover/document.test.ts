import { describe, expect, it } from 'vitest'
import {
  extractHandoverSummary,
  renderHandoverDocument,
  type HandoverDocumentValues,
} from './document'
import { DEFAULT_HANDOVER_TEMPLATE } from './templates'

const values: HandoverDocumentValues = {
  docId: 'doc-1',
  sourceThreadId: 'thread-1',
  createdAt: '2026-09-03T10:00:00.000Z',
  templateVersion: 1,
  workspaceRoot: '/repo',
  gitBranch: 'main',
  changedFiles: ' M src/a.ts\n?? src/b.ts',
  title: '会话标题',
  summary: '## 目标\n做事情',
}

describe('extractHandoverSummary', () => {
  it('提取标记内的总结并去掉首尾空白', () => {
    const output = `前言\n<handover-summary>\n## 目标\n做事情\n</handover-summary>\n后记`
    expect(extractHandoverSummary(output)).toBe('## 目标\n做事情')
  })

  it('没有标记时返回 null', () => {
    expect(extractHandoverSummary('## 目标\n做事情')).toBeNull()
  })

  it('只有开标记没有闭标记时返回 null', () => {
    expect(extractHandoverSummary('<handover-summary>内容')).toBeNull()
  })

  it('标记内容为空时返回 null', () => {
    expect(extractHandoverSummary('<handover-summary>   </handover-summary>')).toBeNull()
  })
})

describe('renderHandoverDocument', () => {
  it('填充所有已知占位符', () => {
    const rendered = renderHandoverDocument(DEFAULT_HANDOVER_TEMPLATE, values)
    expect(rendered).toContain('doc_id: doc-1')
    expect(rendered).toContain('continued_from: thread-1')
    expect(rendered).toContain('template_version: 1')
    expect(rendered).toContain('workspace_root: /repo')
    expect(rendered).toContain('git_branch: main')
    expect(rendered).toContain('# 交接：会话标题')
    expect(rendered).toContain('- 工作区：/repo')
    expect(rendered).toContain('- 分支：main')
    expect(rendered).toContain('- 未提交改动： M src/a.ts\n?? src/b.ts')
    expect(rendered).toContain('## 会话总结（主 Agent 生成）\n## 目标\n做事情')
    expect(rendered).not.toContain('{{')
  })

  it('未识别的占位符原样保留', () => {
    const rendered = renderHandoverDocument('{{unknown}} {{title}}', values)
    expect(rendered).toBe('{{unknown}} 会话标题')
  })

  it('空值替换为空字符串', () => {
    const rendered = renderHandoverDocument('branch={{gitBranch}}', { ...values, gitBranch: '' })
    expect(rendered).toBe('branch=')
  })
})

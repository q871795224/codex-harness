/**
 * 交接文档的纯逻辑：模板渲染与总结提取。不依赖 IPC，可单测。
 */

export const HANDOVER_SUMMARY_OPEN = '<handover-summary>'
export const HANDOVER_SUMMARY_CLOSE = '</handover-summary>'

export interface HandoverDocumentValues {
  docId: string
  sourceThreadId: string
  createdAt: string
  templateVersion: number
  workspaceRoot: string
  gitBranch: string
  /** 已格式化好的改动文件清单（每行一条），无改动时由调用方传入占位文本 */
  changedFiles: string
  title: string
  /** 主 Agent 生成的总结正文 */
  summary: string
}

/** 从主 Agent 输出中提取 <handover-summary> 包裹的总结；没有标记时返回 null。 */
export function extractHandoverSummary(agentOutput: string): string | null {
  const start = agentOutput.indexOf(HANDOVER_SUMMARY_OPEN)
  if (start < 0) return null
  const end = agentOutput.indexOf(HANDOVER_SUMMARY_CLOSE, start + HANDOVER_SUMMARY_OPEN.length)
  if (end < 0) return null
  const summary = agentOutput.slice(start + HANDOVER_SUMMARY_OPEN.length, end).trim()
  return summary.length > 0 ? summary : null
}

/**
 * 用 values 填充模板里的 {{placeholder}}。
 * 未识别的占位符原样保留（便于用户自定义模板时逐步扩展），已识别但为空的值替换为空字符串。
 */
export function renderHandoverDocument(template: string, values: HandoverDocumentValues): string {
  const map: Record<string, string> = {
    docId: values.docId,
    sourceThreadId: values.sourceThreadId,
    createdAt: values.createdAt,
    templateVersion: String(values.templateVersion),
    workspaceRoot: values.workspaceRoot,
    gitBranch: values.gitBranch,
    changedFiles: values.changedFiles,
    title: values.title,
    summary: values.summary,
  }
  return template.replace(/\{\{(\w+)\}\}/g, (raw, key: string) => map[key] ?? raw)
}

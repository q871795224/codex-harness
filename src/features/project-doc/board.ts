/**
 * 项目文档看板（场景二）的纯逻辑：把 Status 区按 run 子区聚合 + Log 区按条目聚合。
 * 不依赖 IPC，可单测。解析是展示层的尽力而为（best-effort），与写入侧的 find_section 独立。
 */

/** Status 区里一个 run 的子区（`### run-xxx: 标题`）。 */
export interface RunSection {
  runId: string
  title: string
  body: string
}

export interface ProjectBoard {
  /** Status 区按 run 聚合的子区；无 run 前缀的散内容归到 `shared`。 */
  runs: RunSection[]
  /** Status 区里不属于任何 run 子区的公共内容（原样，可能为空）。 */
  shared: string
  /** Log 区条目（按空行/列表项粗分，新的在前）。 */
  logEntries: string[]
  /** Status / Log 区是否存在（文档缺区时看板给空态提示）。 */
  hasStatus: boolean
  hasLog: boolean
}

const RUN_HEADING = /^###\s+(\S+?)(?::\s*|\s*$)(.*)$/

/** 解析项目文档正文为看板结构。 */
export function parseProjectBoard(content: string): ProjectBoard {
  const statusBody = sectionBody(content, 'Status')
  const logBody = sectionBody(content, 'Log')
  return {
    runs: statusBody !== null ? parseRunSections(statusBody) : [],
    shared: statusBody !== null ? sharedStatusBody(statusBody) : '',
    logEntries: logBody !== null ? parseLogEntries(logBody) : [],
    hasStatus: statusBody !== null,
    hasLog: logBody !== null,
  }
}

/** 取 `## <heading>` 的正文（到下一个同级或更高级标题为止）；没有该 section 返回 null。 */
function sectionBody(content: string, heading: string): string | null {
  const target = `## ${heading}`
  const lines = content.split('\n')
  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trimEnd() === target) {
      start = index + 1
      break
    }
  }
  if (start < 0) return null
  let end = lines.length
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^#{1,2}\s/.test(line)) {
      end = index
      break
    }
  }
  return lines.slice(start, end).join('\n').trim()
}

/** 把 Status 正文按 `### run-xxx` 子区切开。 */
function parseRunSections(statusBody: string): RunSection[] {
  const runs: RunSection[] = []
  let current: RunSection | null = null
  for (const line of statusBody.split('\n')) {
    const match = line.match(RUN_HEADING)
    if (match) {
      current = { runId: match[1], title: match[2].trim(), body: '' }
      runs.push(current)
    } else if (current) {
      current.body += `${line}\n`
    }
  }
  return runs.map((run) => ({ ...run, body: run.body.trim() }))
}

/** Status 正文里第一个 `###` 之前的公共内容。 */
function sharedStatusBody(statusBody: string): string {
  const firstHeading = statusBody.search(/^###\s/m)
  return (firstHeading < 0 ? statusBody : statusBody.slice(0, firstHeading)).trim()
}

/** Log 正文按空行切成条目，新的在前。 */
function parseLogEntries(logBody: string): string[] {
  return logBody
    .split(/\n\s*\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .reverse()
}

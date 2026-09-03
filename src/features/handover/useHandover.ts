import { useCallback } from 'react'
import { threadTitle } from '../../core/domain/codex'
import { runtime } from '../../core/runtime/bridge'
import type { ComposerDraft } from '../conversation/Composer'
import { extractHandoverSummary, renderHandoverDocument, renderHandoverFrontMatter } from './document'
import {
  DEFAULT_HANDOVER_PROMPT,
  DEFAULT_HANDOVER_TEMPLATE,
  HANDOVER_PROMPT_FILE_NAME,
  HANDOVER_TEMPLATE_FILE_NAME,
  HANDOVER_TEMPLATE_VERSION,
} from './templates'

export interface HandoverDeps {
  /** 向指定 thread 发起一个 turn，返回 turnId */
  startTurnInThread: (threadId: string, prompt: string, trigger?: 'handover') => Promise<string>
  /** 订阅 turn 完成事件，返回取消订阅函数 */
  onTurnCompleted: (listener: (event: { threadId: string; turnId: string; status: string }) => void) => () => void
  /** 读取 thread 最近一条非空 agentMessage 文本 */
  readLastAgentMessage: (threadId: string) => Promise<string>
  /** 创建新会话（继承当前 cwd），返回新 thread id */
  createThread: () => Promise<string | undefined>
  /** 预填某个 thread 的输入草稿 */
  setComposerDrafts: (updater: (current: Record<string, ComposerDraft>) => Record<string, ComposerDraft>) => void
  /** 轻提示 */
  notify: (message: string, kind?: 'info' | 'error') => void
  currentThread: { id: string; cwd: string; gitInfo?: { branch?: string | null } | null } | null
  currentThreadTitle: string
}

/**
 * /handover 编排（模式 C / succession）：
 * 主 Agent 生成总结 → Harness 补工作区状态 → 落盘交接文档 → 开新会话并注入草稿 → 血缘。
 *
 * 全程不自动发送新会话的消息；总结只进入草稿（不落 state.sqlite 正文）。
 */
export function useHandover(deps: HandoverDeps) {
  const runHandover = useCallback(async () => {
    const thread = deps.currentThread
    if (!thread) {
      deps.notify('请先选择一个会话再执行 /handover。', 'error')
      return
    }
    if (!thread.cwd) {
      deps.notify('当前会话没有工作区，无法生成交接文档。', 'error')
      return
    }

    // 1. 读取总结指令（首用物化默认，之后以用户文件为准），让主 Agent 在当前会话内生成
    //    带 <handover-summary> 标记的总结。
    const summaryPrompt = await runtime
      .readHandoverTemplate(HANDOVER_PROMPT_FILE_NAME, DEFAULT_HANDOVER_PROMPT)
      .catch(() => DEFAULT_HANDOVER_PROMPT)
    let turnId: string
    try {
      turnId = await deps.startTurnInThread(thread.id, summaryPrompt, 'handover')
    } catch (error) {
      deps.notify(`无法发起交接总结：${messageOf(error)}`, 'error')
      return
    }

    // 2. 等这个 turn 完成。
    try {
      await waitForTurn(deps.onTurnCompleted, thread.id, turnId)
    } catch (error) {
      deps.notify(messageOf(error), 'error')
      return
    }

    // 3. 读回主 Agent 的总结并提取标记内容。
    let summary: string | null = null
    try {
      summary = extractHandoverSummary(await deps.readLastAgentMessage(thread.id))
    } catch (error) {
      deps.notify(`无法读取交接总结：${messageOf(error)}`, 'error')
      return
    }
    if (!summary) {
      deps.notify('未能在总结中找到 <handover-summary> 内容，已中止交接。', 'error')
      return
    }

    // 4. 读取模板（首用物化默认）+ Harness 侧确定性工作区状态（零 token）。
    const template = await runtime.readHandoverTemplate(HANDOVER_TEMPLATE_FILE_NAME, DEFAULT_HANDOVER_TEMPLATE)
    const changedFiles = await runtime.gitChangedFiles(thread.cwd).catch(() => '')

    const docId = crypto.randomUUID()
    const values = {
      docId,
      sourceThreadId: thread.id,
      createdAt: new Date().toISOString(),
      templateVersion: HANDOVER_TEMPLATE_VERSION,
      workspaceRoot: thread.cwd,
      gitBranch: thread.gitInfo?.branch ?? '',
      changedFiles: changedFiles.trim() ? changedFiles : '(无改动)',
      title: deps.currentThreadTitle,
      summary,
    }
    // 注入新会话的只是正文；簿记元数据由 Harness 生成文件头，只落在磁盘文档里。
    const draft = renderHandoverDocument(template, values)
    const document = `${renderHandoverFrontMatter(values)}\n\n${draft}`

    // 5. 落盘交接文档正文到 ~/.codex-harness/handover/<doc-id>.md。
    try {
      await runtime.writeHandoverDocument(`${docId}.md`, document)
    } catch (error) {
      deps.notify(`无法写入交接文档：${messageOf(error)}`, 'error')
      return
    }

    // 6. 开新会话（继承当前 cwd），把正文注入新会话草稿（不自动发送）。
    const newThreadId = await deps.createThread()
    if (!newThreadId) {
      deps.notify('交接文档已生成，但开启新会话失败。', 'error')
      return
    }
    deps.setComposerDrafts((current) => ({
      ...current,
      [newThreadId]: { text: draft, collapsedPastes: [], attachments: [] },
    }))
    deps.notify('已生成交接文档并填入新会话草稿。')
  }, [deps])

  return { runHandover }
}

function waitForTurn(
  onTurnCompleted: HandoverDeps['onTurnCompleted'],
  threadId: string,
  turnId: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const unsubscribe = onTurnCompleted((event) => {
      if (event.threadId !== threadId || event.turnId !== turnId) return
      unsubscribe()
      if (event.status === 'completed') resolve()
      else reject(new Error(`交接总结的轮次未成功完成（${event.status}）`))
    })
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

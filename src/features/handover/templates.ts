/**
 * Handover 默认模板。
 *
 * 首次使用时物化到 ~/.codex-harness/templates/，之后以文件为准（用户可改）。
 * 修改这里的默认值只影响尚未物化的全新安装。
 */

export const HANDOVER_TEMPLATE_VERSION = 2

export const HANDOVER_PROMPT_FILE_NAME = 'handover.prompt.md'
export const HANDOVER_TEMPLATE_FILE_NAME = 'handover.template.md'

/** 发给主 Agent 的总结指令（控制"怎么总结"）。 */
export const DEFAULT_HANDOVER_PROMPT = `你要为当前会话生成一份"交接总结"，供一个全新的 Agent 会话无缝接手继续工作。

要求：
- 只输出结构化总结本身，不要额外寒暄、不要复述本指令。
- 接手方是看不到本会话任何内容的新 Agent 会话：输出必须自包含、可冷启动。
- 决策要写"原因"，失败过的路要明确标注，避免新会话重蹈覆辙。
- 客观、精炼；不要编造本会话里没发生过的结论。
- 把完整总结包裹在 <handover-summary> 与 </handover-summary> 标记之间输出，标记外不要输出其他内容。

按以下结构组织总结内容：

## 目标
本会话要达成什么（1-3 句）。

## 背景与关键上下文
理解后续工作必需的信息；无关闲聊省略。

## 已完成
已做完的事项及结果。

## 关键决策及原因
每个决策一条，附"为什么"。

## 失败/放弃的方案
试过但走不通的路，及原因。

## 当前状态
进行到哪一步，未提交的改动、待办。

## 下一步
建议的接续动作，按优先级。

## 需要避开的坑
约束、易错点、不要做的事。
`

/**
 * 交接文档骨架（控制"新 Agent 看到什么"），占位符由 Harness / 主 Agent 填充。
 *
 * 只包含新会话需要的正文；doc_id / continued_from / created_at / template_version 等
 * 簿记元数据由 Harness 生成文件头（见 document.ts renderHandoverFrontMatter），
 * 不进模板、不进新会话草稿。
 */
export const DEFAULT_HANDOVER_TEMPLATE = `# 交接：{{title}}

## 工作区状态（harness 生成）
- 工作区：{{workspaceRoot}}
- 分支：{{gitBranch}}
- 未提交改动：{{changedFiles}}

## 会话总结（主 Agent 生成）
{{summary}}
`

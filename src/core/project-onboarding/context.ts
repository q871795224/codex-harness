import { textInput, type UserInput } from '../domain/codex'
import type { ProjectDocService } from '../project-docs/types'

export function projectBindingNotice(name: string): string {
  return `当前会话已加入项目「${name.replace(/\s+/g, ' ').trim()}」。继续前请调用 harness_project_read 读取最新项目文档。`
}

/** Notify native-tool conversations to read on demand; legacy conversations
 * deliver the background before their pending binding can be locked. */
export async function prepareProjectInput(docs: ProjectDocService, threadId: string, input: UserInput[], threshold: number, nativeTools = false) {
  const binding = await docs.threadBinding(threadId)
  if (!binding || binding.phase !== 'pending') return { input, projectId: null }
  if (nativeTools) {
    const project = await docs.get(binding.projectId)
    const notice = projectBindingNotice(project.name)
    const present = input.some(item => item.type === 'text' && item.text.includes(notice))
    return { input: present ? input : [textInput(notice), ...input], projectId: binding.projectId }
  }
  const marker = `<!-- project-doc: project_id=${binding.projectId} thread_id=${threadId} -->`
  if (input.some(item => item.type === 'text' && item.text.includes(marker))) return {input,projectId:binding.projectId}
  const context = await docs.context(binding.projectId, threshold)
  return {input:[textInput(`${marker}\n\n${context.content}`),...input],projectId:binding.projectId}
}

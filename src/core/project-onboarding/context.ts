import { textInput, type UserInput } from '../domain/codex'
import type { ProjectDocService } from '../project-docs/types'

/** Native-tool conversations resolve context on demand; legacy conversations
 * must deliver the background before their pending binding can be locked. */
export async function prepareProjectInput(docs: ProjectDocService, threadId: string, input: UserInput[], threshold: number, nativeTools = false) {
  const binding = await docs.threadBinding(threadId)
  if (!binding || binding.phase !== 'pending') return { input, projectId: null }
  if (nativeTools) return { input, projectId: binding.projectId }
  const marker = `<!-- project-doc: project_id=${binding.projectId} thread_id=${threadId} -->`
  if (input.some(item => item.type === 'text' && item.text.includes(marker))) return {input,projectId:binding.projectId}
  const context = await docs.context(binding.projectId, threshold)
  return {input:[textInput(`${marker}\n\n${context.content}`),...input],projectId:binding.projectId}
}

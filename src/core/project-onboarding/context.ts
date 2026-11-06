import { textInput, type UserInput } from '../domain/codex'
import type { ProjectDocService } from '../project-docs/types'

/** A just-finished binding can precede React's background-card effect. Never lock
 * that binding until its context really travelled with a successful message. */
export async function prepareProjectInput(docs: ProjectDocService, threadId: string, input: UserInput[], threshold: number) {
  const binding = await docs.threadBinding(threadId)
  if (!binding || binding.phase !== 'pending') return { input, projectId: null }
  const marker = `<!-- project-doc: project_id=${binding.projectId} thread_id=${threadId} -->`
  if (input.some(item => item.type === 'text' && item.text.includes(marker))) return {input,projectId:binding.projectId}
  const context = await docs.context(binding.projectId, threshold)
  return {input:[textInput(`${marker}\n\n${context.content}`),...input],projectId:binding.projectId}
}

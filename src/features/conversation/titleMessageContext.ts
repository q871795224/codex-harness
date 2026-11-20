// Resolve references for the independent title task, without changing the main turn.
export async function titleMessageContext(
  userText: string,
  read: (reference: string) => Promise<string>,
): Promise<{ userText: string; messageContext?: string }> {
  const references = [...new Set(userText.match(/seatalk:\/\/conversation\?[^\s<>"\'`()\[\]\u3000-\u303f\uff00-\uffef]+/gi) ?? [])].slice(0, 3)
  if (!references.length) return { userText }
  const results = await Promise.all(references.map(async reference => {
    try { return (await read(reference)).trim() } catch { return '' }
  }))
  const budget = Math.floor(4_000 / references.length)
  const contexts: string[] = []
  let source = userText
  results.forEach((text, index) => {
    if (!text) return
    const label = `[SeaTalk 消息 ${index + 1}]`
    source = source.split(references[index]).join(label)
    contexts.push(`${label}\n${text.slice(0, Math.max(0, budget - label.length - 2))}`)
  })
  return contexts.length ? { userText: source, messageContext: contexts.join('\n\n').slice(0, 4_000) } : { userText }
}

// These phrases carry little project information. Replace before making bigrams
// so phrases such as 现在有个问题 do not leave matching fragments across words.
const COMMON_PHRASES = /有个|现在|已经|问题|需要/g
const GENERIC_NAMES = new Set(['测试', '通用', 'test', 'general'])

/** Keep examples about the explicitly shared project together when available. */
export function projectScopedExamples<T extends { projectMatches: number }>(examples: T[]): T[] {
  return examples.some(example => example.projectMatches > 0)
    ? examples.filter(example => example.projectMatches > 0)
    : examples
}

function terms(text: string): Set<string> {
  const tokens = text.toLowerCase().replace(COMMON_PHRASES, ' ').match(/[a-z][a-z0-9_-]{2,}|[\u4e00-\u9fff]{2,}/g) ?? []
  return new Set(tokens.flatMap(token => /[\u4e00-\u9fff]/.test(token)
    ? Array.from({ length: token.length - 1 }, (_, i) => token.slice(i, i + 2))
    : [token]))
}

/** Ranks reference material only; it never selects the task's workspace. */
export function routerExampleRelevance(query: string, candidates: ReadonlyArray<{ name: string }>) {
  const queryTerms = terms(query)
  const projects = [...new Set(candidates.map(candidate => candidate.name.trim().toLowerCase()))]
    .filter(name => name.length >= 2 && !GENERIC_NAMES.has(name))
    .map(name => {
      const escaped = name.split(/[\s_-]+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s_-]*')
      return new RegExp('(^|[^a-z0-9_-])' + escaped + '(?=$|[^a-z0-9_-])', 'i')
    })
    .filter(pattern => pattern.test(query))
  return (request: string) => ({
    projectMatches: projects.filter(pattern => pattern.test(request)).length,
    overlap: [...terms(request)].filter(term => queryTerms.has(term)).length,
  })
}

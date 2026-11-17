import { expect, it } from 'vitest'
import { routerExampleRelevance } from './relevance'

const candidates = [{ name: 'dns-api' }, { name: 'dns-agent' }, { name: '测试' }]

it('recognizes shared workspace names in repository URLs and spaced product names', () => {
  const score = routerExampleRelevance('DNS API 的发布情况', candidates)
  expect(score('https://git.example/team/dns-api.git 的流水线')).toMatchObject({ projectMatches: 1 })
  expect(score('检查 dns-api-extra 的流水线')).toMatchObject({ projectMatches: 0 })
  expect(score('检查 other-dns-api 的流水线')).toMatchObject({ projectMatches: 0 })
})

it('does not turn generic workspace names into project-specific evidence', () => {
  const score = routerExampleRelevance('测试一下这个问题', candidates)
  expect(score('测试结果需要查看')).toMatchObject({ projectMatches: 0 })
})

it('retains content terms while removing only the agreed common phrases', () => {
  const score = routerExampleRelevance('dns-api 的 skill 需要升级', candidates)
  expect(score('skill 升级')).toEqual({ projectMatches: 0, overlap: 2 })
  expect(score('现在有个问题已经需要看看')).toEqual({ projectMatches: 0, overlap: 0 })
})

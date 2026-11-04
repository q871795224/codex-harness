import { describe, expect, it } from 'vitest'
import { parseQuestionLink } from './links'
import { questionNotifications } from './notifications'
import { createQuestionDrafts } from './drafts'
import type { ApprovalRequest } from '../domain/codex'

const request: ApprovalRequest = { id: 7, threadId: 'thread', method: 'item/tool/requestUserInput', params: {turnId: 'turn', questions:[
  {id:'q1',question:'Choose',options:[{label:'A'},{label:'B'}]}, {id:'q2',question:'Secret content',isSecret:true,options:[{label:'private'}]},
]} }
describe('question notification and link contract', () => {
  it('creates one card per question and keeps sensitive text and answers local', async () => {
    const cards = await questionNotifications({request,title:'Session'})
    expect(cards).toHaveLength(2)
    expect(cards[0].locator).toMatchObject({thread:'thread',turn:'turn',request:'7',kind:'tool',question:'q1'})
    expect(cards[0].options).toEqual(['A','B'])
    expect(cards[1].options).toEqual([])
    expect(JSON.stringify(cards[1])).not.toContain('Secret content')
    expect(JSON.stringify(cards[1])).not.toContain('private')
    const copy = await questionNotifications({request,title:'Renamed'})
    expect(copy.map(c=>c.locator)).toEqual(cards.map(c=>c.locator))
    const asyncCards = await questionNotifications({request:{...request,method:'harness/asyncUserInput'},title:'Session'})
    expect(asyncCards[0].locator.kind).toBe('async')
  })
  it('keeps the same question identity when reconnect changes the JSON-RPC id', async () => {
    const original = {...request, params: {...request.params, itemId:'stable-tool-item'}}
    const first = await questionNotifications({request:original,title:'Session'})
    const replay = await questionNotifications({request:{...original,id:99},title:'Session'})
    expect(first.map(card=>card.locator)).toEqual(replay.map(card=>card.locator))
    expect(first[0].locator.request).toBe('stable-tool-item')
  })
  it('only accepts locator fields, with answer indexes rather than content', async () => {
    const [card] = await questionNotifications({request,title:'Session'})
    const url=new URL('codex-harness://question')
    for (const [key,value] of Object.entries(card.locator)) url.searchParams.set(key,String(value))
    url.searchParams.set('option','1')
    expect(parseQuestionLink(url.href)).toEqual({...card.locator,option:1})
    for (const [key,value] of [['submit','true'],['option','-1'],['revision','old'],['kind','execute']]) {
      const invalid=new URL(url);invalid.searchParams.set(key,value);expect(()=>parseQuestionLink(invalid.href)).toThrow()
    }
    const duplicated=new URL(url);duplicated.searchParams.append('request','8');expect(()=>parseQuestionLink(duplicated.href)).toThrow()
    expect(()=>parseQuestionLink(url.href.replace('codex-harness:','https:'))).toThrow()
  })
})
describe('unsent question answers', () => {
  it('restores drafts, appends on a new line, isolates questions and clears only after explicit success', async () => {
    const saved=new Map<string,string>([['a',JSON.stringify({q1:{value:'existing',other:true}})]])
    const store=createQuestionDrafts({load:async k=>saved.get(k)??null,save:async(k,v)=>{saved.set(k,v)}})
    await store.load('a',new Set())
    await store.append('a','q1','A',new Set())
    await store.append('a','q2','B',new Set())
    expect(store.snapshot('a')).toEqual({q1:{value:'existing\nA',other:true},q2:{value:'B',other:false}})
    expect(store.snapshot('another-session')).toEqual({})
    await store.clear('a');expect(JSON.parse(saved.get('a')!)).toEqual({})
  })
  it('never persists secret answers and preserves edits during delayed hydration', async () => {
    let resolve!: (value:string)=>void
    let saved=''
    const store=createQuestionDrafts({load:()=>new Promise<string>(r=>{resolve=r}),save:async(_,v)=>{saved=v}})
    const loading=store.load('a',new Set(['secret']))
    store.update('a','q1',{value:'typed',other:true},new Set(['secret']))
    store.update('a','secret',{value:'token',other:true},new Set(['secret']))
    resolve(JSON.stringify({q1:{value:'old',other:true},secret:{value:'old-token',other:true}}));await loading
    await store.append('a','q1','A',new Set(['secret']))
    expect(store.snapshot('a').q1.value).toBe('typed\nA')
    expect(store.snapshot('a').secret.value).toBe('token')
    expect(saved).not.toContain('token')
  })
})

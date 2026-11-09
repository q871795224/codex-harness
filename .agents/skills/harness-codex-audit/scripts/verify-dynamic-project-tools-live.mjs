// Explicit real-model smoke test: node verify-dynamic-project-tools-live.mjs --live
// Uses existing Provider authentication and an ephemeral thread; no real project documents.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
if(!process.argv.includes('--live')) throw new Error('Pass --live to authorize this real-model smoke test.');
const cwd=await mkdtemp(join(tmpdir(),'harness-live-tool-'));
const child=spawn('codex',['app-server','--listen','stdio://'],{cwd,env:process.env,stdio:['pipe','pipe','pipe']});
const pending=new Map(), bindings=new Map(),callbacks=[],notes=[],usage=[];let id=1;
const nonce='DOCUMENT_'+randomUUID();
const send=v=>child.stdin.write(JSON.stringify(v)+'\n');
const rl=createInterface({input:child.stdout}); child.stderr.on('data',()=>{});
rl.on('line',line=>{const m=JSON.parse(line);if(m.id&&pending.has(m.id)&&!m.method){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);return;}
 if(m.method==='item/tool/call'){callbacks.push(m.params);const text=bindings.get(m.params.threadId);send({id:m.id,result:{success:!!text,contentItems:[{type:'inputText',text:text??'unknown conversation'}]}});}
 else if(m.method==='thread/tokenUsage/updated')usage.push(m.params.tokenUsage.last);
 else if(m.method==='item/tool/requestUserInput')send({id:m.id,result:{answers:{}}});
 else notes.push(m);
});
const rpc=(method,params)=>new Promise((resolve,reject)=>{const n=id++;pending.set(n,{resolve,reject});send({id:n,method,params});setTimeout(()=>{if(pending.delete(n))reject(new Error('RPC timeout '+method));},20000).unref();});
const limit=setTimeout(()=>child.kill(),90000);
try{
 await rpc('initialize',{clientInfo:{name:'harness-dynamic-live-smoke',version:'1'},capabilities:{experimentalApi:true}});send({method:'initialized'});
 const t=await rpc('thread/start',{cwd,model:'gpt-6.1-sol',ephemeral:true,approvalPolicy:'never',sandbox:'read-only',dynamicTools:[{type:'function',name:'harness_project_read',description:'Read the current project document. Harness resolves the document from the calling conversation; no identity arguments are needed.',inputSchema:{type:'object',properties:{},additionalProperties:false}}]});
 bindings.set(t.thread.id,nonce);
 await rpc('turn/start',{threadId:t.thread.id,effort:'low',input:[{type:'text',text:'Integration smoke test. Call harness_project_read with {} exactly once, then reply with only the exact document text returned by that tool. Do not use other tools.'}]});
 const end=Date.now()+75000;while(!notes.some(m=>m.method==='turn/completed')&&Date.now()<end)await new Promise(r=>setTimeout(r,50));
 const completed=notes.find(m=>m.method==='turn/completed');assert.equal(completed?.params.turn.status,'completed');
 assert.equal(callbacks.length,1);assert.deepEqual(callbacks[0].arguments,{});assert.equal(callbacks[0].threadId,t.thread.id);assert.ok(callbacks[0].turnId&&callbacks[0].callId);
 const messages=notes.filter(m=>m.method==='item/completed'&&m.params.item.type==='agentMessage');assert.ok(messages.some(m=>m.params.item.text.trim()===nonce),'model must use the returned document');
 console.log(JSON.stringify({backend:'real configured model provider',model:'gpt-6.1-sol',ephemeral:true,toolCallbacks:callbacks.length,emptyArguments:true,envelopeIdentity:true,modelUsedReturnedDocument:true,usage},null,2));
}finally{clearTimeout(limit);child.stdin.end();child.kill();rl.close();await rm(cwd,{recursive:true,force:true});}

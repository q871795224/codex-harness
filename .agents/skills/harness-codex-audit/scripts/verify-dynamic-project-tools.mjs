// Opt-in native protocol probe. Requires codex on PATH; uses only temporary state and a loopback model fixture.
// No real model calls or connection to the shared daemon. Prints metadata and assertions only.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn, execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
const root = await mkdtemp(join(tmpdir(),'harness-dynamic-'));
const home=join(root,'home'), cwd=join(root,'workspace');
await mkdir(join(home,'.codex'),{recursive:true}); await mkdir(cwd);
let requests=0, callbacks=0; const outputs=[], bindings=new Map();
const server=createServer(async(req,res)=>{
 let text=''; for await(const b of req) text+=b;
 if(!req.url.includes('/responses')) {res.writeHead(200,{'content-type':'application/json'});res.end('{"data":[]}');return;}
 const body=JSON.parse(text); requests++;
 const tools=JSON.stringify(body.tools);assert.ok(tools.includes('harness_project_read'),'tool reaches upstream model');
 const last=body.input.at(-1);
 const isOutput=last?.type==='function_call_output';
 if(isOutput) outputs.push(last.output);
 const item=isOutput ? {type:'message',id:'msg_'+requests,role:'assistant',status:'completed',content:[{type:'output_text',text:'OK',annotations:[]}]} : {type:'function_call',id:'fc_'+requests,call_id:'call_'+requests,name:'harness_project_read',arguments:'{}',status:'completed'};
 res.writeHead(200,{'content-type':'text/event-stream'});
 for(const [type,data] of [
  ['response.created',{response:{id:'resp_'+requests,status:'in_progress',output:[]}}],
  ['response.output_item.added',{output_index:0,item:{...item,status:'in_progress'}}],
  ['response.output_item.done',{output_index:0,item}],
  ['response.completed',{response:{id:'resp_'+requests,status:'completed',output:[item],usage:{input_tokens:10,output_tokens:1,total_tokens:11}}}],
 ]) res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
 res.end();
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const env=Object.fromEntries(['PATH','TMPDIR','LANG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
const args=['app-server','--listen','stdio://','-c','model_provider="fixture"','-c',`model_providers.fixture={name="fixture",base_url="http://127.0.0.1:${server.address().port}",wire_api="responses",requires_openai_auth=false}`,'-c','model="gpt-5.1-codex"','-c','check_for_update_on_startup=false'];
let child,rl,next=1;const pending=new Map(),notes=[];
async function start(){
 child=spawn('codex',args,{env:{...env,HOME:home,CODEX_HOME:join(home,'.codex')},cwd,stdio:['pipe','pipe','pipe']});
 child.stderr.on('data',()=>{});rl=createInterface({input:child.stdout});
 rl.on('line',line=>{const j=JSON.parse(line);if(j.id&&pending.has(j.id)&&!j.method){const p=pending.get(j.id);pending.delete(j.id); j.error?p.reject(new Error(JSON.stringify(j.error))):p.resolve(j.result);}
 else if(j.method==='item/tool/call') {callbacks++; assert.equal(j.params.tool,'harness_project_read');assert.ok(j.params.namespace == null);assert.deepEqual(j.params.arguments,{}); assert.ok(j.params.turnId&&j.params.callId);const content=bindings.get(j.params.threadId); assert.ok(content);send({id:j.id,result:{success:true,contentItems:[{type:'inputText',text:content}]}});}
 else notes.push(j);});
 await rpc('initialize',{clientInfo:{name:'harness-dynamic-probe',version:'1'},capabilities:{experimentalApi:true}});send({method:'initialized'});
}
function send(v){child.stdin.write(JSON.stringify(v)+'\n');}
function rpc(method,params){return new Promise((resolve,reject)=>{const id=next++;pending.set(id,{resolve,reject});send({id,method,params});setTimeout(()=>{if(pending.delete(id))reject(new Error('timeout: '+method));},15000).unref();});}
async function turn(id){const count=notes.filter(n=>n.method==='turn/completed').length;await rpc('turn/start',{threadId:id,input:[{type:'text',text:'Read the current project using the provided tool.'}]});const end=Date.now()+20000;while(notes.filter(n=>n.method==='turn/completed').length===count&&Date.now()<end)await new Promise(r=>setTimeout(r,25));assert.equal(notes.filter(n=>n.method==='turn/completed').at(-1)?.params.turn.status,'completed');}
async function stop(){const p=child; p.stdin.end(); await new Promise(r=>{p.once('exit',r);setTimeout(()=>p.kill(),2000).unref();});rl.close();}
try{
 await start();
 const spec={type:'function',name:'harness_project_read',description:'Read the project document for the calling conversation. No identity arguments are needed.',inputSchema:{type:'object',properties:{},additionalProperties:false}};
 const ids=[];
 for(const doc of ['PROJECT_ALPHA_DOCUMENT','PROJECT_BETA_DOCUMENT']){const r=await rpc('thread/start',{cwd,model:'gpt-5.1-codex',approvalPolicy:'never',sandbox:'read-only',dynamicTools:[spec]});ids.push(r.thread.id);bindings.set(r.thread.id,doc); await turn(r.thread.id);}
 await stop();await start();
 await rpc('thread/resume',{threadId:ids[0],excludeTurns:true}); await turn(ids[0]);
 const fork=await rpc('thread/fork',{threadId:ids[0],excludeTurns:true});bindings.set(fork.thread.id,'PROJECT_ALPHA_DOCUMENT');await turn(fork.thread.id);
 assert.deepEqual(outputs,['PROJECT_ALPHA_DOCUMENT','PROJECT_BETA_DOCUMENT','PROJECT_ALPHA_DOCUMENT','PROJECT_ALPHA_DOCUMENT']);
 console.log(JSON.stringify({version:execFileSync('codex',['--version'],{encoding:'utf8'}).trim(),backend:'isolated loopback fixture',toolCallbacks:callbacks,modelRequests:requests,separateThreadMapping:true,processRestartResume:true,forkInheritsTools:true,modelReceivedToolResults:true},null,2));
}finally{if(child?.exitCode===null)await stop();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}

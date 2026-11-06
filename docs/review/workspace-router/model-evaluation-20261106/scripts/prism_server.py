import os,time,json,threading,pathlib
import torch
from fastapi import FastAPI,HTTPException
from transformers import AutoTokenizer,AutoModelForCausalLM
import uvicorn
D=pathlib.Path(__file__).resolve().parent
P=D/'models/prism08'
torch.set_num_threads(16);torch.set_num_interop_threads(1)
tokenizer=AutoTokenizer.from_pretrained(P,local_files_only=True,padding_side='left')
model=AutoModelForCausalLM.from_pretrained(P,local_files_only=True,dtype=torch.float32,attn_implementation='sdpa').eval()
yes=tokenizer.encode('yes',add_special_tokens=False)[0];no=tokenizer.encode('no',add_special_tokens=False)[0]
# Use the exact template shipped with the pinned weights.
import hashlib
template_sha256=hashlib.sha256(tokenizer.chat_template.encode()).hexdigest()
def prompt(q,d):return tokenizer.apply_chat_template([{'role':'query','content':q},{'role':'document','content':d}],tokenize=False)
app=FastAPI(title='Prism router evaluation');lock=threading.Lock()
@app.get('/health')
def health():return {'status':'ok','model':'Prism-Qwen3.5-Reranker-0.8B','dtype':'fp32','device':'cpu','threads':16,'max_length':10000,'batch_size':4,'template_sha256':template_sha256,'template_version':'native-v2'}
@app.post('/rerank')
def rerank(body:dict):
 start=time.perf_counter();q=body.get('query');docs=body.get('documents')
 if not isinstance(q,str) or not isinstance(docs,list) or not 1<=len(docs)<=64 or not all(isinstance(d,str) for d in docs):raise HTTPException(422,'query string and 1-64 documents required')
 texts=[prompt(q,d) for d in docs];ids=[tokenizer.encode(t,add_special_tokens=False) for t in texts];counts=list(map(len,ids))
 if max(counts)>10000:raise HTTPException(422,'input exceeds validated 10000 token bound; not truncated')
 scores=[]
 with lock,torch.inference_mode():
  for start_i in range(0,len(ids),4):
   batch=tokenizer.pad({'input_ids':ids[start_i:start_i+4]},padding=True,return_tensors='pt')
   logits=model(**batch,logits_to_keep=1,use_cache=False).logits[:,-1,:].float()
   scores.extend(torch.softmax(logits[:,[no,yes]],dim=-1)[:,1].tolist())
 return {'model':'Prism-Qwen3.5-Reranker-0.8B','scores':scores,'input_tokens':sum(counts),'pair_tokens':counts,'truncated':False,'template_sha256':template_sha256,'template_version':'native-v2','latency_ms':1000*(time.perf_counter()-start)}
if __name__=='__main__':uvicorn.run(app,host='127.0.0.1',port=16603,access_log=False)

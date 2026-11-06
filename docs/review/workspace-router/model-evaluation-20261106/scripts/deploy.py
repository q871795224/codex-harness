import os,sys,json,pathlib,subprocess,time,traceback,datetime
D=pathlib.Path(__file__).resolve().parent
STATUS=D/'deployment-status.json'
def status(stage,**kw):
 x={'stage':stage,'at':datetime.datetime.now().astimezone().isoformat(),**kw};tmp=STATUS.with_suffix('.tmp');tmp.write_text(json.dumps(x,ensure_ascii=False,indent=2));tmp.replace(STATUS);print(json.dumps(x,ensure_ascii=False),flush=True)
def run(args,env=None):
 print('RUN',args,flush=True);subprocess.run(args,cwd=D,env=env,check=True)
try:
 status('creating isolated environment')
 if not (D/'venv/bin/python').exists():run(['/usr/bin/python3.12','-m','venv',str(D/'venv')])
 py=str(D/'venv/bin/python');site=D/'venv/lib/python3.12/site-packages';site.mkdir(parents=True,exist_ok=True)
 # Read shared packages without modifying the Laya installation. Local venv packages take precedence.
 (site/'laya-readonly-deps.pth').write_text('/home/toc/SDE/laya-service/venv/lib/python3.12/site-packages\n')
 env={**os.environ,'PIP_DISABLE_PIP_VERSION_CHECK':'1','CMAKE_BUILD_PARALLEL_LEVEL':'8','HF_HUB_DISABLE_XET':'1','HF_HUB_DOWNLOAD_TIMEOUT':'120','HF_HUB_ETAG_TIMEOUT':'30','OMP_NUM_THREADS':'16','MKL_NUM_THREADS':'16','TOKENIZERS_PARALLELISM':'false','HF_HOME':str(D/'hf-cache')}
 status('installing CPU inference dependencies and downloading weights')
 downloader=subprocess.Popen([py,str(D/'download_models.py')],env=env,cwd=D)
 (D/'download.pid').write_text(str(downloader.pid))
 run([py,'-m','pip','install','--upgrade','cmake','ninja','scikit-build-core','llama-cpp-python>=0.3.36,<0.4','--extra-index-url','https://abetlen.github.io/llama-cpp-python/whl/cpu'],env)
 source=D/'chinese-decision'
 if not (source/'.git').exists():run(['git','clone','--depth','1','https://github.com/yanqiangmiffy/chinese-decision.git',str(source)],env)
 run([py,'-m','pip','install','--no-deps','-e',str(source)],env)
 revision=subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip()
 status('downloading model weights',source_revision=revision)
 if downloader.wait()!=0:raise RuntimeError('model download failed; see deployment.log')
 status('starting model services',source_revision=revision)
 commands=[('decision08',16601,[py,str(source/'scripts/serve.py'),'--base',str(D/'models/decision08'),'--backend','gguf','--gguf',str(D/'models/decision08/chinese-decision-0.8b-Q8_0.gguf'),'--threads','16','--context-size','16384','--host','127.0.0.1','--port','16601']),('decision2',16602,[py,str(source/'scripts/serve.py'),'--base',str(D/'models/decision2'),'--backend','gguf','--gguf',str(D/'models/decision2/chinese-decision-2b-Q8_0.gguf'),'--threads','16','--context-size','16384','--host','127.0.0.1','--port','16602']),('prism08',16603,[py,str(D/'prism_server.py')])]
 pids={}
 for name,port,args in commands:
  log=open(D/(name+'.log'),'a');proc=subprocess.Popen(args,cwd=source,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True);pids[name]={'pid':proc.pid,'port':port,'args':args};(D/'services.json').write_text(json.dumps(pids,indent=2))
 import urllib.request
 pending={name:port for name,port,_ in commands}
 deadline=time.monotonic()+900
 while pending and time.monotonic()<deadline:
  for name,port in list(pending.items()):
   try:
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/health',timeout=3) as r:health=json.load(r)
    pids[name]['health']=health;del pending[name]
   except Exception:pass
  (D/'services.json').write_text(json.dumps(pids,indent=2));status('loading services',pending=list(pending))
  if pending:time.sleep(10)
 if pending:raise RuntimeError('Model services failed readiness: '+str(pending))
 status('ready',services=pids,source_revision=revision)
except Exception as e:
 status('failed',error=f'{type(e).__name__}: {e}');traceback.print_exc();sys.exit(1)

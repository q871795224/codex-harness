import pathlib,json,os,signal,subprocess,time,urllib.request,sys
D=pathlib.Path(__file__).resolve().parent
registry=json.load(open(D/'services.json'));action=sys.argv[1] if len(sys.argv)>1 else 'status'
if action not in ['status','start','stop']:raise SystemExit('usage: manage_services.py status|start|stop [decision08|decision2|prism08]')
names=sys.argv[2:] or list(registry)
for name in names:
 if name not in registry:raise SystemExit('unknown service '+name)
 record=registry[name];pid=record['pid'];port=record['port']
 def owned():
  try:return str(D).encode() in pathlib.Path(f'/proc/{pid}/cmdline').read_bytes()
  except FileNotFoundError:return False
 def health():
  try:
   with urllib.request.urlopen(f'http://127.0.0.1:{port}/health',timeout=3) as r:return json.load(r)
  except Exception:return None
 if action=='stop':
  if owned():
   os.kill(pid,signal.SIGTERM)
   for _ in range(50):
    if not owned():break
    time.sleep(.1)
   if owned():raise SystemExit(f'{name} did not stop; no force kill performed')
 elif action=='start' and not owned():
  if health():raise SystemExit(f'Port {port} has an unowned service; refusing to start')
  env={**os.environ,'HF_HOME':str(D/'hf-cache'),'OMP_NUM_THREADS':'16','MKL_NUM_THREADS':'16','TOKENIZERS_PARALLELISM':'false'}
  with open(D/(name+'.log'),'a') as log:
   proc=subprocess.Popen(record['args'],cwd=D/'chinese-decision',env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  record['pid']=proc.pid;pid=proc.pid
 print(json.dumps({'name':name,'pid':record['pid'],'port':port,'owned':owned(),'health':health()},ensure_ascii=False))
if action=='start':(D/'services.json').write_text(json.dumps(registry,ensure_ascii=False,indent=2))

import pathlib,subprocess,json,urllib.request,time,hashlib,datetime
D=pathlib.Path('/home/toc/SSE/harness-router-eval-20261106')
p=pathlib.Path('/etc/nginx/conf.d/dns-console.conf')
before=p.read_text();backup=D/'nginx-before-router-integration.conf'
if not backup.exists():backup.write_text(before)
marker='    # Harness Chinese Decision 2B'
block='''    # Harness Chinese Decision 2B; keep the existing Laya route unchanged.
    location ^~ /harness-router/decision2/ {
        proxy_pass http://127.0.0.1:16602/;
        proxy_http_version 1.1;
        proxy_connect_timeout 5s;
        proxy_read_timeout 65s;
        proxy_send_timeout 65s;
        client_max_body_size 1m;
    }

'''
if marker not in before:
 assert 'server_name 10.251.137.89;' in before and 'location ^~ /laya/' in before
 after=before.replace('    # Laya CPU decision API;',block+'    # Laya CPU decision API;',1)
 assert after!=before
 tmp=D/'nginx-router-integration.conf';tmp.write_text(after)
 subprocess.run(['sudo','-n','cp',str(tmp),str(p)],check=True)
 check=subprocess.run(['sudo','-n','nginx','-t'])
 if check.returncode:
  subprocess.run(['sudo','-n','cp',str(backup),str(p)],check=True);raise RuntimeError('nginx validation failed; original restored')
 subprocess.run(['sudo','-n','nginx','-s','reload'],check=True)
# Revert the direct-port probe; only nginx exposes the selected model.
registry=json.loads((D/'services.json').read_text());args=registry['decision2']['args'];pos=args.index('--host')+1
if args[pos]!='127.0.0.1':
 subprocess.run([str(D/'venv/bin/python'),str(D/'manage_services.py'),'stop','decision2'],check=True)
 args[pos]='127.0.0.1';(D/'services.json').write_text(json.dumps(registry,indent=2))
 subprocess.run([str(D/'venv/bin/python'),str(D/'manage_services.py'),'start','decision2'],check=True)
for attempt in range(40):
 try:
  with urllib.request.urlopen('http://127.0.0.1:16602/health',timeout=2) as r:health=json.load(r)
  assert health['model']=='chinese-decision-2b';break
 except Exception:
  if attempt==39:raise
  time.sleep(1)
with urllib.request.urlopen('http://127.0.0.1:16565/readyz',timeout=3) as r:laya=json.load(r)
x={'observed_at':datetime.datetime.now().astimezone().isoformat(),'endpoint':'http://10.251.137.89:5050/harness-router/decision2','decision_health':health,'laya_readyz':laya,'nginx_before_sha256':hashlib.sha256(backup.read_bytes()).hexdigest(),'nginx_after_sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'services_current':json.loads((D/'services.json').read_text())}
(D/'router-integration.json').write_text(json.dumps(x,indent=2));print(json.dumps(x))

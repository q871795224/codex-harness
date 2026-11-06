import pathlib,json,subprocess,platform,hashlib,datetime,importlib.metadata,urllib.request
D=pathlib.Path(__file__).resolve().parent
meta={"observed_at":datetime.datetime.now().astimezone().isoformat(),"platform":platform.platform(),"cpu":subprocess.check_output(["lscpu"],text=True),"packages":{p:importlib.metadata.version(p) for p in ["torch","transformers","huggingface-hub","llama-cpp-python","fastapi","uvicorn"]},"deployment":json.load(open(D/"deployment-status.json")),"services_current":json.load(open(D/"services.json")),"scripts_sha256":{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in D.glob("*.py")},"models":{}}
for name in ["decision08","decision2","prism08"]:
 p=D/"models"/name
 meta["models"][name]={"download":json.load(open(D/(name+"-download.json"))),"files":[{"name":f.name,"size":f.stat().st_size,"sha256":hashlib.sha256(f.read_bytes()).hexdigest()} for f in p.iterdir() if f.is_file() and f.suffix in [".gguf",".safetensors"]]}
for name,service in meta["services_current"].items():
 with urllib.request.urlopen(f'http://127.0.0.1:{service["port"]}/health',timeout=5) as response:service["health"]=json.load(response)
(D/"environment.json").write_text(json.dumps(meta,ensure_ascii=False,indent=2));print("metadata saved")

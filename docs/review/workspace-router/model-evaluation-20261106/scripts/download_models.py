import json,pathlib,datetime
from huggingface_hub import snapshot_download
D=pathlib.Path(__file__).resolve().parent
specs=[('decision08','quincyqiang/chinese-decision-0.8b-gguf','890ffc6791c383107614f21b30f41669b8adb117'),('decision2','quincyqiang/chinese-decision-2b-gguf','2357aa9aad05cbd87bcfc11a1b74e5705e3b5bbc'),('prism08','infgrad/Prism-Qwen3.5-Reranker-0.8B','c60729783cb2f0662c0b054a02964402a211e3f4')]
for name,repo,revision in specs:
 print('DOWNLOAD',name,repo,revision,flush=True)
 snapshot_download(repo_id=repo,revision=revision,local_dir=str(D/'models'/name),allow_patterns=['*.json','*.jinja','*.txt','*.gguf','*.safetensors','README.md','LICENSE','LICENSES/*','THIRD_PARTY_NOTICES.md'],max_workers=3)
 (D/(name+'-download.json')).write_text(json.dumps({'repo':repo,'revision':revision,'finished_at':datetime.datetime.now().astimezone().isoformat()},indent=2))
 print('DONE',name,flush=True)

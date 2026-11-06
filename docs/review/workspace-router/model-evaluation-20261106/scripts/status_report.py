import json,pathlib,statistics,math,collections
D=pathlib.Path(__file__).resolve().parent
p=D/'results.jsonl';rows=[]
if p.exists():
 for line in p.read_text().splitlines():
  try:rows.append(json.loads(line))
  except json.JSONDecodeError:pass
summary=[]
for key,a0 in __import__('itertools').groupby(sorted(rows,key=lambda r:(r['model'],r['mode'])),key=lambda r:(r['model'],r['mode'])):
 a=list(a0);ts=sorted(r['seconds'] for r in a);h=[r for r in a if r['source'].startswith('historical')];s=[r for r in a if r['source'].startswith('synthetic')]
 summary.append({'model':key[0],'mode':key[1],'calls':len(a),'correct':sum(r['correct'] for r in a),'historical_correct':sum(r['correct'] for r in h),'historical_total':len(h),'synthetic_correct':sum(r['correct'] for r in s),'synthetic_total':len(s),'errors':sum(not r['ok'] for r in a),'mean_s':statistics.mean(ts),'p50_s':statistics.median(ts),'p95_nearest_rank_s':ts[math.ceil(len(ts)*.95)-1],'input_tokens_min':min(r.get('input_tokens',0) for r in a),'input_tokens_max':max(r.get('input_tokens',0) for r in a),'failures':[{'case':r['case'],'predicted':r.get('predicted'),'expected':r['expected']} for r in a if not r['correct']]})
x={'calls':len(rows),'rows':summary};(D/'summary.json').write_text(json.dumps(x,ensure_ascii=False,indent=2));print(json.dumps(x,ensure_ascii=False))

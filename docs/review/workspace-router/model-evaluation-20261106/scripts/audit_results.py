"""Audit private raw results without copying request/response text to the report."""
import ast
import collections
import datetime
import hashlib
import json
import math
import pathlib
import random
import sys

bundle, raw, output = map(pathlib.Path, sys.argv[1:])
load = lambda p: json.loads(p.read_text())
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
data = load(bundle / 'dataset.json')
plan = load(raw / 'plan.json')
rows = [json.loads(line) for line in (raw / 'results.jsonl').read_text().splitlines()]
archive = [json.loads(line) for line in (raw / 'results-before-prism-template-fix.jsonl').read_text().splitlines()]
env = load(raw / 'environment.json')
cases = {c['id']: c for c in data['cases']}
conditions = [('decision08', 'no-examples'), ('decision08', 'two-examples'),
              ('decision2', 'no-examples'), ('decision2', 'two-examples'),
              ('prism08', 'native'), ('laya-multilingual', 'native'),
              ('laya-typed-decisions', 'native')]
key = lambda row: (row['case'], row['model'], row['mode'])
assert len(cases) == 16 and len(data['catalog']) == 22
assert len({c['input'] for c in cases.values()}) == 16
assert plan['case_count'] == 16 and plan['catalog_size'] == 23
assert sha(bundle / 'dataset.json') == plan['dataset_sha256']
expected_keys = [(c, m, mode) for c in cases for m, mode in conditions]
random.Random(20261108).shuffle(expected_keys)
assert [key(r) for r in plan['calls']] == expected_keys
assert len(rows) == 112 and len({key(r) for r in rows}) == 112
assert {key(r) for r in rows} == set(expected_keys)
assert sorted(r['index'] for r in rows) == list(range(1, 113))

# Load only the request-building definitions; never execute benchmark HTTP calls.
tree = ast.parse((bundle / 'benchmark.py').read_text())
names = {'MODELS', 'INSTRUCTIONS', 'CRITERIA', 'NAMES'}
nodes = [n for n in tree.body if
         isinstance(n, ast.Assign) and any((isinstance(t, ast.Name) and t.id in names) or (isinstance(t, ast.Subscript) and isinstance(t.value, ast.Name) and t.value.id in names) for t in n.targets)
         or isinstance(n, ast.FunctionDef) and n.name == 'body_for']
ns = {'catalog': data['catalog'], 'examples': data['examples']}
exec(compile(ast.Module(body=nodes, type_ignores=[]), 'request-builders', 'exec'), ns)
allowed = {w['id'] for w in data['catalog']} | {'general'}
template_sha = '1d339995eeb0125c2f95fa502d65bdb4ddfbfed3b85641a54a3dda4e6aee0e3a'
for r in rows:
    assert r['ok'] and r['correct'] == (r['predicted'] == r['expected'])
    assert r['expected'] == cases[r['case']]['expected']
    assert r['source'] == cases[r['case']]['source']
    assert r['candidates'] == 23 and r['predicted'] in allowed
    assert math.isfinite(r['seconds']) and r['seconds'] > 0
    assert key(plan['calls'][r['index'] - 1]) == key(r)
    body = ns['body_for'](cases[r['case']], r['model'], r['mode'])
    assert hashlib.sha256(json.dumps(body, ensure_ascii=False).encode()).hexdigest() == r['body_sha256']
    if r['model'].startswith('decision'):
        assert r['not_truncated'] and 0 < r['input_tokens'] == r['compiled_tokens'] <= 16384
        assert r['input_tokens'] == r['response']['usage']['input_tokens']
        assert r['predicted'] == r['response']['answers']['workspace']['choice']
    elif r['model'] == 'prism08':
        response = r['response']
        assert response['template_version'] == 'native-v2' and response['template_sha256'] == template_sha
        assert len(response['scores']) == len(response['pair_tokens']) == 23
        assert all(math.isfinite(v) and 0 <= v <= 1 for v in response['scores'])
        assert r['not_truncated'] and not response['truncated']
        assert r['input_tokens'] == response['input_tokens'] == sum(response['pair_tokens'])
        assert r['max_pair_tokens'] == max(response['pair_tokens']) <= 10000
        assert r['predicted'] == list(ns['CRITERIA'])[max(range(23), key=lambda i: response['scores'][i])]
    else:
        assert r['predicted'] == r['response']['answers']['workspace']['choice']

groups = collections.defaultdict(list)
for r in rows:
    groups[(r['model'], r['mode'])].append(r)
for group in groups.values():
    assert len(group) == 16 and len({r['case'] for r in group}) == 16
    assert sum(r['source'].startswith('historical') for r in group) == 5
    assert sum(r['source'].startswith('synthetic') for r in group) == 11

assert len(archive) == 27
old_prism = [r for r in archive if r['model'] == 'prism08']
retained = [r for r in archive if r['model'] != 'prism08']
assert len(old_prism) == 5 and len(retained) == 22
current = {key(r): r for r in rows}
assert all(current[key(r)] == r for r in retained)
assert all(current[key(r)]['at'] > r['at'] for r in old_prism)
assert all(current[key(r)]['response']['template_version'] == 'native-v2' for r in old_prism)
for p in bundle.glob('*.py'):
    assert sha(p) == env['scripts_sha256'][p.name], p.name
assert all(s['health']['status'] == 'ok' for s in env['services_current'].values())

audit = {
    'audited_at': datetime.datetime.now().astimezone().isoformat(),
    'completed': 112, 'errors': 0, 'unique_cases': 16, 'conditions': 7,
    'historical_cases_per_condition': 5, 'synthetic_cases_per_condition': 11,
    'checks': ['dataset hash and deterministic randomized plan', '112 unique planned results with consistent labels',
               'all request body hashes regenerated from frozen inputs', 'all 64 Decision calls compile/usage equality without clipping',
               'all 16 Prism calls native-v2 template, 23 complete score pairs and consistent argmax',
               '22 valid pre-fix rows retained, 5 invalid Prism trials excluded and rerun',
               'deployed Python scripts match local snapshots; all 3 services healthy'],
    'raw_sha256': {p.name: sha(p) for p in [bundle / 'dataset.json', raw / 'results.jsonl', raw / 'plan.json',
                                          raw / 'capacity.json', raw / 'environment.json', raw / 'results-before-prism-template-fix.jsonl']},
    'prism_max_pair_tokens': max(r['max_pair_tokens'] for r in rows if r['model'] == 'prism08'),
    'first_formal_response_at': min(r['at'] for r in rows), 'last_formal_response_at': max(r['at'] for r in rows),
    'services_observed_at': env['observed_at'],
}
output.write_text(json.dumps(audit, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(audit, ensure_ascii=False, indent=2))

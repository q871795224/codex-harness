// Opt-in native Skill probe. Requires the local codex executable.
// All state lives in a temporary HOME; model HTTP goes only to an in-process loopback server.
// Prints booleans and version metadata, never model request bodies or credentials.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
const root = await mkdtemp(join(tmpdir(), 'harness-native-skill-')), captures = [];
const baseEnv = Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
const server = createServer(async (req, res) => {
    let bytes = '';
    for await (const b of req)
        bytes += b;
    let body;
    try {
        body = JSON.parse(bytes);
    }
    catch {
        body = {};
    }
    captures.push({ url: req.url, body });
    if (req.url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"input_tokens":100}');
        return;
    }
    if (req.url.includes('/responses')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const msg = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] };
        for (const [type, data] of [
            ['response.created', { response: { id: 'resp_fixture', object: 'response', status: 'in_progress', output: [] } }],
            ['response.output_item.added', { output_index: 0, item: { ...msg, status: 'in_progress', content: [] } }],
            ['response.content_part.added', { item_id: msg.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }],
            ['response.output_text.delta', { item_id: msg.id, output_index: 0, content_index: 0, delta: 'OK' }],
            ['response.output_text.done', { item_id: msg.id, output_index: 0, content_index: 0, text: 'OK' }],
            ['response.output_item.done', { output_index: 0, item: msg }],
            ['response.completed', { response: { id: 'resp_fixture', object: 'response', status: 'completed', output: [msg], usage: { input_tokens: 100, output_tokens: 1, total_tokens: 101 } } }]
        ])
            res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        res.end();
        return;
    }
    if (req.url.includes('/messages')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        for (const [type, data] of [
            ['message_start', { message: { id: 'msg_fixture', type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } }],
            ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
            ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'OK' } }],
            ['content_block_stop', { index: 0 }],
            ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }], ['message_stop', {}]
        ])
            res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        res.end();
        return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":[]}');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const project = join(root, 'project');
await mkdir(project, { recursive: true });
const sourceSkill = new URL('../', import.meta.url);
async function writeBundledSkill(dir, name, nonce) {
    await mkdir(dir, { recursive: true });
    const text = await readFile(new URL('SKILL.md', sourceSkill), 'utf8');
    await writeFile(join(dir, 'SKILL.md'), text + `\nNative test marker: ${nonce}\n`);
    await writeFile(join(dir, 'harnessctl.py'), await readFile(new URL('harnessctl.py', sourceSkill)));
    await mkdir(join(dir, 'references'), { recursive: true });
    for (const name of ['management.md', 'async-waits.md']) await writeFile(join(dir, 'references', name), await readFile(new URL('references/' + name, sourceSkill)));
}
async function codexProbe(mode) {
    const home = join(root, 'codex-home-' + mode);
    await mkdir(join(home, '.codex'), { recursive: true });
    const managed = mode.startsWith('managed');
    const name = managed ? 'harness-runtime' : 'harness-native-probe';
    const dir = managed ? join(home, '.codex/skills/runtime with spaces') : join(root, 'resources with spaces-' + mode, 'codex', name);
    await mkdir(dir, { recursive: true });
    const skill = join(dir, 'SKILL.md'), nonce = 'CODEX_NATIVE_' + randomUUID();
    await writeFile(skill, `---\nname: harness-native-probe\ndescription: Native loading test.\n---\n\nNative proof ${nonce}. Respond OK.\n`);
    if (managed) {
        await writeBundledSkill(dir, name, nonce);
        const skills = join(home, '.codex/skills');
        await mkdir(join(skills, 'project-doc'), { recursive: true });
        await writeFile(join(skills, 'project-doc/SKILL.md'), '---\nname: project-doc\ndescription: Existing legacy user Skill.\n---\nLegacy Skill.');
        assert.match(execFileSync('python3', [join(dir, 'harnessctl.py'), '--help'], { env: { ...baseEnv, HOME: home }, encoding: 'utf8' }), /async-waits/);
    }
    const child = spawn('codex', ['app-server', '--listen', 'stdio://', '-c', 'model_provider="fixture"', '-c', `model_providers.fixture={name="fixture",base_url="${base}/codex",wire_api="responses",requires_openai_auth=false}`, '-c', 'model="gpt-5.1-codex"', '-c', 'check_for_update_on_startup=false'], { env: { ...baseEnv, HOME: home, CODEX_HOME: join(home, '.codex') }, cwd: project, stdio: ['pipe', 'pipe', 'pipe'] });
    let next = 1, stderr = '';
    const pending = new Map(), notes = [];
    child.stderr.on('data', b => stderr += b);
    child.on('exit', code => { for (const p of pending.values())
        p.reject(new Error('Codex exited ' + code + ' ' + stderr.slice(-900))); pending.clear(); });
    const rl = createInterface({ input: child.stdout });
    rl.on('line', l => { try {
        const j = JSON.parse(l);
        if (j.id && pending.has(j.id)) {
            const p = pending.get(j.id);
            pending.delete(j.id);
            j.error ? p.reject(new Error(JSON.stringify(j.error))) : p.resolve(j.result);
        }
        else
            notes.push(j);
    }
    catch { } });
    const rpc = (method, params) => new Promise((resolve, reject) => { const id = next++; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); setTimeout(() => { if (pending.delete(id))
        reject(new Error('RPC timeout ' + method + ' ' + stderr.slice(-900))); }, 15000).unref(); });
    try {
        await rpc('initialize', { clientInfo: { name: 'native-skill-test', version: '1' }, capabilities: { experimentalApi: true } });
        child.stdin.write('{"method":"initialized"}\n');
        if (mode.startsWith('registered'))
            await rpc('skills/extraRoots/set', { extraRoots: [dir] });
        const listing = await rpc('skills/list', { cwds: [project], forceReload: true,
            ...(mode === 'per-cwd' ? { perCwdExtraUserRoots: [{ cwd: project, extraUserRoots: [dir] }] } : {}) });
        const found = listing.data?.flatMap(x => x.skills ?? []).find(x => x.name === name);
        if (managed) assert.ok(listing.data?.flatMap(x => x.skills ?? []).some(x => x.name === 'project-doc'), 'legacy user Skill remains discoverable');
        const alias = await realpath(skill) !== skill;
        const selectedPath = mode === 'registered-alias' ? skill : found?.path ?? await realpath(skill);
        const requestStart = captures.length;
        const t = await rpc('thread/start', { cwd: project, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: false, model: 'gpt-5.1-codex' });
        await rpc('turn/start', { threadId: t.thread.id, input: mode.endsWith('unbound') ? [{ type: 'text', text: 'Respond OK.' }] : managed
            ? [{type:'text',text:'Respond OK.'}, {type:'skill',name,path:selectedPath}]
            : [{ type: 'text', text: '$harness-native-probe Respond OK.' }, { type: 'skill', name, path: selectedPath }] });
        const until = Date.now() + 20000;
        while (Date.now() < until && !notes.some(n => n.method === 'turn/completed'))
            await new Promise(r => setTimeout(r, 100));
        const requests = captures.slice(requestStart).filter(x => x.url.includes('/responses'));
        assert.equal(requests.length, 1, 'Codex must reach the local fixture model exactly once');
        assert.equal(notes.find(n => n.method === 'turn/completed')?.params.turn.status, 'completed');
        const loaded = requests.some(x => JSON.stringify({ input: x.body.input, instructions: x.body.instructions }).includes(nonce));
        if (mode === 'registered' || mode === 'managed')
            assert.equal(loaded, true, 'positive control must load native Skill content');
        if (mode === 'unregistered' || mode.endsWith('unbound'))
            assert.equal(loaded, false);
        let resumeBodyReachedModel = null;
        if (mode === 'registered' || mode === 'managed') {
            await rpc('thread/resume', { threadId: t.thread.id, excludeTurns: true });
            const start = captures.length, completed = notes.filter(n => n.method === 'turn/completed').length;
            await rpc('turn/start', { threadId: t.thread.id, input: [{ type: 'text', text: 'Respond OK to continuation.' }] });
            const end = Date.now() + 20000;
            while (Date.now() < end && notes.filter(n => n.method === 'turn/completed').length === completed)
                await new Promise(r => setTimeout(r, 50));
            const resumed = captures.slice(start).filter(x => x.url.includes('/responses'));
            resumeBodyReachedModel = resumed.some(x => JSON.stringify({ input: x.body.input, instructions: x.body.instructions }).includes(nonce));
            assert.equal(resumeBodyReachedModel, true, 'resumed thread must preserve its native Skill context');
        }
        return { provider: 'codex', case: mode, discovered: !!found, pathAlias: alias, nativeBodyReachedModel: loaded, resumeBodyReachedModel, requestCount: requests.length };
    }
    finally {
        child.kill();
        rl.close();
    }
}
const results = [];
try {
    for (const mode of ['unregistered', 'managed', 'managed-unbound']) results.push(await codexProbe(mode));
    console.log(JSON.stringify({ codex: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(), backend: 'loopback fixture; no real model calls', results }, null, 2));
} finally {
    server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(root, { recursive: true, force: true });
}

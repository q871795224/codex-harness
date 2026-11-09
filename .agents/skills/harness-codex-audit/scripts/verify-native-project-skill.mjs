// Opt-in black-box probe. Requires local codex/claude executables and pnpm dependencies.
// All state lives in a temporary HOME; model HTTP goes only to an in-process loopback server.
// Prints booleans and version metadata, never model request bodies or credentials.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, realpath, readFile, lstat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
const root = await mkdtemp(join(tmpdir(), 'harness-native-skill-')), captures = [];
const baseEnv = Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
const cleanSdkEnv = Object.fromEntries(Object.keys(process.env).map(k => [k, undefined]));
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
const sourceSkill = new URL('../../project-doc/', import.meta.url);
async function writeBundledSkill(dir, name, nonce) {
    await mkdir(join(dir, 'bin'), { recursive: true });
    const text = await readFile(new URL('SKILL.md', sourceSkill), 'utf8');
    await writeFile(join(dir, 'SKILL.md'), text.replace('name: project-doc\n', `name: ${name}\n`) + `\nNative test marker: ${nonce}\n`);
    await writeFile(join(dir, 'project_doc.py'), await readFile(new URL('project_doc.py', sourceSkill)));
    await writeFile(join(dir, 'bin/project-doc'), await readFile(new URL('bin/project-doc', sourceSkill)));
    await chmod(join(dir, 'bin/project-doc'), 0o755);
}
async function codexProbe(mode) {
    const home = join(root, 'codex-home-' + mode);
    await mkdir(join(home, '.codex'), { recursive: true });
    const managed = mode.startsWith('managed');
    const name = managed ? 'harness-project-doc' : 'harness-native-probe';
    const dir = managed ? join(home, '.codex/skills', name + '-fixture with spaces') : join(root, 'resources with spaces-' + mode, 'codex', name);
    await mkdir(dir, { recursive: true });
    const skill = join(dir, 'SKILL.md'), nonce = 'CODEX_NATIVE_' + randomUUID();
    await writeFile(skill, `---\nname: harness-native-probe\ndescription: Native loading test.\n---\n\nNative proof ${nonce}. Respond OK.\n`);
    if (managed) {
        await writeBundledSkill(dir, name, nonce);
        const skills = join(home, '.codex/skills');
        await mkdir(join(skills, 'project-doc'), { recursive: true });
        await writeFile(join(skills, 'project-doc/SKILL.md'), '---\nname: project-doc\ndescription: Existing legacy user Skill.\n---\nLegacy Skill.');
        const previous = join(skills, name + '-previous');
        await mkdir(previous, { recursive: true });
        await writeFile(join(previous, 'SKILL.md'), `---\nname: ${name}\ndescription: Previous application Skill version.\n---\nPrevious version.`);
        assert.equal((await lstat(dir)).isSymbolicLink(), false);
        assert.match(execFileSync(join(dir, 'bin/project-doc'), ['--help'], { env: { ...baseEnv, HOME: home }, encoding: 'utf8' }), /supersede/);
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
        const expectedPath = await realpath(skill);
        const found = listing.data?.flatMap(x => x.skills ?? []).find(x => x.name === name && (!managed || x.path === expectedPath));
        if (managed) assert.ok(found, 'current resource must remain discoverable beside an older version');
        if (managed) assert.ok(listing.data?.flatMap(x => x.skills ?? []).some(x => x.name === 'project-doc'), 'legacy user Skill remains discoverable');
        const alias = await realpath(skill) !== skill;
        const selectedPath = mode === 'registered-alias' ? skill : found?.path ?? await realpath(skill);
        const requestStart = captures.length;
        const t = await rpc('thread/start', { cwd: project, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: false, model: 'gpt-5.1-codex' });
        await rpc('turn/start', { threadId: t.thread.id, input: mode.endsWith('unbound') ? [{ type: 'text', text: 'Respond OK.' }] : managed
            ? [{type:'text',text:'Respond OK.'}, {type:'text',text:`$${name}`,text_elements:[]}, {type:'skill',name,path:selectedPath}]
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
async function claudeProbe(mode) {
    const home = join(root, 'claude-home-' + mode);
    await mkdir(home, { recursive: true });
    const plugin = join(root, 'claude-plugin-' + mode);
    await mkdir(join(plugin, '.claude-plugin'), { recursive: true });
    await mkdir(join(plugin, 'skills', 'project-doc'), { recursive: true });
    await writeFile(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'harness-project-doc', version: '1.0.0' }));
    const nonce = 'CLAUDE_NATIVE_' + randomUUID();
    await writeBundledSkill(join(plugin, 'skills', 'project-doc'), 'project-doc', nonce);
    const original = 'ORIGINAL_USER_' + randomUUID(), background = 'BACKGROUND_' + randomUUID();
    const image = {type:'image',source:{type:'base64',media_type:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='}};
    const env = { ...cleanSdkEnv, ...baseEnv, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), ANTHROPIC_API_KEY: 'fixture-not-a-secret', ANTHROPIC_BASE_URL: base + '/claude', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' };
    async function run(text, resume) {
        let release;
        const hold = new Promise(r => release = r);
        async function* input() { yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: [image, { type: 'text', text: text + ' ' + background + '\n\n' + original }] } }; await hold; }
        const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 30000);
        const q = query({ prompt: input(), options: { cwd: project, plugins: [{ type: 'local', path: plugin }], ...(resume ? { resume } : {}), settingSources: [], model: 'claude-sonnet-4-5', env, maxTurns: 2, persistSession: mode === 'bound', abortController: abort, pathToClaudeCodeExecutable: execFileSync('which', ['claude'], { encoding: 'utf8' }).trim() } });
        const messages = [], requestStart = captures.length;
        try {
            for await (const msg of q) {
                messages.push(msg);
                if (msg.type === 'result')
                    break;
            }
            const requests = captures.slice(requestStart).filter(x => x.url.includes('/claude/') && x.url.includes('/messages') && !x.url.includes('count_tokens'));
            const result = messages.find(x => x.type === 'result');
            assert.equal(result?.subtype, 'success');
            assert.equal(requests.length, 1, 'Claude must reach the local fixture model exactly once');
            assert.ok(requests.some(x => JSON.stringify(x.body.messages).includes(original)), 'native slash dispatch preserves user request');
            assert.ok(requests.some(x => JSON.stringify(x.body.messages).includes(background)), 'native slash dispatch preserves background');
            assert.ok(requests.some(x => JSON.stringify(x.body.messages).includes(image.source.data)), 'native slash dispatch preserves image');
            return { loaded: requests.some(x => JSON.stringify({ messages: x.body.messages, system: x.body.system }).includes(nonce)), init: messages.find(x => x.type === 'system' && x.subtype === 'init'), session: result.session_id };
        }
        finally {
            clearTimeout(timer);
            release();
            q.close();
        }
    }
    const first = await run(mode === 'bound' ? '/harness-project-doc:project-doc' : 'Respond OK.');
    assert.equal(first.loaded, mode === 'bound');
    let resumeBodyReachedModel = null;
    if (mode === 'bound') {
        const resumed = await run('Respond OK to continuation.', first.session);
        assert.equal(resumed.session, first.session);
        resumeBodyReachedModel = resumed.loaded;
        assert.equal(resumeBodyReachedModel, true, 'resumed SDK session must preserve native Skill context');
    }
    return { provider: 'claude', case: mode, nativeBodyReachedModel: first.loaded, resumeBodyReachedModel, pluginDiscovered: !!first.init?.plugins?.some(x => x.name === 'harness-project-doc'), requestCount: 1, originalInputPreserved: true };
}
const results = [];
try {
    for (const mode of ['unregistered', 'per-cwd', 'registered', 'registered-alias', 'registered-unbound', 'managed', 'managed-unbound'])
        results.push(await codexProbe(mode));
    for (const mode of ['bound', 'unbound'])
        results.push(await claudeProbe(mode));
    console.log(JSON.stringify({
        codex: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(),
        claude: execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim(),
        sdk: JSON.parse(await readFile(join(dirname(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk')), 'package.json'), 'utf8')).version,
        backend: 'loopback fixture; no real model calls', platform: process.platform, architecture: process.arch, modelRequests: captures.filter(x => (x.url.includes('/responses') || x.url.includes('/messages')) && !x.url.includes('count_tokens')).length, results,
    }, null, 2));
}
finally {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    await rm(root, { recursive: true, force: true });
}

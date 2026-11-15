import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import test from 'node:test';

test('tools and commands use the current Alma host contract', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'alma-sticker-host-'));
    const previousRoot = process.env.ALMA_STICKERS_ROOT;
    const previousFake = process.env.STICKER_EMBED_FAKE;
    const previousApi = process.env.ALMA_API_URL;
    process.env.ALMA_STICKERS_ROOT = root;
    process.env.STICKER_EMBED_FAKE = '1';

    for (const id of ['pack-a', 'pack-b']) {
        const dir = join(root, 'packs', id);
        mkdirSync(join(dir, 'memes', 'happy'), { recursive: true });
        writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name: id }));
        writeFileSync(join(dir, 'memes', 'happy', 'joy.png'), 'fixture');
        writeFileSync(join(dir, 'memes', 'happy', 'joy-2.png'), 'fixture');
    }
    writeFileSync(join(root, 'rules.json'), JSON.stringify({
        schema_version: 1,
        rules: [
            { id: 'a', scope: 'session', target: 'thread-a', pack_ids: ['pack-a'] },
            { id: 'b', scope: 'session', target: 'thread-b', pack_ids: ['pack-b'] },
            { id: 'default', scope: 'default', pack_ids: ['pack-a'] },
        ],
    }));

    const sent = [];
    const api = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            sent.push({ url: req.url, body: JSON.parse(body) });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, injected: true, messageId: 'assistant-a' }));
        });
    });
    await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
    process.env.ALMA_API_URL = `http://127.0.0.1:${api.address().port}`;

    const tools = new Map();
    const commands = new Map();
    const hooks = new Map();
    const host = {
        logger: { info() {}, warn() {}, error() {} },
        tools: {
            register(id, definition) {
                tools.set(id, definition);
                return { dispose() { tools.delete(id); } };
            },
        },
        commands: {
            // Alma accepts either a handler or one object containing handler/title/description.
            register(id, definition) {
                commands.set(id, definition);
                return { dispose() { commands.delete(id); } };
            },
        },
        events: {
            on(name, handler) {
                if (!hooks.has(name)) hooks.set(name, []);
                hooks.get(name).push(handler);
                return { dispose() {} };
            },
        },
        chat: { async getThread(id) { return { id }; }, async listThreads() { return []; } },
        ui: { async openExternal() {} },
    };
    const emit = async (name, payload) => {
        for (const handler of hooks.get(name) || []) await handler(payload, {});
    };
    const { activate } = await import('../main.js');
    // Exercise the actual activation path without binding or evicting a user's port 8899.
    const listen = Server.prototype.listen;
    Server.prototype.listen = function (...args) {
        if (args[0] === 8899) args[0] = 0;
        return listen.apply(this, args);
    };
    let plugin;
    try {
        plugin = await activate(host);
    } finally {
        Server.prototype.listen = listen;
    }

    t.after(async () => {
        plugin?.dispose();
        await new Promise((resolve) => api.close(resolve));
        for (const [name, value] of [
            ['ALMA_STICKERS_ROOT', previousRoot],
            ['STICKER_EMBED_FAKE', previousFake],
            ['ALMA_API_URL', previousApi],
        ]) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
        const withinTemp = relative(tmpdir(), root);
        assert.ok(withinTemp && !withinTemp.startsWith('..') && !isAbsolute(withinTemp));
        rmSync(root, { recursive: true, force: true });
    });

    await emit('chat.message.willSend', { threadId: 'thread-a' });
    await emit('chat.message.willSend', { threadId: 'thread-b' });

    await t.test('a search in thread A keeps A rules after thread B starts', async () => {
        const args = { query: '开心', top_k: 1 };
        await emit('tool.willExecute', {
            tool: 'plugin--alma-sticker-library--sticker_search', args,
            context: { threadId: 'thread-a', messageId: 'assistant-a', source: '' },
        });
        const hits = await tools.get('sticker_search').execute(args, { threadId: '' });
        assert.equal(hits.length, 1);
        assert.equal(hits[0].pack, 'pack-a');
    });

    await t.test('a pick in thread A sends an A image to A after B starts', async () => {
        const args = { query: '开心' };
        await emit('tool.willExecute', {
            tool: 'plugin--alma-sticker-library--sticker_pick', args,
            context: { threadId: 'thread-a', messageId: 'assistant-a', source: '' },
        });
        const picked = await tools.get('sticker_pick').execute(args, { threadId: '' });
        assert.equal(picked.delivered, true);
        assert.equal(picked.pack, 'pack-a');
        assert.equal(sent.at(-1).url, '/api/threads/thread-a/send-photo');
        assert.ok(sent.at(-1).body.filePath.includes('pack-a'));
    });

    await t.test('an explicit pack still overrides the session rule', async () => {
        const args = { query: '开心', pack: 'pack-b', top_k: 1 };
        await emit('tool.willExecute', {
            tool: 'plugin--alma-sticker-library--sticker_search', args,
            context: { threadId: 'thread-a', source: '' },
        });
        const hits = await tools.get('sticker_search').execute(args, { threadId: '' });
        assert.equal(hits[0].pack, 'pack-b');
    });

    await t.test('commands have titles and handlers in the host command picker', () => {
        assert.equal(commands.get('stickers').title, '打开表情包管理');
        assert.equal(typeof commands.get('stickers').handler, 'function');
        assert.equal(commands.get('stickers-skill').title, '安装表情包技能');
    });

    const settings = await import('../lib/settings.js?v=mwbplvvw');
    await t.test('the configured candidate count changes the tool result', async () => {
        settings.applyChanges({ changes: { 'semantic.top_k': 1 } });
        const args = { query: '开心' };
        await emit('tool.willExecute', {
            tool: 'plugin--alma-sticker-library--sticker_search', args,
            context: { threadId: 'thread-a', source: '' },
        });
        const hits = await tools.get('sticker_search').execute(args, { threadId: '' });
        assert.equal(hits.length, 1);
    });

    await t.test('the configured score threshold can reject weak matches', async () => {
        settings.applyChanges({ changes: { 'semantic.min_score': 1 } });
        const args = { query: '开心' };
        await emit('tool.willExecute', {
            tool: 'plugin--alma-sticker-library--sticker_search', args,
            context: { threadId: 'thread-a', source: '' },
        });
        const hits = await tools.get('sticker_search').execute(args, { threadId: '' });
        assert.deepEqual(hits, []);
    });
});

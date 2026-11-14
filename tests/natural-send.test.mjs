import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { installTurnContext, turnFor } = await import('../lib/turn-context.js');
const { isLocalTurn, sendPhotoToThread, apiBase } = await import('../lib/alma-api.js');
const { deliverPickedSticker } = await import('../lib/pick.js');
const { installStickerSkill } = await import('../lib/skill.js');

function listen(handler) {
    const server = createServer(handler);
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

test('turn context is keyed by the args object and ignores other tools', () => {
    let handler = null;
    installTurnContext({
        on(name, fn) {
            assert.equal(name, 'tool.willExecute');
            handler = fn;
            return { dispose() {} };
        },
    });
    assert.equal(typeof handler, 'function');

    const args = { query: '得意地卖萌' };
    handler({
        tool: 'plugin--alma-sticker-library--sticker_pick',
        args,
        context: { threadId: 'thread-1', messageId: 'msg-1' },
    });
    assert.deepEqual(turnFor(args), {
        threadId: 'thread-1', messageId: 'msg-1', source: '',
    });

    const bashArgs = {};
    handler({ tool: 'Bash', args: bashArgs, context: { threadId: 'thread-2' } });
    assert.equal(turnFor(bashArgs), null);
    assert.equal(turnFor({}), null);
    assert.equal(turnFor(null), null);

    const noThread = {};
    handler({ tool: 'sticker_pick', args: noThread, context: {} });
    assert.equal(turnFor(noThread), null);
});

test('only empty or desktop sources count as a local turn', () => {
    assert.equal(isLocalTurn({ threadId: 't', source: '' }), true);
    assert.equal(isLocalTurn({ threadId: 't', source: 'chat' }), true);
    assert.equal(isLocalTurn({ threadId: 't', source: 'telegram' }), false);
    assert.equal(isLocalTurn({ threadId: '', source: '' }), false);
    assert.equal(isLocalTurn(null), false);
});

test('sendPhotoToThread posts the file and reads the injection result', async (t) => {
    const requests = [];
    const server = await listen((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            requests.push({ url: req.url, method: req.method, body: JSON.parse(body) });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, messageId: 'assistant-9', injected: true }));
        });
    });
    const previous = process.env.ALMA_API_URL;
    process.env.ALMA_API_URL = `http://127.0.0.1:${server.address().port}`;
    t.after(() => {
        if (previous === undefined) delete process.env.ALMA_API_URL;
        else process.env.ALMA_API_URL = previous;
        server.close();
    });

    const out = await sendPhotoToThread({
        threadId: 'thread/1',
        messageId: 'assistant-1',
        filePath: 'C:\\Users\\me\\.config\\alma\\stickers\\packs\\p\\memes\\happy\\a b.gif',
    });
    assert.deepEqual(out, { injected: true, messageId: 'assistant-9' });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, '/api/threads/thread%2F1/send-photo');
    assert.deepEqual(requests[0].body, {
        filePath: 'C:\\Users\\me\\.config\\alma\\stickers\\packs\\p\\memes\\happy\\a b.gif',
        messageId: 'assistant-1',
    });

    await assert.rejects(
        sendPhotoToThread({ threadId: '', filePath: 'x.gif' }),
        /缺少 threadId/,
    );
});

test('sendPhotoToThread surfaces the host error and respects API_SERVER_PORT', async (t) => {
    const server = await listen((_req, res) => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unsupported image type' }));
    });
    const previousUrl = process.env.ALMA_API_URL;
    const previousPort = process.env.API_SERVER_PORT;
    delete process.env.ALMA_API_URL;
    process.env.API_SERVER_PORT = String(server.address().port);
    t.after(() => {
        if (previousUrl !== undefined) process.env.ALMA_API_URL = previousUrl;
        if (previousPort === undefined) delete process.env.API_SERVER_PORT;
        else process.env.API_SERVER_PORT = previousPort;
        server.close();
    });

    assert.equal(apiBase(), `http://127.0.0.1:${server.address().port}`);
    await assert.rejects(
        sendPhotoToThread({ threadId: 't', filePath: 'C:\\x\\a.txt' }),
        /Unsupported image type/,
    );
});

test('local delivery drops the path and channel delivery returns a command', async (t) => {
    const bodies = [];
    const server = await listen((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            bodies.push(JSON.parse(body));
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, messageId: 'assistant-9', injected: true }));
        });
    });
    const previousUrl = process.env.ALMA_API_URL;
    process.env.ALMA_API_URL = `http://127.0.0.1:${server.address().port}`;
    t.after(() => {
        if (previousUrl === undefined) delete process.env.ALMA_API_URL;
        else process.env.ALMA_API_URL = previousUrl;
        server.close();
    });

    const picked = {
        id: 'pack:happy/a.png',
        pack: 'pack',
        file: 'C:\\stickers\\happy\\a.png',
        caption: '开心地笑',
        score: 0.6,
    };
    const local = await deliverPickedSticker({
        picked,
        turn: { threadId: 'thread-1', messageId: 'msg-1', source: '' },
        text: '升职啦，今天得庆祝一下',
    });
    assert.equal(local.delivered, true);
    assert.equal(local.injected, true);
    assert.equal('file' in local, false);
    assert.equal('next' in local, false);
    assert.equal(bodies[0].caption, '升职啦，今天得庆祝一下');

    const channel = await deliverPickedSticker({
        picked,
        turn: { threadId: 'thread-1', messageId: 'msg-1', source: 'telegram' },
        text: '升职啦，今天得庆祝一下',
    });
    assert.equal(channel.delivered, false);
    assert.equal(channel.file, picked.file);
    assert.match(channel.next, /^alma send photo "/);
    assert.match(channel.next, /升职啦，今天得庆祝一下/);

    const noTurn = await deliverPickedSticker({ picked, turn: null });
    assert.equal(noTurn.delivered, false);
    assert.equal(noTurn.file, picked.file);

    const bare = await deliverPickedSticker({
        picked,
        turn: { threadId: 'thread-1', messageId: '', source: '' },
    });
    assert.equal(bare.delivered, true);
    assert.equal('caption' in bodies[1], false);

    const channelBare = await deliverPickedSticker({
        picked, turn: { threadId: 'thread-1', messageId: '', source: 'telegram' },
    });
    assert.equal(channelBare.next, `alma send photo "${picked.file}"`);
});

test('a failed local send falls back to the CLI instruction', async (t) => {
    const server = await listen((_req, res) => {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Thread not found' }));
    });
    const previousUrl = process.env.ALMA_API_URL;
    process.env.ALMA_API_URL = `http://127.0.0.1:${server.address().port}`;
    t.after(() => {
        if (previousUrl === undefined) delete process.env.ALMA_API_URL;
        else process.env.ALMA_API_URL = previousUrl;
        server.close();
    });

    const out = await deliverPickedSticker({
        picked: { id: 'p:c/a.png', file: 'C:\\a.png', score: 0.5 },
        turn: { threadId: 'gone', messageId: '', source: '' },
        text: '抱歉，刚才那张不合适',
    });
    assert.equal(out.delivered, false);
    assert.match(out.reason, /Thread not found/);
    assert.match(out.next, /^alma send photo "/);
    assert.match(out.next, /抱歉/);
});

test('installing the skill copies SKILL.md and refuses silent overwrite', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'alma-skill-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const first = installStickerSkill({ root });
    assert.equal(first.installed, true);
    assert.match(readFileSync(first.path, 'utf8'), /name: sticker-etiquette/);

    const second = installStickerSkill({ root });
    assert.equal(second.installed, false);
    assert.ok(second.reason);

    const forced = installStickerSkill({ root, force: true });
    assert.equal(forced.installed, true);
});

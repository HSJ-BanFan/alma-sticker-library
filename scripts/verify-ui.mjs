import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'alma-sticker-ui-'));
process.env.ALMA_STICKERS_ROOT = root;
process.env.STICKER_EMBED_FAKE = '1';
const api = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/health' ? { status: 'ok' } : { data: [] }));
});
await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
process.env.ALMA_API_BASE = `http://127.0.0.1:${api.address().port}`;
process.env.ALMA_API_URL = process.env.ALMA_API_BASE;

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl0sAAAAASUVORK5CYII=', 'base64');
const pack = join(root, 'packs', 'ui-pack');
mkdirSync(join(pack, 'memes', 'happy'), { recursive: true });
writeFileSync(join(pack, 'manifest.json'), JSON.stringify({ name: '验证用图包', categories: { happy: { description: '开心' } } }));
writeFileSync(join(pack, 'memes', 'happy', '100%.png'), png);
writeFileSync(join(root, 'rules.json'), JSON.stringify({ schema_version: 1, rules: [{ id: 'default', scope: 'default', pack_id: 'ui-pack', pack_ids: ['ui-pack'] }] }));

const gallery = await import('../gallery.js');
const { createZip } = await import('../lib/util.js');
const packZip = join(root, 'pack.zip');
createZip([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify({ name: '大备份验证', categories: { happy: { description: '开心' } } })) },
    { name: 'memes/happy/joy.png', data: png },
    { name: 'fixture-padding.bin', data: Buffer.alloc(25 * 1024 * 1024) },
], packZip);
const backup = join(root, 'large-backup.zip');
createZip([{ name: 'packs/large-pack.zip', file: packZip }], backup);
const badBackup = join(root, 'broken-backup.zip');
createZip([{ name: 'packs/broken-pack.zip', data: Buffer.from('invalid zip fixture') }], badBackup);
const { url } = await gallery.start(0);
console.log(JSON.stringify({ pid: process.pid, url, root, backup, badBackup }));

let closing = false;
async function close() {
    if (closing) return;
    closing = true;
    gallery.stop();
    await new Promise((resolve) => api.close(resolve));
    const withinTemp = relative(tmpdir(), root);
    assert.ok(withinTemp && !withinTemp.startsWith('..') && !isAbsolute(withinTemp));
    rmSync(root, { recursive: true, force: true });
    process.exit(0);
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => { if (data.trim() === 'quit') close(); });
process.on('SIGINT', close);
process.on('SIGTERM', close);

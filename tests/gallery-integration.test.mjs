import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

test('gallery serves ordinary filenames and streams backup uploads', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'alma-sticker-gallery-'));
    const previousRoot = process.env.ALMA_STICKERS_ROOT;
    const previousFake = process.env.STICKER_EMBED_FAKE;
    process.env.ALMA_STICKERS_ROOT = root;
    process.env.STICKER_EMBED_FAKE = '1';

    const pack = join(root, 'packs', 'preview-pack');
    mkdirSync(join(pack, 'memes', 'happy'), { recursive: true });
    writeFileSync(join(pack, 'manifest.json'), JSON.stringify({ name: 'Preview' }));
    writeFileSync(join(pack, 'memes', 'happy', '100%.png'), 'fixture image');

    const gallery = await import('../gallery.js');
    const { createZip } = await import('../lib/util.js');
    const { url } = await gallery.start(0);
    t.after(() => {
        gallery.stop();
        if (previousRoot === undefined) delete process.env.ALMA_STICKERS_ROOT;
        else process.env.ALMA_STICKERS_ROOT = previousRoot;
        if (previousFake === undefined) delete process.env.STICKER_EMBED_FAKE;
        else process.env.STICKER_EMBED_FAKE = previousFake;
        const withinTemp = relative(tmpdir(), root);
        assert.ok(withinTemp && !withinTemp.startsWith('..') && !isAbsolute(withinTemp));
        rmSync(root, { recursive: true, force: true });
    });

    await t.test('an image containing a literal percent sign is visible', async () => {
        const response = await fetch(`${url}/img/preview-pack/happy/100%25.png`);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), 'fixture image');
    });

    await t.test('the HTTP search endpoint uses the configured default candidate count', async () => {
        writeFileSync(join(pack, 'memes', 'happy', 'second.png'), 'fixture image');
        writeFileSync(join(root, 'settings.json'), JSON.stringify({ semantic: { enabled: false, top_k: 1 } }));
        const response = await fetch(`${url}/api/search?q=${encodeURIComponent('开心')}`);
        assert.equal(response.status, 200);
        assert.equal((await response.json()).picks.length, 1);
    });

    await t.test('a large backup uses a binary request through the browser bridge', async () => {
        const packZip = join(root, 'large-pack.zip');
        createZip([
            { name: 'manifest.json', data: Buffer.from(JSON.stringify({ name: 'Large fixture' })) },
            { name: 'memes/happy/large.png', data: Buffer.alloc(25 * 1024 * 1024) },
        ], packZip);
        const archive = join(root, 'backup.zip');
        createZip([{ name: 'packs/large-pack.zip', file: packZip }], archive);
        const file = new File([readFileSync(archive)], 'large-backup.zip', { type: 'application/zip' });
        const requests = [];
        const window = {};
        runInNewContext(readFileSync(new URL('../webui/bridge.js', import.meta.url), 'utf8'), {
            window, location: { origin: url, pathname: '/app/settings/' },
            URL, FormData,
            fetch(input, options) {
                requests.push(options);
                return fetch(input, options);
            },
        });
        const restored = await window.AstrBotPluginPage.upload(
            'settings/backup/import', file, { overwrite: false },
        );
        assert.equal(requests[0].headers['content-type'], 'application/octet-stream');
        assert.equal(requests[0].body, file);
        assert.equal(restored.restored_packs, 1);
        assert.ok(readFileSync(join(root, 'packs', 'large-pack', 'memes', 'happy', 'large.png')).length > 24 * 1024 * 1024);
    });
});

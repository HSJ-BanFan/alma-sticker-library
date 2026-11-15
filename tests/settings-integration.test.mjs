import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import test from 'node:test';

test('settings describe working Alma capabilities and affect retrieval', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'alma-sticker-settings-'));
    const previousRoot = process.env.ALMA_STICKERS_ROOT;
    const previousFake = process.env.STICKER_EMBED_FAKE;
    process.env.ALMA_STICKERS_ROOT = root;
    process.env.STICKER_EMBED_FAKE = '1';
    const dir = join(root, 'packs', 'settings-pack');
    mkdirSync(join(dir, 'memes', 'happy'), { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name: 'Settings test' }));
    writeFileSync(join(dir, 'memes', 'happy', 'joy.png'), 'fixture');
    writeFileSync(join(dir, 'semantic_metadata.json'), JSON.stringify({ images: {
        joy: { content_sha256: 'joy', relative_path: 'memes/happy/joy.png', category: 'happy', caption: '开心 大笑', tags: [] },
    } }));
    writeFileSync(join(root, 'settings.json'), JSON.stringify({ generation: { emotion: { probability: 34 } } }));
    const settings = await import('../lib/settings.js');
    const sharedSettings = await import('../lib/settings.js?v=mwbplvvw');
    const semantic = await import('../lib/semantic.js');
    const indexJob = await import('../lib/index-job.js');
    await indexJob.buildIndex('settings-pack');
    t.after(() => {
        semantic.shutdown();
        if (previousRoot === undefined) delete process.env.ALMA_STICKERS_ROOT;
        else process.env.ALMA_STICKERS_ROOT = previousRoot;
        if (previousFake === undefined) delete process.env.STICKER_EMBED_FAKE;
        else process.env.STICKER_EMBED_FAKE = previousFake;
        const withinTemp = relative(tmpdir(), root);
        assert.ok(withinTemp && !withinTemp.startsWith('..') && !isAbsolute(withinTemp));
        rmSync(root, { recursive: true, force: true });
    });

    await t.test('the settings page does not advertise inactive AstrBot sending modes', () => {
        const paths = settings.describeSettings().fields.map((field) => field.path);
        assert.equal(paths.some((path) => path.startsWith('generation.') || path.startsWith('storage.') || path.startsWith('auto_collect.')), false);
        assert.ok(paths.includes('search.exclude_categories'));
        assert.throws(() => settings.applyChanges({ changes: { 'generation.emotion.probability': 50 } }), /未知配置项/);
    });

    await t.test('turning off vectors uses keyword retrieval even with a fresh vector index', async () => {
        sharedSettings.applyChanges({ changes: { 'semantic.enabled': false } });
        const hits = await semantic.search(['settings-pack'], '开心 大笑', { minScore: 0, topK: 1 });
        assert.equal(hits.length, 1);
        assert.equal(hits[0].retrieval, 'tokens');
    });

    await t.test('saving an active setting retains stored legacy values', () => {
        settings.applyChanges({ changes: { 'webui.preview_concurrency': 3 } });
        const saved = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'));
        assert.equal(saved.generation.emotion.probability, 34);
        assert.equal(saved.webui.preview_concurrency, 3);
    });
});

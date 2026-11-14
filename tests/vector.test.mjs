import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'alma-sticker-vector-'));
const previousRoot = process.env.ALMA_STICKERS_ROOT;
const previousFake = process.env.STICKER_EMBED_FAKE;
process.env.ALMA_STICKERS_ROOT = root;
process.env.STICKER_EMBED_FAKE = '1';

const packId = 'vector-pack';
const packPath = join(root, 'packs', packId);
const metadataPath = join(packPath, 'semantic_metadata.json');
const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl0sAAAAASUVORK5CYII=',
    'base64',
);

mkdirSync(join(packPath, 'memes', 'happy'), { recursive: true });
mkdirSync(join(packPath, 'memes', 'sad'), { recursive: true });
writeFileSync(join(packPath, 'manifest.json'), JSON.stringify({
    name: 'Vector Test',
    categories: { happy: { description: '开心 高兴' }, sad: { description: '难过 伤心' } },
}, null, 2));
writeFileSync(join(packPath, 'memes', 'happy', 'joy.png'), png);
writeFileSync(join(packPath, 'memes', 'sad', 'cry.png'), png);

function writeMetadata({ happyCaption = '开心 大笑', includeSad = true } = {}) {
    const images = {
        'sha-happy': {
            content_sha256: 'sha-happy',
            relative_path: 'memes/happy/joy.png',
            category: 'happy',
            caption: happyCaption,
            visible_text: '哈哈',
            tags: ['category:happy', '笑声'],
        },
    };
    if (includeSad) {
        images['sha-sad'] = {
            content_sha256: 'sha-sad',
            relative_path: 'memes/sad/cry.png',
            category: 'sad',
            caption: '难过 哭',
            visible_text: '呜呜',
            tags: ['category:sad', '眼泪'],
        };
    }
    writeFileSync(metadataPath, JSON.stringify({ images }, null, 2));
}

writeMetadata();

const embed = await import('../lib/embed.js');
const semanticIndex = await import('../lib/semantic-index.js');
const indexJob = await import('../lib/index-job.js');
const semantic = await import('../lib/semantic.js');
const { hybridSearch, retrievalPackIds } = await import('../lib/search.js');

function digest(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

test('vector index core', async (t) => {
    t.after(() => {
        rmSync(root, { recursive: true, force: true });
        if (previousRoot === undefined) delete process.env.ALMA_STICKERS_ROOT;
        else process.env.ALMA_STICKERS_ROOT = previousRoot;
        if (previousFake === undefined) delete process.env.STICKER_EMBED_FAKE;
        else process.env.STICKER_EMBED_FAKE = previousFake;
    });

    await t.test('manifest roundtrip uses four fake dimensions', async () => {
        assert.equal(embed.embedStatus().dims, 4);
        const built = await indexJob.buildIndex(packId);
        assert.equal(built.state, 'fresh');
        assert.equal(built.rows, 2);
        assert.equal(built.progress.embedded, 2);
        assert.equal(built.progress.reused, 0);

        const paths = semanticIndex.indexPaths(packId);
        const manifest = JSON.parse(readFileSync(paths.manifest, 'utf8'));
        assert.equal(manifest.schema_version, 2);
        assert.equal(manifest.mode, 'vector');
        assert.equal(manifest.metric, 'cosine');
        assert.equal(manifest.normalized, true);
        assert.equal(manifest.dims, 4);
        assert.equal(manifest.count, 2);
        assert.equal(manifest.data_file, 'semantic_vectors.f32');
        assert.equal(manifest.rows.length, 2);
        for (const row of manifest.rows) {
            assert.deepEqual(Object.keys(row).sort(), ['category', 'rel', 'sha', 'text_sha256']);
        }

        const data = readFileSync(paths.data);
        assert.equal(data.length, 2 * 4 * 4);
        assert.equal(digest(data), manifest.data_sha256);
        const loaded = semanticIndex.loadIndex(packId);
        assert.equal(loaded.dims, 4);
        assert.equal(loaded.vectors.length, 8);

        const status = semantic.status(packId);
        assert.equal(status.index_ready, true);
        assert.equal(status.embedding_done, 2);
        assert.equal(status.embedding_model, built.model);
        assert.equal(status.index_embedding_dimension, 4);
        assert.equal(status.vector_index.state, 'fresh');

        const original = readFileSync(paths.manifest, 'utf8');
        const changed = JSON.parse(original);
        changed.model = 'old-model';
        writeFileSync(paths.manifest, JSON.stringify(changed, null, 2));
        const mismatch = semantic.status(packId);
        assert.equal(mismatch.index_ready, false);
        assert.equal(mismatch.vector_index.reason, 'model_mismatch');
        assert.equal(mismatch.dimension_rebuild_required, true);
        writeFileSync(paths.manifest, original);
    });

    await t.test('a corrupt data hash returns null', async () => {
        const paths = semanticIndex.indexPaths(packId);
        const original = readFileSync(paths.data);
        const corrupt = Buffer.from(original);
        corrupt[0] ^= 0xFF;
        writeFileSync(paths.data, corrupt);
        assert.equal(semanticIndex.loadIndex(packId), null);
        assert.equal(semanticIndex.inspectIndex(packId).reason, 'data_hash_mismatch');
        writeFileSync(paths.data, original);
        assert.ok(semanticIndex.loadIndex(packId));
    });

    await t.test('a second build embeds zero new rows', async () => {
        const built = await indexJob.buildIndex(packId);
        assert.equal(built.state, 'fresh');
        assert.equal(built.progress.embedded, 0);
        assert.equal(built.progress.reused, 2);
    });

    await t.test('a changed caption re-embeds one row', async () => {
        const before = semanticIndex.loadIndex(packId);
        const sadHash = before.rows.find((row) => row.rel === 'sad/cry.png').text_sha256;
        writeMetadata({ happyCaption: '开心 大笑 拍桌' });
        const built = await indexJob.buildIndex(packId);
        assert.equal(built.progress.embedded, 1);
        assert.equal(built.progress.reused, 1);
        const after = semanticIndex.loadIndex(packId);
        assert.notEqual(
            after.rows.find((row) => row.rel === 'happy/joy.png').text_sha256,
            before.rows.find((row) => row.rel === 'happy/joy.png').text_sha256,
        );
        assert.equal(after.rows.find((row) => row.rel === 'sad/cry.png').text_sha256, sadHash);
    });

    await t.test('rankIndex applies category, topK, and minScore', () => {
        const index = semanticIndex.loadIndex(packId);
        const happy = index.rows.find((row) => row.rel === 'happy/joy.png');
        const at = index.rows.indexOf(happy) * index.dims;
        const vector = index.vectors.slice(at, at + index.dims);

        const top = semanticIndex.rankIndex(index, vector, { topK: 1, minScore: 0.35 });
        assert.equal(top.length, 1);
        assert.equal(top[0].row.rel, 'happy/joy.png');
        assert.ok(top[0].score <= 1);

        const sad = index.rows.find((row) => row.rel === 'sad/cry.png');
        const sadAt = index.rows.indexOf(sad) * index.dims;
        const sadVector = index.vectors.slice(sadAt, sadAt + index.dims);
        const filtered = semanticIndex.rankIndex(index, sadVector, {
            topK: 5, minScore: 0.35, category: 'sad',
        });
        assert.equal(filtered.length, 1);
        assert.equal(filtered[0].row.category, 'sad');

        const tooHigh = semanticIndex.rankIndex(index, sadVector, { topK: 5, minScore: 2 });
        assert.deepEqual(tooHigh, []);
    });

    await t.test('a removed rel is pruned from rows and data', async () => {
        writeMetadata({ includeSad: false });
        rmSync(join(packPath, 'memes', 'sad', 'cry.png'));
        const built = await indexJob.buildIndex(packId);
        assert.equal(built.rows, 1);
        const index = semanticIndex.loadIndex(packId);
        assert.equal(index.count, 1);
        assert.deepEqual(index.rows.map((row) => row.rel), ['happy/joy.png']);
        assert.equal(readFileSync(semanticIndex.indexPaths(packId).data).length, 4 * 4);
    });

    await t.test('a missing index falls back to token search', async () => {
        indexJob.deleteIndexFor(packId);
        assert.equal(indexJob.indexStatus(packId).state, 'missing');
        const hits = await semantic.search([packId], '开心', { topK: 5, minScore: 0.02 });
        assert.equal(hits.length, 1);
        assert.equal(hits[0].id, `${packId}:happy/joy.png`);
        assert.equal(hits[0].retrieval, 'tokens');
        const hybrid = await hybridSearch([packId], '开心', { topK: 5, semantic });
        assert.equal(hybrid[0].retrieval, 'tokens');
    });

    await t.test('deleteIndex removes the manifest and vector file', async () => {
        await indexJob.buildIndex(packId);
        const paths = semanticIndex.indexPaths(packId);
        assert.ok(existsSync(paths.manifest));
        assert.ok(existsSync(paths.data));
        assert.equal(semanticIndex.deleteIndex(packId), true);
        assert.equal(existsSync(paths.manifest), false);
        assert.equal(existsSync(paths.data), false);
        assert.equal(semanticIndex.loadIndex(packId), null);
    });

    await t.test('rule packs without captions widen to described packs', () => {
        const plain = join(root, 'packs', 'plain-pack');
        mkdirSync(join(plain, 'memes', 'affection'), { recursive: true });
        writeFileSync(join(plain, 'manifest.json'), JSON.stringify({ name: 'Plain' }, null, 2));
        writeFileSync(join(plain, 'memes', 'affection', 'a.png'), png);

        assert.deepEqual(retrievalPackIds(['plain-pack']), ['plain-pack', packId]);
        assert.deepEqual(retrievalPackIds([packId]), [packId]);
        assert.deepEqual(retrievalPackIds([]), [packId]);
    });
});

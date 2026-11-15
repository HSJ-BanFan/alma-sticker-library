/**
 * 向量索引构建任务。
 *
 * 增量规则只依赖三个内容标识：图片 sha、文本 sha、当前模型维度。
 * 全局同时只跑一个构建，按包合并请求；取消只发生在批次之间，不写半截索引。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
    entryRelPath, loadSemanticMetadata, packDir, packExists,
} from './store.js?v=0.3.1-codex-20261114';
import { fileSha256 } from './util.js?v=0.3.1-codex-20261114';
import {
    embedBatch, embedStatus, FAKE_MODEL, MODEL,
} from './embed.js?v=0.3.1-codex-20261114';
import {
    deleteIndex, inspectIndex, textHash, writeIndex,
} from './semantic-index.js?v=0.3.1-codex-20261114';

const jobs = new Map();
const lastErrors = new Map();
let chain = Promise.resolve();

function currentModel() {
    const status = embedStatus();
    if (process.env.STICKER_EMBED_FAKE === '1') return status.model || FAKE_MODEL;
    return status.model || MODEL;
}

function currentDims() {
    const status = embedStatus();
    return status.state === 'ready' ? status.dims || 0 : 0;
}

function captionText(entry) {
    const caption = String(entry?.caption || '').trim();
    if (!caption) return '';
    const visible = String(entry?.visible_text || '').trim();
    const useWhen = String(entry?.use_when || '').trim();
    const tags = (Array.isArray(entry?.tags) ? entry.tags : [])
        .filter((tag) => typeof tag === 'string' && !tag.startsWith('category:'))
        .map((tag) => tag.trim())
        .filter(Boolean);
    // avoid_when 不进向量：否定句在相似度里会被当成正向语义，反而拉近不该命中的图。
    return [caption, visible, useWhen, tags.join(' ')].filter(Boolean).join('\n');
}

/** 返回 rel -> {row,text}，同一 rel 只保留一条，避免索引重复。 */
function expectedRows(packId) {
    const out = new Map();
    if (!packExists(packId)) return out;
    const meta = loadSemanticMetadata(packId);
    for (const [id, entry] of Object.entries(meta.images || {})) {
        const rel = entryRelPath(entry);
        if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) continue;
        const text = captionText(entry);
        if (!text) continue;
        const category = rel.split('/')[0] || '';
        let sha = String(entry?.content_sha256 || '');
        if (!sha) {
            const full = join(packDir(packId), 'memes', rel);
            try {
                if (existsSync(full)) sha = fileSha256(full);
            } catch { /* 读不到文件时以空 sha 参与比对 */ }
        }
        out.set(rel, {
            text,
            row: {
                sha,
                rel,
                category,
                text_sha256: textHash(text),
            },
            id,
        });
    }
    return out;
}

function rowsFresh(expected, rows) {
    if (expected.size !== rows.length) return false;
    const byRel = new Map(rows.map((row) => [row.rel, row]));
    for (const [rel, item] of expected) {
        const row = byRel.get(rel);
        if (!row || row.sha !== item.row.sha || row.text_sha256 !== item.row.text_sha256) return false;
    }
    return true;
}

function reasonState(reason) {
    if (reason === 'model_mismatch' || reason === 'dims_mismatch'
        || reason === 'schema_mismatch' || reason === 'mode_mismatch'
        || reason === 'metric_mismatch' || reason === 'data_file_mismatch') {
        return 'stale';
    }
    if (reason === 'data_size_mismatch' || reason === 'data_hash_mismatch'
        || reason === 'read_error' || reason === 'rows_invalid'
        || reason === 'manifest_invalid') {
        return 'corrupt';
    }
    return 'missing';
}

export function indexStatus(packId) {
    let expected = new Map();
    try {
        expected = expectedRows(packId);
    } catch (err) {
        lastErrors.set(packId, err?.message || String(err));
    }
    const captionedTotal = expected.size;
    const embed = embedStatus();
    const model = currentModel();
    const readyDims = currentDims();
    const inspected = inspectIndex(packId, {
        model,
        ...(readyDims ? { dims: readyDims } : {}),
    });
    const index = inspected.index;
    const job = jobs.get(packId);
    const active = job && (job.status === 'queued' || job.status === 'running');

    let state = 'missing';
    let reason = '';
    let rows = 0;
    let dims = readyDims || 0;
    let builtAt = '';
    let progress = null;
    let error = lastErrors.get(packId) || '';

    if (index) {
        rows = index.count;
        dims = index.dims;
        builtAt = index.built_at || '';
        if (rowsFresh(expected, index.rows)) {
            state = 'fresh';
        } else {
            state = 'stale';
            reason = 'captions_changed';
        }
    } else {
        reason = inspected.reason || 'manifest_missing';
        if (!captionedTotal) {
            state = 'missing';
            reason = 'no_captions';
        } else if (reason === 'manifest_missing' || reason === 'invalid_pack') {
            state = 'missing';
            reason = 'no_index';
        } else if (reason === 'model_mismatch' || reason === 'dims_mismatch'
            || reason === 'schema_mismatch') {
            state = 'stale';
        } else {
            state = reasonState(reason);
        }
    }

    if (active) {
        state = 'building';
        reason = 'building';
        progress = { ...job.progress };
        rows = (job.progress.reused || 0) + (job.progress.done || 0);
        dims = job.dims || dims;
        builtAt = index?.built_at || '';
        error = job.error || error;
    }

    if (state !== 'fresh' && state !== 'building' && captionedTotal && embed.state === 'unavailable') {
        state = 'unavailable';
        reason = 'embed_unavailable';
        error = embed.error || error;
    }
    if (state !== 'fresh' && state !== 'building' && lastErrors.has(packId)) {
        state = 'unavailable';
        reason = 'build_failed';
        error = lastErrors.get(packId) || error;
    }

    return {
        state,
        reason,
        rows,
        captioned_total: captionedTotal,
        dims,
        model: index?.model || model,
        built_at: builtAt,
        progress,
        error,
    };
}

function finalStatus(packId, job) {
    return {
        ...indexStatus(packId),
        progress: { ...job.progress },
        ...(job.error ? { error: job.error } : {}),
    };
}

function cancelledStatus(packId, job) {
    job.status = 'cancelled';
    job.progress = { ...job.progress, phase: 'cancelled' };
    return {
        ...indexStatus(packId),
        progress: { ...job.progress },
        cancelled: true,
        error: job.error || '',
    };
}

async function runBuild(job) {
    const { packId } = job;
    if (job.cancel) return cancelledStatus(packId, job);
    if (!packExists(packId)) {
        job.status = 'error';
        job.error = `表情包不存在: ${packId}`;
        lastErrors.set(packId, job.error);
        return finalStatus(packId, job);
    }

    job.status = 'running';
    job.startedAt = new Date().toISOString();
    try {
        const expected = expectedRows(packId);
        if (!expected.size) {
            deleteIndex(packId);
            lastErrors.delete(packId);
            job.status = 'done';
            job.progress = {
                phase: 'done', done: 0, total: 0, embedded: 0, reused: 0,
            };
            return finalStatus(packId, job);
        }

        const model = currentModel();
        const readyDims = currentDims();
        const inspected = inspectIndex(packId, {
            model,
            ...(readyDims ? { dims: readyDims } : {}),
        });
        const existing = !job.force ? inspected.index : null;
        const reuse = new Map();
        if (existing) {
            for (let i = 0; i < existing.rows.length; i += 1) {
                const row = existing.rows[i];
                reuse.set(row.rel, {
                    row,
                    vector: existing.vectors.slice(
                        i * existing.dims,
                        (i + 1) * existing.dims,
                    ),
                });
            }
        }

        const rows = [];
        const missing = [];
        for (const [rel, item] of expected) {
            rows.push(item.row);
            const old = reuse.get(rel);
            if (old && old.row.sha === item.row.sha
                && old.row.text_sha256 === item.row.text_sha256) {
                continue;
            }
            missing.push({ rel, text: item.text });
        }

        job.progress = {
            phase: missing.length ? 'embed' : 'reuse',
            done: 0,
            total: missing.length,
            embedded: 0,
            reused: rows.length - missing.length,
        };
        job.dims = existing?.dims || readyDims || 0;

        let embedded = [];
        if (missing.length) {
            embedded = await embedBatch(missing.map((item) => item.text), {
                batchSize: 32,
                onProgress: (value) => {
                    job.progress = {
                        phase: 'embed',
                        done: value.done,
                        total: value.total,
                        embedded: value.done,
                        reused: rows.length - missing.length,
                    };
                },
            });
            if (job.cancel) return cancelledStatus(packId, job);
            if (embedded.length !== missing.length) throw new Error('向量条数与待嵌入文本不一致');
            job.dims = embedded[0]?.length || job.dims;
        }

        const dims = job.dims || existing?.dims || 0;
        if (!dims) throw new Error('没有可用的向量维度');
        if (existing && dims !== existing.dims) {
            // 模型同名但维度变化：旧向量无法拼接，退化为整包重建。
            job.force = true;
            job.status = 'queued';
            job.progress = { phase: 'queued', done: 0, total: expected.size, embedded: 0, reused: 0 };
            return runBuild(job);
        }

        const vectorFor = new Map();
        for (const [rel, old] of reuse) {
            if (old.row.sha === expected.get(rel)?.row.sha
                && old.row.text_sha256 === expected.get(rel)?.row.text_sha256) {
                vectorFor.set(rel, old.vector);
            }
        }
        missing.forEach((item, index) => {
            vectorFor.set(item.rel, embedded[index]);
        });

        const flat = new Float32Array(rows.length * dims);
        for (let i = 0; i < rows.length; i += 1) {
            const vector = vectorFor.get(rows[i].rel);
            if (!vector || vector.length !== dims) throw new Error(`向量缺失: ${rows[i].rel}`);
            flat.set(vector, i * dims);
        }

        if (job.cancel) return cancelledStatus(packId, job);
        writeIndex(packId, { vectors: flat, model, dims }, rows);
        lastErrors.delete(packId);
        job.status = 'done';
        job.error = '';
        job.progress = {
            phase: 'done',
            done: missing.length,
            total: missing.length,
            embedded: missing.length,
            reused: rows.length - missing.length,
        };
        return finalStatus(packId, job);
    } catch (err) {
        if (job.cancel) return cancelledStatus(packId, job);
        job.status = 'error';
        job.error = err?.message || String(err);
        lastErrors.set(packId, job.error);
        return finalStatus(packId, job);
    }
}

export function buildIndex(packId, { force = false } = {}) {
    const id = String(packId || '');
    const existing = jobs.get(id);
    if (existing) {
        if (force) existing.force = true;
        return existing.promise;
    }
    const job = {
        packId: id,
        force: Boolean(force),
        cancel: false,
        status: 'queued',
        progress: { phase: 'queued', done: 0, total: 0, embedded: 0, reused: 0 },
        error: '',
        dims: 0,
        startedAt: '',
    };
    jobs.set(id, job);
    const promise = chain.then(
        () => runBuild(job),
        () => runBuild(job),
    ).catch((err) => {
        job.status = 'error';
        job.error = err?.message || String(err);
        lastErrors.set(id, job.error);
        return finalStatus(id, job);
    }).finally(() => {
        if (jobs.get(id) === job) jobs.delete(id);
    });
    job.promise = promise;
    chain = promise.catch(() => {});
    return promise;
}

export function autoBuild(packIds) {
    const ids = [...new Set((Array.isArray(packIds) ? packIds : [packIds])
        .map((id) => String(id || '').trim()).filter(Boolean))];
    const scheduled = [];
    for (const id of ids) {
        try {
            if (!packExists(id) || !expectedRows(id).size) continue;
            scheduled.push(id);
            buildIndex(id).catch(() => {});
        } catch {
            // 单个坏包不影响其它包的自动构建。
        }
    }
    return { scheduled };
}

export function cancelAll() {
    let cancelled = 0;
    for (const job of jobs.values()) {
        job.cancel = true;
        cancelled += 1;
    }
    return { cancelled };
}

export function deleteIndexFor(packId) {
    const job = jobs.get(packId);
    if (job) job.cancel = true;
    const deleted = deleteIndex(packId);
    lastErrors.delete(packId);
    return { deleted };
}

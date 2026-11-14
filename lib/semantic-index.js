/**
 * 向量索引的磁盘格式与纯检索。
 *
 * 一个包一份 manifest 加一份 Float32 小端矩阵。写入顺序固定为
 * 向量文件先落盘、manifest 最后写，旧 manifest 与半截数据不会同时生效。
 */

import {
    existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { nowIso, readJson, sha256, writeJsonAtomic } from './util.js?v=mwbplvvw';
import { packDir } from './store.js?v=mwbplvvw';

export const SCHEMA_VERSION = 2;
export const DATA_FILE = 'semantic_vectors.f32';

export function indexPaths(packId) {
    try {
        const dir = packDir(packId);
        return {
            dir,
            manifest: join(dir, 'semantic_index.json'),
            data: join(dir, DATA_FILE),
        };
    } catch {
        return null;
    }
}

export function textHash(text) {
    return sha256(String(text ?? ''));
}

function invalid(reason, detail = '') {
    return { index: null, reason, detail };
}

function cleanRows(rows) {
    return rows.map((row) => ({
        sha: String(row?.sha || ''),
        rel: String(row?.rel || ''),
        category: String(row?.category || ''),
        text_sha256: String(row?.text_sha256 || ''),
    }));
}

function flattenVectors(data, count, dims) {
    if (data instanceof Float32Array) {
        if (data.length !== count * dims) throw new Error('向量数据长度与 rows/dims 不一致');
        return data;
    }
    const out = new Float32Array(count * dims);
    const list = Array.isArray(data) ? data : [];
    if (list.length !== count) throw new Error('向量条数与 rows 不一致');
    let at = 0;
    for (const vector of list) {
        if (!vector || vector.length !== dims) throw new Error('向量维度与 manifest 不一致');
        for (let i = 0; i < dims; i += 1) out[at + i] = Number(vector[i]);
        at += dims;
    }
    return out;
}

/** 写入向量矩阵和 manifest；失败时清掉临时文件，不留下半成品。 */
export function writeIndex(packId, data, rows) {
    const paths = indexPaths(packId);
    if (!paths) throw new Error(`非法表情包 id: ${packId}`);
    const clean = cleanRows(Array.isArray(rows) ? rows : []);
    const payload = data && !ArrayBuffer.isView(data) && !Array.isArray(data)
        ? data
        : { vectors: data };
    const source = payload.vectors ?? data;
    const dims = Number(payload.dims)
        || (source instanceof Float32Array && clean.length ? source.length / clean.length : 0)
        || (Array.isArray(source) && source[0]?.length) || 0;
    if (!Number.isInteger(dims) || dims <= 0) throw new Error('缺少向量维度');
    const flat = flattenVectors(source, clean.length, dims);
    const bytes = Buffer.allocUnsafe(flat.length * 4);
    for (let i = 0; i < flat.length; i += 1) bytes.writeFloatLE(flat[i], i * 4);

    const tmp = `${paths.data}.${process.pid}.${Date.now().toString(36)}.tmp`;
    try {
        writeFileSync(tmp, bytes);
        renameSync(tmp, paths.data);
    } catch (err) {
        try { rmSync(tmp, { force: true }); } catch { /* 临时文件清不掉也不影响旧索引 */ }
        throw err;
    }

    const manifest = {
        schema_version: SCHEMA_VERSION,
        mode: 'vector',
        model: String(payload.model || ''),
        dims,
        metric: 'cosine',
        normalized: true,
        count: clean.length,
        data_file: DATA_FILE,
        data_sha256: sha256(bytes),
        built_at: nowIso(),
        rows: clean,
    };
    writeJsonAtomic(paths.manifest, manifest);
    return { ...manifest, vectors: flat };
}

/**
 * 返回 {index, reason, detail}，调用方需要原因时用它；loadIndex 只返回 index。
 * 任何问题都收敛成 reason，不向检索路径抛错。
 */
export function inspectIndex(packId, { model = '', dims = 0 } = {}) {
    try {
        const paths = indexPaths(packId);
        if (!paths) return invalid('invalid_pack');
        if (!existsSync(paths.manifest)) return invalid('manifest_missing');
        const manifest = readJson(paths.manifest, null);
        if (!manifest || typeof manifest !== 'object') return invalid('manifest_invalid');
        if (manifest.schema_version !== SCHEMA_VERSION) return invalid('schema_mismatch');
        if (manifest.mode !== 'vector') return invalid('mode_mismatch');
        if (manifest.metric !== 'cosine' || manifest.normalized !== true) return invalid('metric_mismatch');
        if (manifest.data_file !== DATA_FILE) return invalid('data_file_mismatch');
        if (model && manifest.model !== String(model)) return invalid('model_mismatch');
        if (dims && Number(manifest.dims) !== Number(dims)) return invalid('dims_mismatch');
        const count = Number(manifest.count);
        const manifestDims = Number(manifest.dims);
        if (!Number.isInteger(count) || count < 0 || !Number.isInteger(manifestDims) || manifestDims <= 0) {
            return invalid('manifest_invalid');
        }
        if (!Array.isArray(manifest.rows) || manifest.rows.length !== count) {
            return invalid('rows_invalid');
        }
        for (const row of manifest.rows) {
            if (!row || typeof row.rel !== 'string' || !row.rel) return invalid('rows_invalid');
            if (typeof row.category !== 'string') return invalid('rows_invalid');
            if (typeof row.sha !== 'string' || typeof row.text_sha256 !== 'string') {
                return invalid('rows_invalid');
            }
        }
        if (!existsSync(paths.data)) return invalid('data_missing');
        const expected = count * manifestDims * 4;
        const size = statSync(paths.data).size;
        if (size !== expected) {
            return invalid('data_size_mismatch', `${size} != ${expected}`);
        }
        const buf = readFileSync(paths.data);
        const digest = sha256(buf);
        if (!manifest.data_sha256 || digest !== manifest.data_sha256) {
            return invalid('data_hash_mismatch');
        }
        const vectors = new Float32Array(count * manifestDims);
        for (let i = 0; i < vectors.length; i += 1) vectors[i] = buf.readFloatLE(i * 4);
        return {
            index: { ...manifest, vectors },
            reason: '',
            detail: '',
        };
    } catch (err) {
        return invalid('read_error', err?.message || String(err));
    }
}

export function loadIndex(packId, options = {}) {
    return inspectIndex(packId, options).index;
}

export function deleteIndex(packId) {
    const paths = indexPaths(packId);
    if (!paths) return false;
    let removed = false;
    for (const path of [paths.data, paths.manifest]) {
        try {
            if (existsSync(path)) {
                rmSync(path, { force: true });
                removed = true;
            }
        } catch {
            // 删除失败由下一次构建或状态检查暴露，不阻塞清理流程。
        }
    }
    return removed;
}

/** 纯余弦排序；索引和查询都应是 L2 归一化向量。 */
export function rankIndex(index, vector, { topK = 5, minScore = 0.35, category = null } = {}) {
    if (!index || !Array.isArray(index.rows) || !index.vectors || !vector?.length) return [];
    const dims = Number(index.dims);
    if (!dims || vector.length !== dims) return [];
    let queryNorm = 0;
    for (const value of vector) queryNorm += Number(value) * Number(value);
    queryNorm = Math.sqrt(queryNorm);
    if (!Number.isFinite(queryNorm) || queryNorm === 0) return [];

    const threshold = Number.isFinite(Number(minScore)) ? Number(minScore) : 0.35;
    const hits = [];
    for (let rowIndex = 0; rowIndex < index.rows.length; rowIndex += 1) {
        const row = index.rows[rowIndex];
        if (category && row.category !== category) continue;
        let dot = 0;
        const offset = rowIndex * dims;
        for (let i = 0; i < dims; i += 1) dot += index.vectors[offset + i] * Number(vector[i]);
        const score = dot / queryNorm;
        if (!Number.isFinite(score) || score < threshold) continue;
        hits.push({ score: Math.round(score * 10000) / 10000, row });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, Math.max(1, Number(topK) || 5));
}

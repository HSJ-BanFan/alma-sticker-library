/**
 * 向量模型主进程监督器。
 *
 * 模型只在 worker 里加载；主进程负责生命周期、请求超时、崩溃重启和空闲退出。
 * 检索路径永远不能因为模型没准备好而抛错，embedQuery 会返回 null 交给关键词兜底。
 */

import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from './util.js?v=mwbplvvw';

export const MODEL = 'Xenova/bge-small-zh-v1.5';
export const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：';
export const FAKE_MODEL = 'fake-bge-small-zh-v1.5';
const FAKE_DIMS = 4;

const WORKER_PATH = fileURLToPath(new URL('./embed-worker.cjs', import.meta.url));
const IDLE_MS = 10 * 60 * 1000;
const RESTART_WINDOW_MS = 10 * 60 * 1000;
const MAX_RESTARTS = 3;

let state = 'idle';
let model = MODEL;
let dims = 0;
let lastError = '';
let child = null;
let startPromise = null;
let idleTimer = null;
let nextId = 1;
let restartTimes = [];
const pending = new Map();

function isFake() {
    return process.env.STICKER_EMBED_FAKE === '1';
}

function cacheDir() {
    return String(process.env.ALMA_EMBED_CACHE || join(ROOT, '_models', 'transformers'));
}

function transformPath() {
    const candidates = [
        process.env.ALMA_TRANSFORMERS_PATH,
        process.resourcesPath
            ? join(process.resourcesPath, 'app.asar', 'node_modules', '@huggingface', 'transformers')
            : '',
        process.resourcesPath
            ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@huggingface', 'transformers')
            : '',
    ];
    // 解包安装没有 app.asar：从 exe 所在目录往上找 alma-server/lib 或 lib 里的 node_modules。
    const exe = String(process.execPath || '');
    if (exe) {
        let dir = exe;
        for (let up = 0; up < 4; up += 1) {
            dir = join(dir, '..');
            candidates.push(join(dir, 'alma-server', 'lib', 'node_modules', '@huggingface', 'transformers'));
            candidates.push(join(dir, 'lib', 'node_modules', '@huggingface', 'transformers'));
        }
    }
    for (const candidate of candidates) {
        const path = String(candidate || '').trim();
        if (path && existsSync(path)) return path;
    }
    return '';
}

/** 子进程要跑 ONNX，得用真正的 node；Electron 本体做 execPath 时会被直接退出。 */
function nodeExecPath() {
    const explicit = String(process.env.ALMA_NODE_PATH || '').trim();
    if (explicit && existsSync(explicit)) return explicit;
    const sep = process.platform === 'win32' ? ';' : ':';
    const names = process.platform === 'win32' ? ['node.exe'] : ['node'];
    for (const dir of String(process.env.PATH || process.env.Path || '').split(sep)) {
        const base = dir.trim();
        if (!base) continue;
        for (const name of names) {
            const full = join(base, name);
            try {
                if (existsSync(full)) return full;
            } catch { /* 没权限的目录跳过 */ }
        }
    }
    return process.execPath;
}

function status() {
    return {
        state,
        model,
        dims,
        error: lastError,
        cache_dir: cacheDir(),
    };
}

function clearIdleTimer() {
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
}

function noteActivity() {
    if (isFake()) return;
    clearIdleTimer();
    idleTimer = setTimeout(() => {
        idleTimer = null;
        if (pending.size || !child) return;
        stopWorker('idle');
        state = 'idle';
    }, IDLE_MS);
    idleTimer.unref?.();
}

function rejectPending(message, target = null) {
    for (const [id, item] of pending) {
        if (target && item.proc !== target) continue;
        clearTimeout(item.timer);
        pending.delete(id);
        item.reject(new Error(message));
    }
}

function stopWorker(reason) {
    const proc = child;
    if (!proc) return;
    proc.__intentionalStop = true;
    child = null;
    try { proc.kill(); } catch { /* 已经退出 */ }
    rejectPending(reason, proc);
}

function fakeVector(text) {
    // 去掉查询前缀和换行，让测试里的“开心”与“开心\n\n”得到同一个确定性向量。
    const canonical = String(text).split(QUERY_PREFIX).join('').replace(/\s+/g, '');
    const digest = createHash('sha256').update(canonical).digest();
    const values = [];
    for (let i = 0; i < FAKE_DIMS; i += 1) {
        values.push((digest.readUInt32LE(i * 4) / 0xFFFFFFFF) * 2 - 1);
    }
    let sum = 0;
    for (const value of values) sum += value * value;
    const norm = Math.sqrt(sum) || 1;
    return new Float32Array(values.map((value) => value / norm));
}

function prepare(texts, kind) {
    return texts.map((text) => (kind === 'query' ? `${QUERY_PREFIX}${text}` : text));
}

function sendRequest(proc, texts, kind, timeoutMs) {
    return new Promise((resolve, reject) => {
        if (!proc || child !== proc || !proc.connected) {
            reject(new Error('向量模型进程未就绪'));
            return;
        }
        const id = nextId;
        nextId += 1;
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`向量模型请求超时（${timeoutMs}ms）`));
        }, Math.max(1, timeoutMs));
        timer.unref?.();
        pending.set(id, { resolve, reject, timer, proc });
        try {
            proc.send({ type: 'embed', id, texts: prepare(texts, kind), kind }, (err) => {
                if (!err) return;
                const item = pending.get(id);
                if (!item) return;
                clearTimeout(item.timer);
                pending.delete(id);
                item.reject(err);
            });
        } catch (err) {
            clearTimeout(timer);
            pending.delete(id);
            reject(err);
        }
    });
}

function scheduleRestart() {
    setTimeout(() => {
        if (child) return;
        if (startPromise) {
            startPromise.finally(() => {
                if (!child) launch({ timeoutMs: 300000 });
            });
            return;
        }
        launch({ timeoutMs: 300000 });
    }, 0);
}

function launch({ timeoutMs = 300000 } = {}) {
    if (isFake()) {
        state = 'ready';
        model = FAKE_MODEL;
        dims = FAKE_DIMS;
        lastError = '';
        return Promise.resolve(status());
    }
    if (state === 'ready' && child) return Promise.resolve(status());
    if (startPromise) return startPromise;
    stopWorker('向量模型重启');

    state = 'starting';
    lastError = '';
    model = MODEL;
    const transformersPath = transformPath();
    if (!transformersPath) {
        state = 'unavailable';
        lastError = '没有找到 Alma 内置的 @huggingface/transformers';
        return Promise.resolve(status());
    }

    const cache = cacheDir();
    try { mkdirSync(cache, { recursive: true }); } catch { /* worker 会给出更具体的错误 */ }

    const promise = new Promise((resolve) => {
        let proc;
        try {
            proc = fork(WORKER_PATH, [], {
                execPath: nodeExecPath(),
                env: {
                    ...process.env,
                    ELECTRON_RUN_AS_NODE: '1',
                    STICKER_TRANSFORMERS_PATH: transformersPath,
                    STICKER_MODEL_CACHE: cache,
                },
                stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
                windowsHide: true,
            });
        } catch (err) {
            state = 'error';
            lastError = err?.message || String(err);
            resolve(status());
            return;
        }

        child = proc;
        let stderr = '';
        proc.stderr?.on('data', (chunk) => {
            stderr = `${stderr}${chunk}`.slice(-4000);
        });
        proc.on('message', (message) => {
            if (child !== proc || !message) return;
            if (message.type === 'ready') {
                state = 'ready';
                lastError = '';
            } else if (message.type === 'result') {
                const item = pending.get(message.id);
                if (!item) return;
                clearTimeout(item.timer);
                pending.delete(message.id);
                const vectors = (Array.isArray(message.vectors) ? message.vectors : [])
                    .map((vector) => Float32Array.from(vector));
                dims = Number(message.dims) || vectors[0]?.length || dims;
                state = 'ready';
                lastError = '';
                item.resolve({ vectors, dims });
            } else if (message.type === 'error') {
                const item = pending.get(message.id);
                if (item) {
                    clearTimeout(item.timer);
                    pending.delete(message.id);
                    item.reject(new Error(message.message || '向量模型出错'));
                }
                lastError = String(message.message || '向量模型出错');
                if (state === 'starting') state = 'error';
            }
        });
        proc.on('close', (code, signal) => {
            if (child !== proc) return;
            child = null;
            const intentional = proc.__intentionalStop;
            rejectPending(`向量模型进程退出（${code ?? signal ?? 'unknown'}）`, proc);
            if (intentional) {
                if (state !== 'unavailable') state = 'idle';
                return;
            }
            if (state === 'unavailable') return;
            const now = Date.now();
            restartTimes = restartTimes.filter((at) => now - at < RESTART_WINDOW_MS);
            restartTimes.push(now);
            if (restartTimes.length > MAX_RESTARTS) {
                state = 'unavailable';
                const detail = stderr.trim();
                lastError = detail
                    ? `向量模型连续崩溃：${detail.slice(-300)}`
                    : '向量模型连续崩溃，已停止自动重启';
                return;
            }
            state = 'starting';
            if (stderr.trim()) lastError = stderr.trim().slice(-300);
            scheduleRestart();
        });
        proc.on('error', (err) => {
            if (child !== proc) return;
            lastError = err?.message || String(err);
        });

        sendRequest(proc, ['warmup'], 'document', timeoutMs)
            .then(({ dims: loadedDims }) => {
                if (child === proc) {
                    dims = loadedDims || dims;
                    state = 'ready';
                    lastError = '';
                    noteActivity();
                }
                resolve(status());
            })
            .catch((err) => {
                if (child === proc) {
                    lastError = err?.message || String(err);
                    if (state === 'starting') state = 'error';
                }
                resolve(status());
            });
    });

    startPromise = promise;
    promise.finally(() => {
        if (startPromise === promise) startPromise = null;
    });
    return promise;
}

export async function warmEmbedder({ timeoutMs = 300000 } = {}) {
    if (isFake()) {
        state = 'ready';
        model = FAKE_MODEL;
        dims = FAKE_DIMS;
        lastError = '';
        return status();
    }
    if (state === 'ready' && child) {
        noteActivity();
        return status();
    }
    if (state === 'unavailable') restartTimes = [];
    return launch({ timeoutMs });
}

export async function embedQuery(text, { timeoutMs = 2000 } = {}) {
    const input = String(text ?? '');
    if (!input.trim()) return null;
    if (isFake()) {
        if (state !== 'ready') {
            state = 'ready';
            model = FAKE_MODEL;
            dims = FAKE_DIMS;
        }
        return fakeVector(`${QUERY_PREFIX}${input}`);
    }
    if (state !== 'ready' || !child) {
        if (state === 'idle' || state === 'error') {
            warmEmbedder().catch(() => {});
        }
        return null;
    }
    try {
        const result = await sendRequest(child, [input], 'query', timeoutMs);
        noteActivity();
        return result.vectors[0] || null;
    } catch (err) {
        lastError = err?.message || String(err);
        return null;
    }
}

export async function embedBatch(texts, { onProgress = null, timeoutMs = 300000, batchSize = 32 } = {}) {
    const list = (Array.isArray(texts) ? texts : []).map((text) => String(text ?? ''));
    if (!list.length) return [];
    if (isFake()) {
        state = 'ready';
        model = FAKE_MODEL;
        dims = FAKE_DIMS;
        const out = list.map(fakeVector);
        onProgress?.({ done: out.length, total: out.length });
        return out;
    }

    const ready = await warmEmbedder({ timeoutMs });
    if (ready.state !== 'ready' || !child) {
        throw new Error(ready.error || '向量模型不可用');
    }

    const size = Math.max(1, Math.min(128, Number(batchSize) || 32));
    const deadline = Date.now() + Math.max(1, timeoutMs);
    const out = [];
    for (let start = 0; start < list.length; start += size) {
        const chunk = list.slice(start, start + size);
        const remaining = Math.max(1, deadline - Date.now());
        const result = await sendRequest(child, chunk, 'document', remaining);
        out.push(...result.vectors);
        noteActivity();
        onProgress?.({ done: out.length, total: list.length });
        if (out.length < list.length && Date.now() >= deadline) {
            throw new Error(`向量模型请求超时（${timeoutMs}ms）`);
        }
    }
    return out;
}

export function embedStatus() {
    if (isFake() && state !== 'ready') {
        return {
            state: 'ready',
            model: FAKE_MODEL,
            dims: FAKE_DIMS,
            error: '',
            cache_dir: cacheDir(),
        };
    }
    return status();
}

export function shutdownEmbedder() {
    clearIdleTimer();
    startPromise = null;
    stopWorker('向量模型已关闭');
    state = 'idle';
    lastError = '';
    return status();
}

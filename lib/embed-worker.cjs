/**
 * 向量模型子进程。
 *
 * 由 lib/embed.js fork，必须保持 CJS：Electron 内置的 transformers
 * 通过 createRequire 从 app.asar 里加载，避免主进程被 62 秒冷启动阻塞。
 */

const { mkdirSync } = require('node:fs');
const { createRequire } = require('node:module');

const MODEL = 'Xenova/bge-small-zh-v1.5';
const transformersPath = String(process.env.STICKER_TRANSFORMERS_PATH || '');
const cacheDir = String(process.env.STICKER_MODEL_CACHE || process.env.ALMA_EMBED_CACHE || '');
let extractorPromise = null;
let sentReady = false;
let chain = Promise.resolve();

if (cacheDir) {
    try {
        mkdirSync(cacheDir, { recursive: true });
    } catch {
        // 让 pipeline 自己报缓存目录错误，主进程会把失败记进状态。
    }
}

async function load() {
    if (!transformersPath) throw new Error('没有找到 @huggingface/transformers');
    const requireFromHere = createRequire(__filename);
    const mod = requireFromHere(transformersPath);
    const { pipeline, env } = mod?.pipeline ? mod : mod?.default || mod;
    if (typeof pipeline !== 'function') throw new Error('transformers 包没有导出 pipeline');
    if (cacheDir && env) env.cacheDir = cacheDir;
    return pipeline('feature-extraction', MODEL, { dtype: 'q8' });
}

function extractor() {
    if (!extractorPromise) {
        extractorPromise = load().then((pipe) => {
            if (!sentReady) {
                sentReady = true;
                process.send?.({ type: 'ready', model: MODEL });
            }
            return pipe;
        });
    }
    return extractorPromise;
}

function normalize(vector) {
    let sum = 0;
    for (const value of vector) sum += value * value;
    const norm = Math.sqrt(sum);
    if (!Number.isFinite(norm) || norm === 0) return vector;
    return vector.map((value) => value / norm);
}

async function embed(texts) {
    const pipe = await extractor();
    if (!Array.isArray(texts) || !texts.length) return [];
    const output = await pipe(texts, { pooling: 'cls', normalize: true });
    const raw = typeof output?.tolist === 'function' ? output.tolist() : output;
    let vectors;
    if (Array.isArray(raw) && Array.isArray(raw[0])) vectors = raw;
    else if (Array.isArray(raw) && typeof raw[0] === 'number') vectors = [raw];
    else throw new Error('模型返回了无法识别的向量格式');
    const dims = vectors[0]?.length || 0;
    if (!dims) throw new Error('模型返回了空向量');
    return vectors.map((vector) => {
        if (!Array.isArray(vector) || vector.length !== dims) {
            throw new Error('模型返回的向量维度不一致');
        }
        return normalize(vector.map(Number));
    });
}

process.on('message', (message) => {
    if (!message || message.type !== 'embed') return;
    const id = message.id;
    const texts = Array.isArray(message.texts) ? message.texts.map((text) => String(text ?? '')) : [];
    // 串行推理：构建批次不应与用户查询抢同一份 ONNX 会话。
    const task = chain.then(() => embed(texts), () => embed(texts));
    chain = task.catch(() => {});
    task.then((vectors) => {
        process.send?.({
            type: 'result',
            id,
            dims: vectors[0]?.length || 0,
            vectors,
        });
    }).catch((err) => {
        const fatal = !sentReady;
        process.send?.({ type: 'error', id, message: err?.message || String(err) }, () => {
            if (fatal) process.exit(1);
        });
    });
});

process.on('disconnect', () => process.exit(0));

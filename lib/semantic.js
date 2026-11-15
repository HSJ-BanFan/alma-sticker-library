/**
 * 语义化任务、描述与向量索引。
 *
 * 视觉模型为每张图生成中文描述与标签，本地 bge 模型把描述编码成向量。
 * 检索优先走向量索引；模型不可用或索引缺失时退回描述词项匹配。
 * 原始描述仍写入 AstrBot 兼容的 semantic_metadata.json。
 */

import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    fileDataUrl, fileSha256, nowIso, readJson, sha256, tokenize, writeJsonAtomic,
} from './util.js?v=0.3.1-codex-20261114';
import {
    entryRelPath, imagesByCategory, loadSemanticMetadata, moveImage, packDir,
    saveSemanticMetadata, semanticPathMap, semanticSummary,
} from './store.js?v=0.3.1-codex-20261114';
import { getSetting } from './settings.js?v=0.3.1-codex-20261114';
import { CATEGORY_SYNONYMS } from './search.js?v=0.3.1-codex-20261114';
import * as indexJob from './index-job.js?v=0.3.1-codex-20261114';
import { embedQuery, shutdownEmbedder, warmEmbedder } from './embed.js?v=0.3.1-codex-20261114';
import { loadIndex, rankIndex } from './semantic-index.js?v=0.3.1-codex-20261114';

const PROMPT_VERSION = 'alma-meme-caption-v1';
const INDEX_BUILD_DEBOUNCE_MS = 3000;
const indexBuildTimers = new Map();
const jobs = new Map();
const runtime = {
    apiBase: '',
    models: null,
    modelsAt: 0,
    lastVision: '',
    logger: null,
};

export function configure(host = {}) {
    if (host.logger) runtime.logger = host.logger;
    if (host.apiBase) runtime.apiBase = host.apiBase;
}

function log(level, ...args) {
    const fn = runtime.logger?.[level];
    if (typeof fn === 'function') fn('[语义化]', ...args);
}

// ------------------------------------------------------------------ Alma 模型
const DEFAULT_BASES = ['http://127.0.0.1:23001', 'http://localhost:23001'];

export async function almaApiBase({ refresh = false } = {}) {
    if (runtime.apiBase && !refresh) return runtime.apiBase;
    const override = process.env.ALMA_API_BASE || getSetting('semantic.alma_api_base', '');
    const candidates = override ? [String(override).replace(/\/$/, '')] : DEFAULT_BASES;
    for (const base of candidates) {
        try {
            const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1200) });
            if (res.ok) {
                runtime.apiBase = base;
                return base;
            }
        } catch {
            // 继续找
        }
    }
    if (runtime.apiBase) return runtime.apiBase;
    throw new Error('连不上 Alma 本地 API（默认 127.0.0.1:23001）。请确认 Alma 正在运行。');
}

export async function listModels({ refresh = false } = {}) {
    if (!refresh && runtime.models && Date.now() - runtime.modelsAt < 60_000) return runtime.models;
    const base = await almaApiBase();
    const res = await fetch(`${base}/api/models`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`读取模型列表失败: HTTP ${res.status}`);
    const data = await res.json();
    const models = [];
    for (const item of Array.isArray(data?.data) ? data.data : []) {
        const modelId = String(item.id || '');
        const providerId = String(item.providerId || '');
        if (!modelId || !providerId) continue;
        models.push({
            id: `${providerId}:${modelId}`,
            model: modelId,
            providerId,
            provider: String(item.providerName || providerId),
            name: String(item.name || modelId),
            vision: Boolean(item.capabilities?.vision),
        });
    }
    runtime.models = models;
    runtime.modelsAt = Date.now();
    const firstVision = models.find((item) => item.vision);
    if (firstVision) runtime.lastVision = firstVision.id;
    return models;
}

export async function visionModels() {
    const models = await listModels();
    return models.filter((item) => item.vision);
}

function parseModel(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const pos = raw.indexOf(':');
    if (pos <= 0) return null;
    return raw;
}

export async function resolveVisionModel() {
    const configured = parseModel(getSetting('semantic.vision_provider_id', ''));
    if (configured) return configured;
    const auto = parseModel(getSetting('auto_collect.vision_provider_id', ''));
    if (auto) return auto;
    try {
        const models = await visionModels();
        const found = models[0]?.id || '';
        if (found) runtime.lastVision = found;
        return found;
    } catch {
        return runtime.lastVision || '';
    }
}

/**
 * 候选视觉模型：首选配置里的模型，其余作为兜底。
 * 有些网关的「视觉模型」实际收不到图片（返回空内容），任务会自动切换。
 */
async function visionCandidates(primary) {
    try {
        const models = await visionModels();
        const others = models.map((item) => item.id).filter((id) => id && id !== primary);
        return [primary, ...others].slice(0, 8);
    } catch {
        return [primary];
    }
}

function rotateVisionModel(job, err) {
    job.lastError = err.message;
    if (!Array.isArray(job.candidates) || job.candidates.length < 2) return;
    job.modelFailures = (job.modelFailures || 0) + 1;
    // 一次失败可能只是网络抖动；连续两次才换模型。
    if (job.modelFailures < 2) return;
    job.modelFailures = 0;
    job.candidates.push(job.candidates.shift());
    job.model = job.candidates[0];
    log('warn', `视觉模型连续失败，切换到 ${job.model}`);
}

/**
 * Gemini 不能走 /api/chat/completions：宿主会给带 "gemini" 的模型自动注入
 * AttemptCompletion 工具，模型改用工具调用收尾，非流式接口只取 text，
 * 于是返回空字符串（token 照扣）。/anthropic-proxy 不做这层注入，图片也支持。
 */
function toAnthropicMessages(messages) {
    const system = [];
    const out = [];
    for (const message of Array.isArray(messages) ? messages : []) {
        const parts = Array.isArray(message?.parts) ? message.parts : [];
        if (message?.role === 'system') {
            for (const part of parts) {
                if (part?.type === 'text') system.push(String(part.text || ''));
            }
            continue;
        }
        const content = [];
        for (const part of parts) {
            if (part?.type === 'text') {
                content.push({ type: 'text', text: String(part.text || '') });
                continue;
            }
            const match = /^data:([^;]+);base64,(.+)$/s.exec(String(part?.url || ''));
            if (part?.type === 'file' && match) {
                content.push({
                    type: 'image',
                    source: { type: 'base64', media_type: match[1], data: match[2] },
                });
            }
        }
        if (!content.length) continue;
        const role = message?.role === 'assistant' ? 'assistant' : 'user';
        const last = out[out.length - 1];
        if (last?.role === role) last.content.push(...content);
        else out.push({ role, content });
    }
    return { system: system.join('\n').trim(), messages: out };
}

async function anthropicCompletion({ base, model, messages, timeout }) {
    const pos = model.indexOf(':');
    const providerId = model.slice(0, pos);
    const modelId = model.slice(pos + 1);
    const body = toAnthropicMessages(messages);
    const res = await fetch(`${base}/anthropic-proxy/${encodeURIComponent(providerId)}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            model: modelId,
            max_tokens: 2048,
            ...(body.system ? { system: body.system } : {}),
            messages: body.messages,
        }),
        signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!Array.isArray(data?.content)) return null;
    return data.content
        .filter((block) => block?.type === 'text')
        .map((block) => String(block.text || ''))
        .join('');
}

export async function chatCompletion({ model, messages, timeout = 120000 }) {
    const base = await almaApiBase();
    if (/gemini/i.test(String(model || ''))) {
        const viaProxy = await anthropicCompletion({ base, model, messages, timeout }).catch(() => null);
        if (viaProxy) return viaProxy;
    }
    const res = await fetch(`${base}/api/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: false }),
        signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`模型调用失败 HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const type = String(res.headers.get('content-type') || '');
    if (type.includes('application/json')) {
        const data = await res.json();
        return String(data?.choices?.[0]?.message?.content ?? data?.content ?? data?.text ?? '');
    }
    const text = await res.text();
    // 有些实现即使 stream=false 也返回 SSE，这里兜底拼起来。
    if (/^\s*data:/m.test(text)) {
        let out = '';
        for (const line of text.split(/\r?\n/)) {
            const match = /^data:\s*(.*)$/.exec(line.trim());
            if (!match || match[1] === '[DONE]') continue;
            try {
                const chunk = JSON.parse(match[1]);
                const delta = chunk?.choices?.[0]?.delta?.content;
                if (typeof delta === 'string') out += delta;
                else if (typeof chunk?.choices?.[0]?.message?.content === 'string') out += chunk.choices[0].message.content;
            } catch {
                // 忽略坏行
            }
        }
        return out;
    }
    return text;
}

// ------------------------------------------------------------------ 标注
function stripJson(text) {
    const raw = String(text || '').trim();
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
    const body = fenced ? fenced[1] : raw;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        return JSON.parse(body.slice(start, end + 1));
    } catch {
        return null;
    }
}

function normalizeTags(tags, category) {
    const out = [];
    if (category) out.push(`category:${category}`);
    for (const tag of Array.isArray(tags) ? tags : []) {
        const text = String(tag || '').trim().replace(/^#/, '');
        if (text && !out.includes(text) && text.length <= 24) out.push(text);
    }
    return out.slice(0, 16);
}

async function captionImage({ model, category, description, dataUrl }) {
    const system = [
        '你是表情包标注助手。只输出一个 JSON 对象，不要 markdown、不要解释。',
        '根据图片内容与所属分类，生成便于检索的中文语义标注。',
        'JSON 字段：',
        'caption: 80-160 字，描述画面主体、人物动作/表情、图中文字、传达的情绪态度，以及适合在什么对话场景使用。',
        'visible_text: 图中清晰可读的文字，原样转写；没有则为空字符串。',
        'use_when: 15-35 字，写"对方说了什么话、处在什么处境"时这张图合适，要能直接当检索条件用。',
        'avoid_when: 10-30 字，写一个表面相似但用出去会不合时宜的情况。',
        'tags: 6-12 个中文短标签，覆盖情绪、动作、梗、适用场景。',
        'category_fit: "match" | "uncertain" | "mismatch"，图片与给定分类的贴合程度。',
        'suggested_category: 仅当 category_fit 为 mismatch 时，填写更合适的现有分类名，否则空字符串。',
        '描述要具体，不要写“一张表情包”这类空话。',
    ].join('\n');
    const userText = [
        `分类：${category || '未分类'}`,
        description ? `分类说明：${description}` : '',
        '请标注这张表情。',
    ].filter(Boolean).join('\n');

    // Alma 的 /api/chat/completions 接收内部 parts 结构，不是 OpenAI 的
    // {role, content} 结构。图片必须是 AI SDK 的 file part
    // （{type:'file', mediaType, url}），旧的 {type:'image'} 会被静默丢弃。
    const messages = [
        { role: 'system', parts: [{ type: 'text', text: system }] },
        {
            role: 'user',
            parts: [
                { type: 'text', text: userText },
                { type: 'file', mediaType: dataUrl.slice(5, dataUrl.indexOf(';')), url: dataUrl },
            ],
        },
    ];
    const content = await chatCompletion({ model, messages });
    const parsed = stripJson(content);
    if (!parsed) {
        const text = String(content || '').trim();
        if (!text) throw new Error(`${model} 没有返回内容（可能不支持图片，或网关没有开启视觉）`);
        return {
            caption: text.slice(0, 400),
            visible_text: '',
            use_when: '',
            avoid_when: '',
            tags: normalizeTags([], category),
            category_fit: 'uncertain',
            suggested_category: '',
        };
    }
    const captionText = String(parsed.caption || '').trim();
    if (!captionText) {
        throw new Error(`${model} 返回的标注缺少 caption 字段`);
    }
    return {
        caption: captionText.slice(0, 800),
        visible_text: String(parsed.visible_text || '').trim().slice(0, 300),
        use_when: String(parsed.use_when || '').trim().slice(0, 120),
        avoid_when: String(parsed.avoid_when || '').trim().slice(0, 120),
        tags: normalizeTags(parsed.tags, category),
        category_fit: ['match', 'uncertain', 'mismatch'].includes(parsed.category_fit)
            ? parsed.category_fit : 'uncertain',
        suggested_category: String(parsed.suggested_category || '').trim(),
    };
}
// ------------------------------------------------------------------ 任务
function jobFor(packId) {
    return jobs.get(packId) || null;
}

function saveTaskState(packId, job) {
    try {
        const data = {
            pack_id: packId,
            task_status: job?.status || 'idle',
            task_phase: job?.phase || '',
            concurrency: job?.concurrency || 1,
            started_at: job?.startedAt || '',
            updated_at: nowIso(),
            last_error: job?.lastError || '',
            current: job?.current ? [...job.current] : [],
        };
        writeJsonAtomic(join(packDir(packId), 'semantic_task.json'), data);
    } catch {
        // 状态写不进去不影响任务
    }
}

/** 同一张图出现在多个路径时，各自保留一条记录，避免互相覆盖路径映射。 */
function entryKeyFor(meta, digest, rel) {
    const existing = meta.images[digest];
    if (!existing) return digest;
    if (entryRelPath(existing) === rel) return digest;
    return `${digest}#${rel}`;
}

function buildWorkList(packId, { force = false, onlyFailed = false } = {}) {
    const { map } = semanticPathMap(packId);
    const work = [];
    for (const [category, files] of Object.entries(imagesByCategory(packId))) {
        for (const filename of files) {
            const rel = `${category}/${filename}`;
            const hit = map.get(rel);
            const entry = hit?.entry;
            const done = entry && String(entry.caption || '').trim()
                && entry.caption_status !== 'failed' && entry.caption_status !== 'pending';
            if (onlyFailed) {
                if (entry?.caption_status === 'failed' || entry?.error) {
                    work.push({ category, filename, rel });
                }
                continue;
            }
            if (!force && done) continue;
            work.push({ category, filename, rel });
        }
    }
    return work;
}

function serialWriter(packId, meta, job = null) {
    let chain = Promise.resolve();
    return (mutate) => {
        chain = chain.then(() => {
            // 任务被取消或数据被清空后，旧快照不能再写回。
            if (job?.aborted) return;
            mutate(meta);
            saveSemanticMetadata(packId, meta);
        });
        return chain;
    };
}

export async function start(packId, { force = false, concurrency = null } = {}) {
    const existing = jobFor(packId);
    if (existing?.status === 'running') return status(packId);
    if (existing?.status === 'paused') return resume(packId);

    const model = await resolveVisionModel();
    if (!model) {
        throw new Error('还没有可用的视觉模型。请先在设置中心选择图片描述模型。');
    }
    const candidates = await visionCandidates(model);
    // 两个请求同时进来时，等 Await 结束后再确认没有人抢先建任务。
    const raced = jobFor(packId);
    if (raced?.status === 'running') return status(packId);
    const limit = Math.max(1, Math.min(8, Number(concurrency) || Number(getSetting('webui.preview_concurrency', 2)) || 2));
    const work = buildWorkList(packId, { force });
    const job = {
        packId,
        status: 'running',
        phase: 'caption',
        model,
        candidates,
        modelFailures: 0,
        concurrency: limit,
        queue: work,
        current: new Set(),
        completed: 0,
        failed: 0,
        total: work.length,
        startedAt: nowIso(),
        lastError: '',
        paused: false,
        retryMode: Boolean(force),
        aborted: false,
        activeWorkers: 0,
    };
    jobs.set(packId, job);
    saveTaskState(packId, job);
    if (!work.length) {
        job.status = 'idle';
        job.phase = '';
        saveTaskState(packId, job);
        return status(packId);
    }
    runJob(job).catch((err) => {
        job.status = 'idle';
        job.lastError = err.message;
        log('error', err);
    });
    return status(packId);
}

async function runJob(job) {
    const { packId } = job;
    const meta = loadSemanticMetadata(packId);
    if (!meta.images) meta.images = {};
    const write = serialWriter(packId, meta, job);
    const descriptions = categoryDescriptionsFor(packId);
    const workers = Array.from({ length: job.concurrency }, () => worker());

    async function processOne(item) {
        const { category, filename, rel } = item;
        const full = join(packDir(packId), 'memes', category, filename);
        if (!existsSync(full)) {
            job.failed += 1;
            return;
        }
        job.current.add(rel);
        let model = job.model;
        try {
            const digest = fileSha256(full);
            // 同一内容已经标过，直接复用，避免重复花钱；强制重新生成时不复用。
            let reused = null;
            if (!job.retryMode) {
                for (const [id, entry] of Object.entries(meta.images)) {
                    if (entry?.content_sha256 === digest
                        && entryRelPath(entry) !== rel
                        && String(entry.caption || '').trim()
                        && entry.caption_status !== 'failed') {
                        reused = { id, entry };
                        break;
                    }
                }
            }
            if (reused) {
                await write(() => {
                    // 键要在写入时再算，避免并发时两个 worker 抢同一个键。
                    const key = entryKeyFor(meta, digest, rel);
                    meta.images[key] = {
                        ...reused.entry,
                        content_sha256: digest,
                        entry_id: digest,
                        relative_path: `memes/${rel}`,
                        file: rel,
                        category,
                        category_description: descriptions[category] || '',
                        category_tag: `category:${category}`,
                        updated_at: nowIso(),
                    };
                });
                job.completed += 1;
                return;
            }

            const dataUrl = fileDataUrl(full);
            if (!dataUrl) throw new Error('图片过大，无法读取');
            let result;
            try {
                result = await captionImage({
                    model,
                    category,
                    description: descriptions[category] || '',
                    dataUrl,
                });
            } catch (err) {
                rotateVisionModel(job, err);
                throw err;
            }
            const entry = {
                content_sha256: digest,
                relative_path: `memes/${rel}`,
                file: rel,
                entry_id: digest,
                category,
                category_description: descriptions[category] || '',
                category_tag: `category:${category}`,
                category_fit: result.category_fit,
                category_review_status: 'auto_match',
                category_review_reason: '',
                suggested_category: result.suggested_category,
                caption: result.caption,
                tags: result.tags,
                visible_text: result.visible_text,
                use_when: result.use_when,
                avoid_when: result.avoid_when,
                caption_status: 'done',
                embedding_status: 'done',
                embedding_mode: 'descriptions',
                provenance: 'ai',
                vision_model: model,
                prompt_version: PROMPT_VERSION,
                text_hash: sha256(`${result.caption}\n${result.visible_text}`),
                updated_at: nowIso(),
                error: null,
            };
            await write(() => {
                const key = entryKeyFor(meta, digest, rel);
                meta.images[key] = entry;
            });
            job.modelFailures = 0;
            job.completed += 1;
        } catch (err) {
            job.failed += 1;
            job.lastError = err.message;
            try {
                const digest = fileSha256(full);
                await write(() => {
                    const key = entryKeyFor(meta, digest, rel);
                    meta.images[key] = {
                        ...(meta.images[key] || {}),
                        content_sha256: digest,
                        relative_path: `memes/${rel}`,
                        file: rel,
                        category,
                        caption_status: 'failed',
                        error: err.message,
                        vision_model: model,
                        updated_at: nowIso(),
                    };
                });
            } catch {
                // 忽略记录失败
            }
            log('warn', `${rel}: ${err.message}`);
        } finally {
            job.current.delete(rel);
        }
    }

    async function worker() {
        job.activeWorkers = (job.activeWorkers || 0) + 1;
        try {
            while (!job.paused && !job.aborted) {
                const item = job.queue.shift();
                if (!item) break;
                await processOne(item);
            }
        } finally {
            job.activeWorkers = Math.max(0, (job.activeWorkers || 1) - 1);
        }
    }

    await Promise.all(workers);
    // 所有 worker 都退出后才收尾；暂停时把状态留给 resume。
    if (!job.paused && !job.aborted && job.activeWorkers === 0) {
        job.status = 'idle';
        job.phase = '';
        job.finishedAt = nowIso();
        saveTaskState(packId, job);
        log('info', `任务结束：成功 ${job.completed}，失败 ${job.failed}`);
        scheduleIndexBuild(packId);
    }
}

function scheduleIndexBuild(packId) {
    const previous = indexBuildTimers.get(packId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
        indexBuildTimers.delete(packId);
        indexJob.buildIndex(packId).catch((err) => {
            log('warn', `向量索引构建失败: ${err.message}`);
        });
    }, INDEX_BUILD_DEBOUNCE_MS);
    timer.unref?.();
    indexBuildTimers.set(packId, timer);
}

function categoryDescriptionsFor(packId) {
    try {
        // 延迟导入避免循环依赖问题
        return loadDescriptions(packId);
    } catch {
        return {};
    }
}

function loadDescriptions(packId) {
    const manifest = readJson(join(packDir(packId), 'manifest.json'), {});
    const data = readJson(join(packDir(packId), 'memes_data.json'), {});
    const out = {};
    for (const [key, value] of Object.entries(manifest.categories || {})) {
        const text = typeof value === 'string' ? value : value?.description;
        if (text) out[key] = String(text);
    }
    for (const [key, value] of Object.entries(data || {})) {
        const text = typeof value === 'string' ? value : value?.description;
        if (text) out[key] = String(text);
    }
    return out;
}

/** 卸载或覆盖安装前停掉任务，避免后台继续写已删除的包。 */
export function stopJob(packId) {
    const job = jobFor(packId);
    if (!job) return { stopped: false };
    job.paused = true;
    job.aborted = true;
    job.status = 'idle';
    jobs.delete(packId);
    return { stopped: true };
}

export function pause(packId) {
    const job = jobFor(packId);
    if (!job) return { message: '当前没有运行中的语义化任务。' };
    job.paused = true;
    job.status = 'paused';
    saveTaskState(packId, job);
    return { message: '已暂停，当前请求结束后停止取新图片。' };
}

export function resume(packId) {
    const job = jobFor(packId);
    if (!job) return start(packId, {});
    if (job.status === 'running') return status(packId);
    job.paused = false;
    job.aborted = false;
    job.status = 'running';
    job.phase = 'caption';
    job.retryMode = false;
    saveTaskState(packId, job);
    // 暂停时仍有一个请求在飞：让它继续消费队列，不再起第二套 worker。
    if ((job.activeWorkers || 0) > 0) return status(packId);
    runJob(job).catch((err) => {
        job.status = 'idle';
        job.lastError = err.message;
        log('error', err);
    });
    return status(packId);
}

export async function retry(packId, { concurrency = null } = {}) {
    const existing = jobFor(packId);
    if (existing?.status === 'running') return status(packId);
    const job = existing || {
        packId, status: 'idle', phase: '', model: '', concurrency: 1,
        queue: [], current: new Set(), completed: 0, failed: 0, total: 0,
        startedAt: nowIso(), lastError: '', paused: false,
    };
    const work = buildWorkList(packId, { onlyFailed: true });
    if (!work.length) return { ...status(packId), message: '没有失败项需要重试。' };
    job.model = await resolveVisionModel();
    if (!job.model) throw new Error('还没有可用的视觉模型，请先在设置中心选择图片描述模型。');
    job.candidates = await visionCandidates(job.model);
    job.modelFailures = 0;
    job.aborted = false;
    job.activeWorkers = 0;
    job.queue = work;
    job.total = work.length;
    job.completed = 0;
    job.failed = 0;
    job.status = 'running';
    job.phase = 'caption';
    job.paused = false;
    job.retryMode = true;
    job.concurrency = Math.max(1, Math.min(8, Number(concurrency) || job.concurrency || 2));
    job.startedAt = nowIso();
    jobs.set(packId, job);
    saveTaskState(packId, job);
    runJob(job).catch((err) => {
        job.status = 'idle';
        job.lastError = err.message;
        log('error', err);
    });
    return status(packId);
}

export function clearLocalState(packId) {
    const job = jobFor(packId);
    if (job) {
        job.paused = true;
        job.status = 'idle';
        job.queue = [];
        job.current.clear();
        saveTaskState(packId, job);
    }
    jobs.delete(packId);
    indexJob.deleteIndexFor(packId);
    return { message: '已清空任务队列与向量索引，已生成的描述保留。' };
}

export function deleteAll(packId) {
    const job = jobFor(packId);
    if (job) {
        job.paused = true;
        // 已发出的请求可能晚于删除返回；标记后写入器会丢弃旧快照。
        job.aborted = true;
        jobs.delete(packId);
    }
    const metaPath = join(packDir(packId), 'semantic_metadata.json');
    writeJsonAtomic(metaPath, { images: {} });
    for (const name of ['semantic_task.json']) {
        const path = join(packDir(packId), name);
        if (existsSync(path)) {
            try { writeFileSync(path, '{}'); } catch { /* 忽略 */ }
        }
    }
    indexJob.deleteIndexFor(packId);
    return { message: '已删除当前图包的语义描述、任务状态与向量索引。' };
}

export function rebuildIndex(packId) {
    indexJob.buildIndex(packId).catch((err) => {
        log('warn', `向量索引重建失败: ${err.message}`);
    });
    const vectorIndex = indexJob.indexStatus(packId);
    const message = vectorIndex.captioned_total
        ? '向量索引构建已在后台开始，完成后检索会自动切换。'
        : '还没有可索引的图片描述，先运行语义化任务。';
    return {
        message,
        index_ready: vectorIndex.state === 'fresh',
        rebuild_started: vectorIndex.state === 'building',
        ...vectorIndex,
        vector_index: vectorIndex,
    };
}

export function status(packId) {
    const summary = semanticSummary(packId);
    const job = jobFor(packId);
    const vectorIndex = indexJob.indexStatus(packId);
    const complete = summary.semantic_complete;
    let taskStatus = 'idle';
    if (job?.status === 'running') taskStatus = 'running';
    else if (job?.status === 'paused') taskStatus = 'paused';
    const runningModel = job?.status === 'running' ? job.model : '';
    const configuredModel = runningModel
        || parseModel(getSetting('semantic.vision_provider_id', ''))
        || parseModel(getSetting('auto_collect.vision_provider_id', ''))
        || job?.model || runtime.lastVision || '';
    const queue = job?.queue?.length || 0;
    return {
        pack_id: packId,
        task_status: taskStatus,
        task_phase: job?.phase || '',
        status_message: taskStatus === 'running'
            ? `正在处理：${job.completed + job.failed}/${job.total}`
            : complete ? '全部图片已有描述' : '等待开始',
        worker_alive: Boolean(job && taskStatus === 'running'),
        concurrency: job?.concurrency || Number(getSetting('webui.preview_concurrency', 2)) || 2,
        queue_status: queue > 0 ? 'running' : 'empty',
        total_tasks: job?.total || summary.semantic_caption_total,
        queued_caption_tasks: queue,
        queued_embedding_tasks: vectorIndex.state === 'building'
            ? Math.max(0, (vectorIndex.progress?.total || 0) - (vectorIndex.progress?.done || 0))
            : 0,
        active_request_count: job?.current?.size || 0,
        other_active_tasks: 0,
        other_tasks_warning: '',
        caption_done: summary.semantic_caption_done,
        caption_failed: summary.semantic_caption_failed,
        caption_pending: Math.max(0, summary.semantic_caption_total - summary.semantic_caption_done - summary.semantic_caption_failed),
        embedding_done: vectorIndex.rows,
        embedding_failed: 0,
        file_total: summary.semantic_caption_total,
        unique_total: summary.semantic_caption_total,
        reused_duplicate_files: 0,
        reclassified_items: 0,
        total: summary.semantic_caption_total,
        elapsed_seconds: job?.startedAt
            ? Math.max(0, Math.round((Date.now() - Date.parse(job.startedAt)) / 1000))
            : 0,
        last_error: job?.lastError || '',
        vision_provider_id: configuredModel,
        vision_model: configuredModel || '未选择',
        vision_provider_ready: Boolean(configuredModel),
        embedding_provider_id: 'local-transformers',
        embedding_model: vectorIndex.model || '未构建',
        embedding_provider_ready: vectorIndex.state !== 'unavailable',
        embedding_configured_provider_id: 'local-transformers',
        embedding_configured_dimension: vectorIndex.dims || 0,
        embedding_verified_dimension: vectorIndex.dims || 0,
        index_embedding_dimension: vectorIndex.dims || 0,
        dimension_rebuild_required: vectorIndex.reason === 'model_mismatch'
            || vectorIndex.reason === 'dims_mismatch',
        semantic_enabled: Boolean(getSetting('semantic.enabled', true)),
        semantic_config_ready: Boolean(configuredModel) || complete,
        semantic_caption_complete: complete,
        index_ready: vectorIndex.state === 'fresh',
        vector_index: {
            state: vectorIndex.state,
            reason: vectorIndex.reason,
            model: vectorIndex.model,
            dims: vectorIndex.dims,
            rows: vectorIndex.rows,
            captioned_total: vectorIndex.captioned_total,
            built_at: vectorIndex.built_at,
            progress: vectorIndex.progress,
            error: vectorIndex.error,
        },
        can_resume: taskStatus === 'paused' || (queue > 0 && taskStatus !== 'running'),
        can_retry: summary.semantic_caption_failed > 0,
        auto_collect_inbox: { visible: false, count: 0, items: [], pack_id: packId },
        ...summary,
    };
}

export function items(packId, { page = 1, pageSize = 20, status: filter = 'all' } = {}) {
    const { map } = semanticPathMap(packId);
    const job = jobFor(packId);
    const rows = [];
    for (const [category, files] of Object.entries(imagesByCategory(packId))) {
        for (const filename of files) {
            const rel = `${category}/${filename}`;
            const entry = map.get(rel)?.entry || null;
            const running = Boolean(job?.current?.has(rel));
            const done = Boolean(entry && String(entry.caption || '').trim()
                && entry.caption_status !== 'failed' && entry.caption_status !== 'pending');
            const failed = Boolean(entry?.caption_status === 'failed' || entry?.error);
            let state = 'pending';
            if (running) state = 'running';
            else if (done) state = 'done';
            else if (failed) state = 'failed';
            const matches = (() => {
                if (!filter || filter === 'all') return true;
                if (filter === 'pending') return state === 'pending' || state === 'running';
                if (filter === 'running') return state === 'running';
                if (filter === 'failed') return state === 'failed';
                if (filter === 'caption_failed') return state === 'failed';
                if (filter === 'embedding_failed') return false;
                if (filter === 'caption_done') return state === 'done';
                if (filter === 'embedding_done') return state === 'done';
                if (filter === 'completed') return state === 'done';
                if (filter === 'reclassified') return Boolean(entry?.reclassification_status);
                return true;
            })();
            if (!matches) continue;
            rows.push({
                id: rel,
                category,
                filename,
                relative_path: rel,
                caption: entry?.caption || '',
                visible_text: entry?.visible_text || '',
                tags: Array.isArray(entry?.tags) ? entry.tags : [],
                caption_status: done ? 'done' : failed ? 'failed' : state === 'running' ? 'running' : 'pending',
                embedding_status: done ? 'done' : 'pending',
                error: entry?.error || '',
                updated_at: entry?.updated_at || '',
                category_fit: entry?.category_fit || '',
                suggested_category: entry?.suggested_category || '',
                reclassification_status: entry?.reclassification_status || '',
                reclassified_from_category: entry?.reclassified_from_category || '',
                reclassified_to_category: entry?.reclassified_to_category || '',
                reclassification_reason: entry?.reclassification_reason || '',
            });
        }
    }
    const total = rows.length;
    const size = Math.max(1, Math.min(200, Number(pageSize) || 20));
    const pages = Math.max(1, Math.ceil(total / size));
    const current = Math.max(1, Math.min(pages, Number(page) || 1));
    return {
        items: rows.slice((current - 1) * size, current * size),
        total,
        page: current,
        page_size: size,
        total_pages: pages,
    };
}

/** 语义化页面单独取图片用；与 meme_image_data 分开是为了 pack_id 语义清晰。 */
export function imageData(packId, category, filename, size = 'preview') {
    const full = join(packDir(packId), 'memes', category, filename);
    if (!existsSync(full)) throw new Error('图片不存在');
    const data = fileDataUrl(full, size === 'original' ? 48 * 1024 * 1024 : 24 * 1024 * 1024);
    if (!data) throw new Error('图片过大，无法预览');
    return { data_url: data, category, filename, size: statSync(full).size };
}

export function imageSemantic(packId, category, filename) {
    return {
        pack_id: packId,
        category,
        filename,
        semantic: describeImage(packId, category, filename),
    };
}

// ------------------------------------------------------------------ 单图编辑
const SNAPSHOT_FIELDS = [
    'caption', 'tags', 'visible_text', 'category_fit', 'suggested_category',
    'category_review_status', 'category_review_reason', 'caption_status',
    'text_hash', 'provenance', 'updated_at', 'reclassified_from_category',
    'reclassified_to_category', 'reclassification_status', 'reclassification_reason',
];

function snapshotOf(entry) {
    const out = {};
    for (const key of SNAPSHOT_FIELDS) {
        if (entry?.[key] !== undefined) out[key] = entry[key];
    }
    return out;
}

function normalizeManualTags(tags) {
    return normalizeTags(tags, '').filter((tag) => !tag.startsWith('category:')).slice(0, 16);
}

/**
 * 图片详情面板用的语义快照：补齐 status / 可编辑标记 / 同内容图片等派生字段，
 * 让源项目页面里的编辑、确认、恢复按钮能按预期显示。
 */
export function describeImage(packId, category, filename) {
    const rel = `${category}/${filename}`;
    const { map } = semanticPathMap(packId);
    const hit = map.get(rel) || null;
    const entry = hit?.entry || null;
    if (!entry) {
        return {
            status: 'none',
            category_tag: `category:${category}`,
            category_review_status: 'unchecked',
            can_edit_semantic: false,
            can_confirm_category: false,
            can_restore_auto: false,
            manual_modified: false,
            embedding_status: 'pending',
            tags: [],
            visible_text: '',
            same_content_paths: [],
        };
    }
    const caption = String(entry.caption || '').trim();
    const failed = entry.caption_status === 'failed' || Boolean(entry.error);
    const status = failed ? 'failed' : caption ? 'complete' : 'partial';
    const manual = entry.provenance === 'manual' || entry.manual_modified === true;
    const reviewStatus = String(entry.category_review_status || '');
    const suggested = String(entry.suggested_category || '').trim();
    const sameContent = [];
    if (entry.content_sha256) {
        for (const [otherRel, other] of map) {
            if (otherRel === rel) continue;
            if (other?.entry?.content_sha256 === entry.content_sha256) sameContent.push(otherRel);
        }
    }
    return {
        ...entry,
        status,
        entry_id: String(entry.entry_id || hit.id || ''),
        content_sha256: String(entry.content_sha256 || hit.id || ''),
        category_tag: entry.category_tag || `category:${category}`,
        caption,
        tags: Array.isArray(entry.tags) ? entry.tags : [],
        visible_text: String(entry.visible_text || ''),
        error: entry.error || '',
        category_review_status: reviewStatus
            || (entry.category_fit === 'mismatch' ? 'needs_review'
                : entry.category_fit === 'match' ? 'auto_match' : 'unchecked'),
        category_review_reason: entry.category_review_reason || '',
        can_edit_semantic: true,
        can_confirm_category: reviewStatus !== 'confirmed'
            && (entry.category_fit === 'mismatch' || Boolean(suggested) || reviewStatus === 'needs_review'),
        can_restore_auto: manual && Boolean(entry.ai_snapshot?.caption),
        manual_modified: manual,
        embedding_status: 'done',
        embedding_error: '',
        same_content_paths: sameContent,
    };
}

function loadEntryForEdit(payload, { requireEntry = true } = {}) {
    const packId = String(payload?.expected_pack_id || payload?.pack_id || '').trim();
    const category = String(payload?.category || '').trim();
    const filename = String(payload?.filename || '').trim();
    if (!packId || !category || !filename) throw new Error('缺少图片参数');
    const full = join(packDir(packId), 'memes', category, filename);
    if (!existsSync(full)) {
        const err = new Error('图片不存在或已被移动，请重新打开后再操作。');
        err.code = 'missing_file';
        throw err;
    }
    const expectedSha = String(payload?.expected_content_sha256 || '').trim();
    if (expectedSha && fileSha256(full) !== expectedSha) {
        const err = new Error('图片内容已经变化，请重新打开后再编辑。');
        err.code = 'conflict';
        throw err;
    }
    const meta = loadSemanticMetadata(packId);
    if (!meta.images || typeof meta.images !== 'object') meta.images = {};
    let hit = null;
    for (const [id, entry] of Object.entries(meta.images)) {
        if (entryRelPath(entry) === `${category}/${filename}`) {
            hit = { id, entry };
            break;
        }
    }
    if (requireEntry && !hit) {
        const err = new Error('这张图片还没有语义条目，请先在语义化页面生成描述。');
        err.code = 'missing_entry';
        throw err;
    }
    if (hit && payload?.expected_entry_id && String(payload.expected_entry_id) !== hit.id) {
        const err = new Error('这条语义记录已经变化，请重新打开后再编辑。');
        err.code = 'conflict';
        throw err;
    }
    return { packId, category, filename, full, meta, hit };
}

export function saveImageSemantic(payload = {}, { updateVector = false } = {}) {
    const { packId, category, filename, meta, hit } = loadEntryForEdit(payload);
    const caption = String(payload.caption || '').trim();
    if (!caption) throw new Error('图片含义不能为空。');
    const visibleText = String(payload.visible_text || '').trim().slice(0, 300);
    const targetCategory = updateVector ? String(payload.target_category || '').trim() : '';
    const decision = String(payload.category_decision || 'keep');
    const prev = hit.entry;
    const next = {
        ...prev,
        caption: caption.slice(0, 800),
        tags: normalizeManualTags(payload.tags),
        visible_text: visibleText,
        caption_status: 'done',
        error: null,
        provenance: 'manual',
        manual_modified: true,
        ai_snapshot: prev.ai_snapshot || (prev.provenance === 'manual' ? null : snapshotOf(prev)),
        embedding_status: 'done',
        embedding_mode: 'descriptions',
        text_hash: sha256(`${caption}\n${visibleText}`),
        updated_at: nowIso(),
    };
    if (decision === 'match') {
        next.category_fit = 'match';
        next.category_review_status = 'confirmed';
        next.category_review_reason = '人工确认分类';
        next.suggested_category = '';
    } else if (decision === 'mismatch') {
        next.category_fit = 'mismatch';
        next.category_review_status = 'needs_review';
    }
    meta.images[hit.id] = next;
    saveSemanticMetadata(packId, meta);

    let finalCategory = category;
    let finalFilename = filename;
    let moved = false;
    if (targetCategory && targetCategory !== category) {
        const result = moveImage(packId, category, targetCategory, filename);
        finalCategory = targetCategory;
        finalFilename = result.filename;
        moved = true;
    }
    return {
        message: moved ? '人工语义已保存，图片已移动到新分类。' : '人工语义已保存。',
        moved,
        category: finalCategory,
        filename: finalFilename,
        semantic: describeImage(packId, finalCategory, finalFilename),
        vector_update: { status: 'done' },
    };
}

export function restoreImageAuto(payload = {}) {
    const { packId, category, filename, meta, hit } = loadEntryForEdit(payload);
    const snapshot = hit.entry.ai_snapshot;
    if (!snapshot || !String(snapshot.caption || '').trim()) {
        throw new Error('这条记录没有可恢复的自动描述。');
    }
    const next = {
        ...hit.entry,
        ...snapshot,
        provenance: 'ai',
        manual_modified: false,
        ai_snapshot: null,
        error: null,
        caption_status: 'done',
        embedding_status: 'done',
        updated_at: nowIso(),
    };
    meta.images[hit.id] = next;
    saveSemanticMetadata(packId, meta);
    return {
        message: '已恢复为模型自动生成的内容。',
        semantic: describeImage(packId, category, filename),
    };
}

export function confirmImageCategory(payload = {}) {
    const { packId, category, filename, meta, hit } = loadEntryForEdit(payload);
    const next = {
        ...hit.entry,
        category_fit: 'match',
        category_review_status: 'confirmed',
        category_review_reason: '人工确认分类',
        suggested_category: '',
        updated_at: nowIso(),
    };
    meta.images[hit.id] = next;
    saveSemanticMetadata(packId, meta);
    return {
        message: '已保存人工确认。',
        semantic: describeImage(packId, category, filename),
    };
}

/**
 * 模型有时给的是英文近义词（speechless/smug/shocked），不是包里的分类键。
 * 只映射高置信度的，其余留给人审，避免把图随便挪进不相干的分类。
 */
const CATEGORY_ALIASES = {
    speechless: 'sigh', speechlessness: 'sigh', disdain: 'sigh', sigh: 'sigh',
    smug: 'teasing', tease: 'teasing', teasing: 'teasing', mocking: 'teasing', mockery: 'teasing',
    cute: 'affection', love: 'affection', affection: 'affection',
    shocked: 'surprised', shock: 'surprised', surprise: 'surprised', panic: 'surprised',
    awkward: 'confused', confused: 'confused', thinking: 'confused',
    tired: 'tired', collapse: 'tired', exhausted: 'tired', sleepy: 'sleep', sleep: 'sleep',
    sadness: 'sad', crying: 'sad', cry: 'sad', sad: 'sad',
    eat: 'eating', eating: 'eating', food: 'eating',
    observe: 'see', stare: 'see', watch: 'see',
    positive: 'happy', celebration: 'happy', happy: 'happy',
    threaten: 'angry', angry: 'angry', rage: 'angry',
    pride: 'approval', approval: 'approval', agree: 'approval',
    shy: 'shy', blush: 'shy', greeting: 'greeting', hello: 'greeting',
};

function resolveCategoryKey(categories, suggested) {
    const norm = String(suggested || '').trim().toLowerCase().replace(/_/g, '-');
    if (!norm) return '';
    for (const key of categories) {
        if (key.toLowerCase() === norm) return key;
    }
    const alias = CATEGORY_ALIASES[norm];
    if (alias) {
        for (const key of categories) {
            if (key.toLowerCase() === alias) return key;
        }
    }
    for (const key of categories) {
        const synonyms = String(CATEGORY_SYNONYMS[key] || '').split(/\s+/);
        if (synonyms.includes(norm)) return key;
    }
    return '';
}

export async function autoReclassify(packId, { dryRun = false } = {}) {
    const meta = loadSemanticMetadata(packId);
    const categories = new Set(Object.keys(imagesByCategory(packId)));
    const moves = [];
    for (const entry of Object.values(meta.images || {})) {
        if (entry?.category_fit !== 'mismatch') continue;
        const suggested = resolveCategoryKey(categories, entry.suggested_category);
        if (!suggested) continue;
        const rel = entryRelPath(entry);
        const pos = rel.indexOf('/');
        if (pos <= 0) continue;
        const category = rel.slice(0, pos);
        const filename = rel.slice(pos + 1);
        if (!category || !filename || category === suggested) continue;
        moves.push({ category, filename, suggested, rel });
    }

    if (dryRun) {
        return {
            pack_id: packId,
            dry_run: true,
            candidates: moves.length,
            moves: moves.slice(0, 100),
        };
    }

    const results = [];
    for (const move of moves) {
        try {
            const saved = moveImage(packId, move.category, move.suggested, move.filename);
            results.push({
                ...move,
                to: `${move.suggested}/${saved.filename}`,
                ok: true,
            });
        } catch (err) {
            results.push({ ...move, ok: false, error: err.message });
        }
    }

    const next = loadSemanticMetadata(packId);
    let updated = 0;
    for (const result of results.filter((item) => item.ok)) {
        for (const entry of Object.values(next.images || {})) {
            if (entryRelPath(entry) !== result.to) continue;
            Object.assign(entry, {
                category_fit: 'match',
                suggested_category: '',
                category_review_status: 'auto_reclassified',
                reclassified_from_category: result.category,
                reclassified_to_category: result.suggested,
                reclassification_status: 'auto',
                reclassification_reason: '按模型建议自动归类',
                updated_at: nowIso(),
            });
            updated += 1;
        }
    }
    if (updated) saveSemanticMetadata(packId, next);
    if (results.some((item) => item.ok)) {
        await indexJob.buildIndex(packId).catch(() => null);
    }

    return {
        pack_id: packId,
        moved: results.filter((item) => item.ok).length,
        failed: results.filter((item) => !item.ok).length,
        updated,
        moves: results,
    };
}

export async function proposeImageRevision(payload = {}) {
    const { category, full, hit } = loadEntryForEdit(payload, { requireEntry: false });
    const instruction = String(payload.review_instruction || '').trim();
    if (!instruction) throw new Error('请先写明希望模型怎样修改。');
    const model = await resolveVisionModel();
    if (!model) throw new Error('还没有可用的视觉模型。请先在设置中心选择图片描述模型。');
    const dataUrl = fileDataUrl(full);
    if (!dataUrl) throw new Error('图片过大，无法读取');
    const current = hit?.entry || {};
    const system = [
        '你是表情包标注复审助手。只输出一个 JSON 对象，不要 markdown、不要解释。',
        '按用户的复审意见重写标注，并重新判断图片与当前分类是否契合。',
        'JSON 字段：',
        'caption: 80-160 字中文描述，说明画面、动作、图中文字与适用场景。',
        'visible_text: 图中清晰可读的文字，原样转写；没有则为空字符串。',
        'tags: 6-12 个中文短标签。',
        'category_fit: "match" | "uncertain" | "mismatch"。',
        'suggested_category: 若分类不合适，给出更合适的分类键；否则空字符串。',
        'category_review_reason: 一句话说明分类判断依据。',
    ].join('\n');
    const userText = [
        `当前分类：${category}`,
        `当前描述：${String(current.caption || '无')}`,
        `当前可见文字：${String(current.visible_text || '无')}`,
        `用户复审意见：${instruction}`,
    ].join('\n');
    const messages = [
        { role: 'system', parts: [{ type: 'text', text: system }] },
        {
            role: 'user',
            parts: [
                { type: 'text', text: userText },
                { type: 'file', mediaType: dataUrl.slice(5, dataUrl.indexOf(';')), url: dataUrl },
            ],
        },
    ];
    const content = await chatCompletion({ model, messages });
    const parsed = stripJson(content) || {};
    const fit = ['match', 'mismatch', 'uncertain'].includes(parsed.category_fit)
        ? parsed.category_fit : 'uncertain';
    const selected = String(parsed.suggested_category || '').trim();
    let action = String(parsed.classification_action || '').trim();
    if (!action) {
        action = fit === 'match' ? 'keep_current' : selected ? 'move_to_other' : 'manual_required';
    }
    return {
        proposal: {
            caption: String(parsed.caption || '').trim(),
            tags: normalizeManualTags(parsed.tags),
            visible_text: String(parsed.visible_text || '').trim(),
            category_fit: fit,
            classification_action: action,
            current_category: category,
            original_category: String(current.reclassified_from_category || '').trim(),
            selected_category: selected,
            category_review_reason: String(parsed.category_review_reason || '').trim(),
        },
        vision_model: model,
    };
}

// ------------------------------------------------------------------ 检索
/**
 * 描述索引兜底：字段加权 + IDF，不依赖分词库。
 * caption 权重最高，visible_text 次之，tags 再次。
 */
function tokenSearch(packIds, query, {
    topK = 5, minScore = 0.02, category = null, allowed = null,
} = {}) {
    const qTokens = tokenize(query);
    if (!qTokens.size) return [];
    const ids = Array.isArray(packIds) ? packIds : [packIds].filter(Boolean);
    if (!ids.length) return [];

    const docs = [];
    for (const packId of ids) {
        const { map } = semanticPathMap(packId);
        const descriptions = loadDescriptions(packId);
        const seen = new Set();
        for (const [categoryName, files] of Object.entries(imagesByCategory(packId))) {
            if (category && categoryName !== category) continue;
            if (allowed && !allowed(categoryName)) continue;
            for (const filename of files) {
                const rel = `${categoryName}/${filename}`;
                const entry = map.get(rel)?.entry;
                if (!entry) continue;
                const caption = String(entry.caption || '');
                const visible = String(entry.visible_text || '');
                if (!caption && !visible) continue;
                const tags = Array.isArray(entry.tags) ? entry.tags.filter((t) => !String(t).startsWith('category:')) : [];
                const docTokens = new Map();
                const add = (text, weight) => {
                    for (const token of tokenize(text)) {
                        docTokens.set(token, Math.max(docTokens.get(token) || 0, weight));
                    }
                };
                add(caption, 1);
                add(visible, 1.25);
                add(String(entry.use_when || ''), 1);
                add(tags.join(' '), 0.8);
                add(descriptions[categoryName] || '', 0.5);
                add(CATEGORY_SYNONYMS[categoryName] || '', 0.6);
                if (!docTokens.size) continue;
                const key = `${packId}:${rel}`;
                if (seen.has(key)) continue;
                seen.add(key);
                docs.push({ packId, rel, category: categoryName, filename, entry, tokens: docTokens, caption, visible, tags });            }
        }
    }
    if (!docs.length) return [];

    const df = new Map();
    for (const doc of docs) {
        for (const token of doc.tokens.keys()) df.set(token, (df.get(token) || 0) + 1);
    }
    const N = docs.length;
    const scored = [];
    for (const doc of docs) {
        let score = 0;
        for (const token of qTokens) {
            const weight = doc.tokens.get(token);
            if (!weight) continue;
            const idf = Math.log(1 + N / (1 + (df.get(token) || 1)));
            score += weight * idf;
        }
        if (score <= 0) continue;
        const norm = Math.sqrt(qTokens.size) * Math.log(2 + doc.tokens.size);
        const final = score / norm;
        if (final < minScore) continue;
        scored.push({
            score: Math.round(final * 10000) / 10000,
            id: `${doc.packId}:${doc.rel}`,
            pack: doc.packId,
            entry_id: doc.rel,
            file: join(packDir(doc.packId), 'memes', doc.rel),
            relative_path: doc.rel,
            categories: [doc.category],
            category: doc.category,
            caption: doc.caption,
            visible_text: doc.visible,
            use_when: String(doc.entry?.use_when || ''),
            avoid_when: String(doc.entry?.avoid_when || ''),
            tags: doc.tags,
            retrieval: 'tokens',
        });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, topK));
}

function vectorHit(packId, hit, entry) {
    const rel = hit.row.rel;
    const tags = Array.isArray(entry?.tags)
        ? entry.tags.filter((tag) => !String(tag).startsWith('category:'))
        : [];
    return {
        score: hit.score,
        id: `${packId}:${rel}`,
        pack: packId,
        entry_id: rel,
        file: join(packDir(packId), 'memes', rel),
        relative_path: rel,
        categories: [hit.row.category],
        category: hit.row.category,
        caption: entry?.caption || '',
        visible_text: entry?.visible_text || '',
        use_when: String(entry?.use_when || ''),
        avoid_when: String(entry?.avoid_when || ''),
        tags,
        retrieval: 'vector',
    };
}

export async function search(packIds, query, {
    topK = 5, minScore = 0.02, category = null, excludeCategories = null,
} = {}) {
    const text = String(query || '').trim();
    if (!text) return [];
    const ids = Array.isArray(packIds) ? packIds : [packIds].filter(Boolean);
    if (!ids.length) return [];
    const limit = Math.max(1, Number(topK) || 5);
    // 显式指定分类时不做排除，否则用设置里的黑名单（默认排除 color）。
    const configured = excludeCategories ?? getSetting('search.exclude_categories', ['color']);
    const blocked = new Set(
        category ? [] : (Array.isArray(configured) ? configured : [])
            .map((name) => String(name || '').trim()).filter(Boolean),
    );
    const allowed = (name) => !blocked.has(String(name || ''));
    const candidateLimit = Math.max(limit * 4, 20);

    const vector = [];
    const fallbackPacks = [];
    for (const packId of ids) {
        let vectorIndex;
        try {
            vectorIndex = indexJob.indexStatus(packId);
        } catch {
            fallbackPacks.push(packId);
            continue;
        }
        if (vectorIndex.state !== 'fresh' || !vectorIndex.rows) {
            fallbackPacks.push(packId);
            continue;
        }
        const index = loadIndex(packId, { model: vectorIndex.model, dims: vectorIndex.dims });
        if (!index) {
            fallbackPacks.push(packId);
            continue;
        }
        // 子进程空闲 10 分钟会退出，冷启动要重新加载模型；2 秒不够，
        // 首次检索会静默退回关键词。给足冷启动时间，热态下这点等待不会发生。
        const queryVector = getSetting('semantic.enabled', true)
            ? await embedQuery(text, { timeoutMs: 20000 }) : null;
        if (!queryVector || queryVector.length !== index.dims) {
            fallbackPacks.push(packId);
            continue;
        }
        const hits = rankIndex(index, queryVector, { topK: candidateLimit, minScore, category })
            .filter((hit) => allowed(hit.row.category));
        if (!hits.length) continue;
        const { map } = semanticPathMap(packId);
        for (const hit of hits) {
            vector.push(vectorHit(packId, hit, map.get(hit.row.rel)?.entry || null));
        }
    }

    vector.sort((a, b) => b.score - a.score);
    // 词项匹配始终参与，否则“收到/谢谢”这类短查询会被向量近邻挤掉。
    const tokens = tokenSearch(ids, text, {
        topK: candidateLimit,
        minScore: Math.min(minScore, 0.01),
        category,
        allowed,
    });

    const merged = new Map();
    for (const hit of vector) {
        merged.set(hit.id, { ...hit, vectorScore: hit.score, lexScore: 0 });
    }
    for (const hit of tokens) {
        const current = merged.get(hit.id);
        if (current) {
            current.lexScore = Math.max(current.lexScore, hit.score);
        } else {
            merged.set(hit.id, { ...hit, vectorScore: 0, lexScore: hit.score });
        }
    }

    const needle = text.toLowerCase();
    // 短礼貌语（收到/谢谢/好的）优先回“应答/认可”类，而不是碰巧含“收到赞美”的害羞图。
    const ackIntent = text.length <= 8
        && /收到|好的|好嘞|谢谢|多谢|明白|了解|没问题|ok/i.test(text)
        && !/生气|难过|烦|累|困|哭|无语|讨厌|骂|吵/.test(text);
    for (const item of merged.values()) {
        const hay = [
            item.caption, item.visible_text, (item.tags || []).join(' '),
        ].join(' ').toLowerCase();
        const exact = needle && hay.includes(needle) ? 0.2 : 0;
        const ackBoost = ackIntent && ['reply', 'approval', 'greeting'].includes(item.category) ? 0.35 : 0;
        item.score = Math.round(
            (item.vectorScore * 0.7 + item.lexScore * 0.3 + exact + ackBoost) * 10000,
        ) / 10000;
    }

    return [...merged.values()]
        .filter((item) => item.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
}

export function taskSummary(packId) {
    const job = jobFor(packId);
    if (!job) return null;
    return {
        status: job.status,
        total: job.total,
        done: job.completed,
        failed: job.failed,
        pending: job.queue.length,
        current: [...job.current],
    };
}

/** 激活时后台预热模型；失败留给检索时的关键词兜底。 */
export function warmup() {
    warmEmbedder().then((result) => {
        if (result.state === 'ready') log('info', `向量模型就绪（${result.dims} 维）`);
        else if (result.state === 'unavailable') log('warn', result.error || '向量模型不可用');
    }).catch((err) => log('warn', `向量模型预热失败: ${err.message}`));
}

export function autoBuild(packIds) {
    return indexJob.autoBuild(packIds);
}

export function shutdown() {
    for (const [packId, timer] of indexBuildTimers) {
        clearTimeout(timer);
        indexBuildTimers.delete(packId);
    }
    indexJob.cancelAll();
    shutdownEmbedder();
}

#!/usr/bin/env node
/**
 * 用现有 caption 生成使用场景字段（use_when / avoid_when）。
 *
 * 只调用文本模型，不读图片：caption 已经描述了画面，这里补的是"什么场合该用"。
 * 可重复执行，已有两个字段的条目默认跳过。
 *
 *   node scripts/scene-pass.mjs --pack all
 *   node scripts/scene-pass.mjs --pack atri-meme-pack --force --limit 50
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(homedir(), '.config', 'alma', 'stickers');
const API = process.env.ALMA_API || 'http://127.0.0.1:23001';
function arg(name, fallback = '') {
    const at = process.argv.indexOf(`--${name}`);
    if (at < 0) return fallback;
    const next = process.argv[at + 1];
    return next && !next.startsWith('--') ? next : 'true';
}

const PACK_ARG = arg('pack', 'all');
const PACKS = PACK_ARG === 'all' ? null : PACK_ARG.split(',');
const LIMIT = Number(arg('limit', '0')) || 0;
const FORCE = arg('force', '') === 'true';
const DRY = arg('dry-run', '') === 'true';
const BATCH = Number(arg('batch', '10')) || 10;
const CONCURRENCY = Number(arg('concurrency', '3')) || 3;
// --api http://127.0.0.1:3425/v1 直接走 OpenAI 兼容网关，不依赖 Alma 在运行。
const DIRECT = arg('api', '');
let consecutiveNetworkErrors = 0;

const SYSTEM = `你是表情包使用场景标注助手。只输出 JSON 数组，不要 markdown，不要解释。
根据表情包的画面描述和所在分类，为每一张写两个字段：

use_when：15-35 字。写"对方说了什么话、处在什么处境"时这张图合适。
  要写成能直接当检索条件的句子，例如"对方说不想上班、起不来床时"。
  不要写"适合日常聊天"这类套话，也不要描述画面。

avoid_when：10-30 字。写一个表面相似、但用出去会不合时宜的情况。
  要具体到一眼能看出边界，例如"对方是真的生病了，不是开玩笑"。

两条都必须能从描述和分类推出来。推不出就写更保守的说法，不要编造画面里没有的内容。
输出格式：[{"id":"...","use_when":"...","avoid_when":"..."}]`;

const SHOTS = [
    {
        id: 'approval/ok.gif',
        category: 'approval',
        caption: '金发少女闭眼张嘴喊出 OK，画面中央是大字 OK',
        visible_text: 'OK',
        use_when: '对方交代的事你已经办好了，或爽快答应一个请求时',
        avoid_when: '对方在讲难过的事，轻快的答应会显得没听进去',
    },
    {
        id: 'tired/cat.jpg',
        category: 'tired',
        caption: '橘猫四脚朝天躺在地板上，配字"我不想起床"',
        visible_text: '我不想起床',
        use_when: '对方抱怨不想上班、起不来、被早上叫醒时',
        avoid_when: '对方真的生病请假了，认真关心比卖惨更合适',
    },
];

function loadSettings() {
    try {
        return JSON.parse(readFileSync(join(ROOT, 'settings.json'), 'utf8'));
    } catch {
        return {};
    }
}

function packIds() {
    try {
        const registry = JSON.parse(readFileSync(join(ROOT, 'index.json'), 'utf8'));
        const ids = (Array.isArray(registry.packs) ? registry.packs : []).map((pack) => String(pack.id));
        return PACKS ? ids.filter((id) => PACKS.includes(id)) : ids;
    } catch {
        return PACKS || [];
    }
}

function metadataPath(packId) {
    return join(ROOT, 'packs', packId, 'semantic_metadata.json');
}

function readMeta(packId) {
    const path = metadataPath(packId);
    if (!existsSync(path)) return null;
    try {
        const data = JSON.parse(readFileSync(path, 'utf8'));
        if (!data || typeof data !== 'object' || !data.images) return null;
        return data;
    } catch {
        return null;
    }
}

function writeMeta(packId, meta) {
    if (DRY) return;
    const path = metadataPath(packId);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(meta, null, 2));
    renameSync(tmp, path);
}

function stripJson(text) {
    const raw = String(text || '').trim();
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
    const body = fenced ? fenced[1] : raw;
    const start = body.indexOf('[');
    const end = body.lastIndexOf(']');
    if (start < 0 || end <= start) return null;
    try {
        return JSON.parse(body.slice(start, end + 1));
    } catch {
        return null;
    }
}

async function callModel(model, items) {
    const user = JSON.stringify([
        ...SHOTS,
        ...items.map((item) => ({
            id: item.id,
            category: item.category,
            caption: item.caption,
            visible_text: item.visible_text,
            tags: item.tags,
        })),
    ], null, 1);
    const content = await request(model, user);
    const parsed = stripJson(content);
    if (!parsed) throw new Error(`返回不是 JSON 数组: ${content.slice(0, 160)}`);
    return parsed;
}

async function request(model, user) {
    if (DIRECT) {
        const res = await fetch(`${DIRECT.replace(/\/$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model,
                max_tokens: 4096,
                temperature: 0.3,
                messages: [
                    { role: 'system', content: SYSTEM },
                    { role: 'user', content: user },
                ],
            }),
            signal: AbortSignal.timeout(180000),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`);
        }
        const data = await res.json();
        return String(data?.choices?.[0]?.message?.content || '');
    }
    const pos = model.indexOf(':');
    const providerId = pos > 0 ? model.slice(0, pos) : model;
    const modelId = pos > 0 ? model.slice(pos + 1) : model;
    const res = await fetch(`${API}/anthropic-proxy/${encodeURIComponent(providerId)}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            model: modelId,
            max_tokens: 4096,
            system: SYSTEM,
            messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
        }),
        signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`);
    }
    const data = await res.json();
    return Array.isArray(data?.content)
        ? data.content.filter((b) => b?.type === 'text').map((b) => b.text || '').join('')
        : '';
}

function normalize(text, fallback = '') {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80) || fallback;
}

async function runPack(packId, model, stats) {
    const meta = readMeta(packId);
    if (!meta) {
        console.log(`[${packId}] 没有 semantic_metadata.json，跳过`);
        return;
    }
    const entries = Object.entries(meta.images);
    let targets = entries.filter(([, entry]) => String(entry?.caption || '').trim());
    if (!FORCE) {
        targets = targets.filter(([, entry]) => !String(entry?.use_when || '').trim());
    }
    if (LIMIT) targets = targets.slice(0, LIMIT);
    if (!targets.length) {
        console.log(`[${packId}] 无需处理`);
        return;
    }
    console.log(`[${packId}] 待标注 ${targets.length} 张，batch=${BATCH} concurrency=${CONCURRENCY}`);

    const batches = [];
    for (let i = 0; i < targets.length; i += BATCH) batches.push(targets.slice(i, i + BATCH));
    let done = 0;
    let failed = 0;
    let writing = Promise.resolve();

    const apply = (rows) => {
        writing = writing.then(() => {
            const fresh = readMeta(packId) || meta;
            for (const row of rows) {
                const entry = fresh.images[row.id];
                if (!entry) continue;
                entry.use_when = row.use_when;
                entry.avoid_when = row.avoid_when;
                entry.scene_updated_at = new Date().toISOString();
            }
            writeMeta(packId, fresh);
            stats.written += rows.length;
            done += rows.length;
            if (done % 50 < BATCH) console.log(`[${packId}] ${done}/${targets.length} failed=${failed}`);
        }).catch((err) => {
            console.error(`[${packId}] 写回失败: ${err.message}`);
        });
        return writing;
    };

    const worker = async () => {
        while (batches.length) {
            const batch = batches.shift();
            if (!batch) return;
            const items = batch.map(([id, entry]) => ({
                id,
                category: String(entry?.category || String(id).split('/')[0] || ''),
                caption: String(entry?.caption || '').slice(0, 400),
                visible_text: String(entry?.visible_text || '').slice(0, 120),
                tags: (Array.isArray(entry?.tags) ? entry.tags : [])
                    .filter((tag) => typeof tag === 'string' && !tag.startsWith('category:'))
                    .slice(0, 8),
            }));
            try {
                const rows = await callModel(model, items);
                const wanted = new Set(items.map((item) => item.id));
                const clean = [];
                for (const row of Array.isArray(rows) ? rows : []) {
                    const id = String(row?.id || '').trim();
                    if (!wanted.has(id)) continue;
                    const useWhen = normalize(row?.use_when);
                    const avoidWhen = normalize(row?.avoid_when);
                    if (!useWhen) continue;
                    clean.push({
                        id,
                        use_when: useWhen,
                        avoid_when: avoidWhen || '没有明确禁区，按语境判断',
                    });
                }
                if (!clean.length) throw new Error('没有一条有效结果');
                await apply(clean);
                consecutiveNetworkErrors = 0;
            } catch (err) {
                const message = err?.message || String(err);
                if (/fetch failed|ECONNREFUSED|ECONNRESET|HTTP 5\d\d/.test(message)) {
                    consecutiveNetworkErrors += 1;
                    if (consecutiveNetworkErrors >= 12) {
                        throw new Error(`模型接口连续失败 ${consecutiveNetworkErrors} 次，停止：${message}`);
                    }
                } else {
                    consecutiveNetworkErrors = 0;
                }
                if (batch.length > 1) {
                    const half = Math.ceil(batch.length / 2);
                    batches.unshift(batch.slice(0, half), batch.slice(half));
                    continue;
                }
                failed += 1;
                stats.failed += 1;
                console.error(`[${packId}] ${batch[0][0]}: ${message}`);
            }
        }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
    await writing;
    console.log(`[${packId}] 完成 ${done}/${targets.length}，失败 ${failed}`);
}

const settings = loadSettings();
const model = String(arg('model', settings?.semantic?.vision_provider_id || '')).trim();
if (!model || (!DIRECT && !model.includes(':'))) {
    console.error('缺少模型：settings.semantic.vision_provider_id 或 --model provider:model（--api 直连时不需要前缀）');
    process.exit(1);
}
const ids = packIds();
if (!ids.length) {
    console.error('没有找到表情包');
    process.exit(1);
}
const stats = { written: 0, failed: 0 };
for (const id of ids) {
    await runPack(id, model, stats);
}
console.log(`DONE written=${stats.written} failed=${stats.failed}${DRY ? ' (dry-run)' : ''}`);

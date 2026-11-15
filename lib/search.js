/**
 * 关键词检索兜底。
 *
 * 语义描述是增强项，不是前置条件：没有描述的分类包（只有 memes/<category>/）
 * 仍然要能按分类名和中文近义词挑图。这里沿用旧版的字级 + 双字组匹配。
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { tokenize } from './util.js?v=0.3.1-codex-20261114';
import { getSetting } from './settings.js?v=0.3.1-codex-20261114';
import {
    categoryDescriptions, imagesByCategory, installedPackIds, loadSemanticMetadata, packDir, packSummary,
} from './store.js?v=0.3.1-codex-20261114';

export const CATEGORY_SYNONYMS = {
    happy: '开心 高兴 快乐 笑 喜 愉快 喜悦 兴奋 庆祝',
    sad: '难过 伤心 哭 悲伤 沮丧 失落 低落 委屈',
    angry: '生气 愤怒 火大 恼 气愤 不爽 炸 抗议',
    shy: '害羞 脸红 腼腆 不好意思 娇羞',
    confused: '困惑 疑惑 迷糊 不懂 问号 理解障碍',
    surprised: '惊讶 震惊 意外 吃惊 惊',
    tired: '累 疲 困 疲惫 没力气 倦',
    teasing: '调侃 调戏 逗 逗弄 戏弄 坏笑',
    affection: '喜欢 爱意 亲昵 撒娇 抱 宠 贴贴',
    greeting: '打招呼 你好 问候 早 拜拜 再见',
    reply: '回复 应答 收到 知道了 嗯 好的 好嘞 明白 了解 没问题 谢谢 感谢 多谢 OK',
    approval: '赞同 同意 认可 可以 好 点赞 答应',
    refusal: '拒绝 不行 不要 不同意 不',
    eating: '吃 干饭 饿 食物 饭 美食',
    see: '看 观察 注视 盯',
    action: '动作 动 干活 行动',
    sleep: '睡 困 晚安 觉',
    morning: '早上 早 起床 早安',
    meow: '猫 喵 卖萌',
    baka: '笨蛋 傻 蠢',
    fool: '傻 呆 蠢 犯傻',
    like: '喜欢 赞 好 喜爱',
    givemoney: '钱 打钱 给钱 红包 报酬',
    color: '色 调情 暧昧',
    cpu: 'cpu 烧脑 当机 死机 卡顿',
    sigh: '叹气 无奈 无语 感慨',
    other: '其他 杂',
};

function docTokens(entry, category, descriptions) {
    const tags = Array.isArray(entry?.tags) ? entry.tags : [];
    const expanded = [];
    for (const tag of tags) {
        if (typeof tag !== 'string') continue;
        if (tag.startsWith('category:')) {
            const key = tag.slice(9);
            expanded.push(key, CATEGORY_SYNONYMS[key] || '');
        } else {
            expanded.push(tag);
        }
    }
    const hay = tokenize([
        entry?.caption || '',
        entry?.visible_text || '',
        entry?.use_when || '',
        descriptions?.[category] || '',
        CATEGORY_SYNONYMS[category] || '',
        ...expanded,
    ].join(' '));
    return hay;
}

const captionCache = new Map();
const CAPTION_CACHE_MS = 10_000;

/** 工具调用和预览页会反复问同一批包，按文件 mtime 缓存 10 秒。 */
function hasCaptions(packId) {
    const path = join(packDir(packId), 'semantic_metadata.json');
    let mtime = 0;
    try {
        mtime = statSync(path).mtimeMs;
    } catch {
        return false;
    }
    const cached = captionCache.get(packId);
    if (cached && cached.mtime === mtime && Date.now() - cached.at < CAPTION_CACHE_MS) {
        return cached.value;
    }
    let value = false;
    try {
        const meta = loadSemanticMetadata(packId);
        value = Object.values(meta.images || {})
            .some((entry) => String(entry?.caption || '').trim());
    } catch {
        value = false;
    }
    captionCache.set(packId, { at: Date.now(), mtime, value });
    return value;
}

/**
 * 没有显式指定包时，优先用使用规则选中的包；规则里的包都没有描述时，
 * 把有描述的包一并纳入，避免默认规则把检索锁死在一个空描述的包上。
 */
export function retrievalPackIds(preferred = []) {
    const installed = installedPackIds();
    const available = new Set(installed);
    const base = (Array.isArray(preferred) ? preferred : [preferred])
        .map((id) => String(id || '').trim())
        .filter((id) => id && available.has(id));
    if (base.some(hasCaptions)) return base;
    const described = installed.filter(hasCaptions);
    if (!described.length) return base.length ? base : installed.slice(0, 1);
    return [...base, ...described.filter((id) => !base.includes(id))];
}

export function keywordSearch(packIds, query, {
    topK = 5, minScore = 0.02, category = null, excludeCategories = null,
} = {}) {
    const qTokens = tokenize(query);
    if (!qTokens.size) return [];
    const ids = Array.isArray(packIds) ? packIds : [packIds].filter(Boolean);
    const results = [];
    const configured = excludeCategories ?? getSetting('search.exclude_categories', ['color']);
    const blocked = new Set(category ? [] : (Array.isArray(configured) ? configured : [])
        .map((name) => String(name || '').trim()).filter(Boolean));

    for (const packId of ids) {
        const images = imagesByCategory(packId);
        const descriptions = categoryDescriptions(packId);
        for (const [categoryName, files] of Object.entries(images)) {
            if (category && categoryName !== category) continue;
            if (blocked.has(categoryName)) continue;
            for (const filename of files) {
                const rel = `${categoryName}/${filename}`;
                const hay = docTokens({ tags: [`category:${categoryName}`] }, categoryName, descriptions);
                let hit = 0;
                for (const token of qTokens) if (hay.has(token)) hit += 1;
                if (!hit) continue;
                const score = hit / (Math.sqrt(qTokens.size) * Math.pow(hay.size, 0.3));
                if (score < minScore) continue;
                results.push({
                    score: Math.round(score * 10000) / 10000,
                    id: `${packId}:${rel}`,
                    pack: packId,
                    entry_id: rel,
                    file: join(packDir(packId), 'memes', rel),
                    relative_path: rel,
                    category: categoryName,
                    categories: [categoryName],
                    caption: '',
                    visible_text: '',
                    tags: [],
                    retrieval: 'tokens',
                });
            }
        }
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, Math.max(1, topK));
}

/** 先语义检索，命中不足再用分类关键词补齐。 */
export async function hybridSearch(packIds, query, options = {}) {
    const { semantic } = options;
    const configured = options.excludeCategories ?? getSetting('search.exclude_categories', ['color']);
    const searchOptions = {
        ...options,
        excludeCategories: options.category ? [] : (Array.isArray(configured) ? configured : []),
    };
    const primary = semantic
        ? await semantic.search(packIds, query, searchOptions).catch(() => [])
        : [];
    const need = Math.max(0, (options.topK || 5) - primary.length);
    if (need <= 0) return primary;
    const fallback = keywordSearch(packIds, query, { ...searchOptions, topK: need });
    const seen = new Set(primary.map((item) => item.id));
    return [...primary, ...fallback.filter((item) => !seen.has(item.id))];
}

export function categoryCatalog(packId) {
    const summary = packSummary(packId);
    return {
        pack: summary.id,
        name: summary.name,
        image_count: summary.image_count,
        categories: categoryDescriptions(packId),
        counts: summary.categories,
    };
}

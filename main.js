/**
 * 表情库 —— Alma 插件入口。
 *
 * 职责边界：
 *   负责「库存」：导入、检索、本地管理、体检。
 *   本地聊天里，sticker_pick 会把选中的图投递到当前回复；
 *   外部渠道仍由模型执行一次 `alma send photo`，插件不碰渠道映射。
 *   不决定「该不该发」「发哪张」——那是 Alma 的判断。
 *
 * 数据目录（兼容 AstrBot meme pack 协议）：
 *   ~/.config/alma/stickers/
 *   ├── index.json                包级清单
 *   ├── settings.json             设置中心
 *   ├── rules.json                会话/人格使用规则
 *   └── packs/<pack-id>/
 *       ├── manifest.json
 *       ├── semantic_metadata.json
 *       ├── semantic_index.json
 *       ├── semantic_vectors.f32
 *       ├── memes_data.json
 *       └── memes/<category>/*.gif
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as gallery from './gallery.js?v=0.3.2-1';
import * as store from './lib/store.js?v=0.3.2-1';
import * as semantic from './lib/semantic.js?v=0.3.2-1';
import * as community from './lib/community.js?v=0.3.2-1';
import * as settings from './lib/settings.js?v=0.3.2-1';
import { hybridSearch, retrievalPackIds } from './lib/search.js?v=0.3.2-1';
import { installTurnContext, turnFor } from './lib/turn-context.js?v=0.3.2-1';
import { deliverPickedSticker } from './lib/pick.js?v=0.3.2-1';
import { installStickerSkill } from './lib/skill.js?v=0.3.2-1';

const DEFAULT_PORT = 8899;

async function packIdsFor(args, chat) {
    if (args?.pack) return [String(args.pack)];
    const turn = turnFor(args);
    const threadId = String(turn?.threadId || '');
    let personaId = '';
    if (threadId && chat?.getThread) {
        try {
            const thread = await chat.getThread(threadId);
            personaId = String(
                thread?.personaId || thread?.metadata?.personaId
                || thread?.metadata?.persona || '',
            );
        } catch { /* 会话读取失败时仍可匹配会话规则 */ }
    }
    const preferred = settings.resolvePackIds({ threadId, personaId });
    return retrievalPackIds(preferred);
}

function decorate(hit) {
    const categories = Array.isArray(hit.categories) && hit.categories.length
        ? hit.categories
        : [hit.category].filter(Boolean);
    return {
        id: hit.id,
        pack: hit.pack,
        file: hit.file,
        caption: hit.caption || '',
        visible_text: hit.visible_text || '',
        use_when: hit.use_when || '',
        avoid_when: hit.avoid_when || '',
        categories,
        score: hit.score,
    };
}

async function waitInstall(jobId, label = '安装') {
    for (let i = 0; i < 900; i += 1) {
        const status = community.installStatus(jobId);
        if (status.status === 'succeeded') return status.result;
        if (status.status === 'failed' || status.status === 'cancelled') {
            throw new Error(status.message || `${label}失败`);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return { message: `${label}任务仍在进行，可在资源广场查看进度`, job_id: jobId };
}

export async function activate(context) {
    const { logger, tools, events, commands, ui, chat } = context;

    semantic.configure({ logger });

    gallery.setHost({
        logger,
        getThreads: async () => {
            if (!chat?.listThreads) return [];
            try {
                const threads = await chat.listThreads();
                return (threads || []).map((thread) => ({
                    id: String(thread.id || ''),
                    title: String(thread.title || thread.id || '未命名会话'),
                })).filter((thread) => thread.id);
            } catch {
                return [];
            }
        },
    });

    logger.info?.('[表情库] 插件启动');

    try {
        const started = await gallery.start(DEFAULT_PORT);
        logger.info?.(`[表情库] 管理页面已就绪: ${started.url}`);
    } catch (err) {
        logger.error?.(`[表情库] 图库启动失败: ${err.message}`);
    }

    semantic.warmup();
    try {
        semantic.autoBuild(store.installedPackIds());
    } catch (err) {
        logger.warn?.(`[表情库] 向量索引自动构建失败: ${err.message}`);
    }

    const disposables = [];

    try {
        const contextHook = installTurnContext(events);
        if (contextHook) disposables.push(contextHook);
    } catch (err) {
        logger.warn?.(`[表情库] 无法记录轮次上下文: ${err.message}`);
    }

    const wrap = (fn) => async (args) => {
        try {
            const result = await fn(args || {});
            return result ?? {};
        } catch (err) {
            logger.error?.(`[表情库] ${err.message}`);
            throw err;
        }
    };

    disposables.push(tools.register('sticker_search', {
        description:
            '按语境检索表情包，只返回候选，不发图。每条含 id、本地路径 file、caption（这张图拍了什么、配了什么字）、use_when（适合接什么话或什么处境）、avoid_when（什么情况下不该用）、匹配分 score。score 只反映字面近似，不保证方向对：谁夸谁、谁在炫耀这类主客关系要读 use_when 自己判断，第一条也不一定合适。想直接发图用 sticker_pick。query 写想表达的意图，不要照抄用户原话；不要用 Bash 遍历表情目录或直接读 semantic_metadata.json。',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: '语境描述，比如"对方在阴阳我但我懒得吵"' },
                pack: { type: 'string', description: '限定某个包 id' },
                category: { type: 'string', description: '限定分类，如 happy / angry / teasing' },
                top_k: { type: 'integer', minimum: 1, maximum: 30, description: '返回几个候选，留空使用设置中的默认候选数' },
            },
            required: ['query'],
        },
        execute: wrap(async (args) => {
            const ids = await packIdsFor(args, chat);
            const hits = await hybridSearch(ids, args.query, {
                topK: Number(args.top_k) || settings.getSetting('semantic.top_k', 8),
                category: args.category || null,
                minScore: settings.getSetting('semantic.min_score', 0.02),
                semantic,
            });
            return hits.map(decorate);
        }),
    }));

    disposables.push(tools.register('sticker_pick', {
        description:
            '选一张最贴切的表情发到当前会话，一次调用完成。只用于 Alma 自己的对话；在别的平台发帖或评论（小红书、小黑盒这类）不要调它，图会发到当前聊天窗口而不是那个平台，改用 sticker_search 取本地 file，再走平台自己的上传接口。可选 text 作为配文；不传就只发图。text 是你本来要说的话，图跟着这句话走，不要写成对图的解说。返回的 use_when 说明它适合接什么话，avoid_when 是使用边界；两者只用于判断，不要复述给用户。delivered 为 true 表示已经发出：不要再发一次，不要打印路径，也不要调用任何发送命令。delivered 为 false 时，用返回的 file 执行一次 next 里的 `alma send photo`。query 写想表达的意图，不要照抄用户原话；不要用 Bash 遍历表情目录或直接读 semantic_metadata.json。',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: '语境，比如"对方在阴阳我但我懒得吵"' },
                text: { type: 'string', description: '可选配文；不传就只发图' },
                category: { type: 'string', description: '可选，限定分类' },
                pack: { type: 'string', description: '可选，限定包 id' },
            },
            required: ['query'],
        },
        execute: wrap(async (args) => {
            const ids = await packIdsFor(args, chat);
            const hits = await hybridSearch(ids, args.query, {
                topK: 1,
                category: args.category || null,
                minScore: settings.getSetting('semantic.min_score', 0.02),
                semantic,
            });
            if (!hits.length) return { found: false, reason: '库里没找到贴切的' };
            return deliverPickedSticker({
                picked: decorate(hits[0]),
                turn: turnFor(args),
                text: String(args.text || '').trim(),
            });
        }),
    }));

    disposables.push(tools.register('sticker_get', {
        description: '按表情 id（形如 pack-id:category/filename）取单张完整信息，含本地路径。',
        parameters: {
            type: 'object',
            properties: { id: { type: 'string', description: '形如 pack-id:category/filename' } },
            required: ['id'],
        },
        execute: wrap((args) => {
            const raw = String(args.id || '');
            const pos = raw.indexOf(':');
            if (pos <= 0) return null;
            const packId = raw.slice(0, pos);
            const rel = raw.slice(pos + 1);
            if (!store.packExists(packId)) return null;
            const full = join(store.memesDir(packId), rel);
            if (!existsSync(full)) return null;
            const { map } = store.semanticPathMap(packId);
            const entry = map.get(rel)?.entry || null;
            const [category] = rel.split('/');
            return {
                id: raw,
                pack: packId,
                file: full,
                categories: [category],
                caption: entry?.caption || '',
                visible_text: entry?.visible_text || '',
                tags: entry?.tags || [],
            };
        }),
    }));

    disposables.push(tools.register('sticker_catalog', {
        description: '列出所有表情包、分类分布、图片数量，以及当前默认使用规则。想知道库里有什么、哪个包适合时先调这个。',
        parameters: { type: 'object', properties: {} },
        execute: wrap(() => {
            const packs = store.listPacks();
            return {
                packs,
                rules: settings.getRules(),
                installed_count: packs.length,
                total_images: packs.reduce((sum, pack) => sum + pack.image_count, 0),
            };
        }),
    }));

    disposables.push(tools.register('sticker_community', {
        description:
            '看社区有哪些现成的表情包可选（AstrBot 官方社区索引，都是维护好的、带语义标注的包）。想加新包时先调这个，再用 sticker_install 装。',
        parameters: {
            type: 'object',
            properties: { refresh: { type: 'boolean', description: '强制刷新索引' } },
        },
        execute: wrap(async (args) => {
            let data = null;
            if (!args.refresh) {
                try { data = community.cachedCommunity(); } catch { data = null; }
            }
            if (!data) data = await community.fetchCommunity({ force: true });
            const installed = new Set(store.installedPackIds());
            return {
                total: data.index.packs.length,
                installed: installed.size,
                fetched_at: data.fetched_at,
                packs: data.index.packs.map((pack) => ({
                    id: pack.id,
                    name: pack.name || pack.id,
                    version: pack.version || '',
                    description: pack.description || '',
                    license: pack.license || '',
                    tags: pack.tags || [],
                    installed: installed.has(pack.id),
                })),
            };
        }),
    }));

    disposables.push(tools.register('sticker_install', {
        description:
            '装一个表情包。传 pack_id 装社区索引里的（推荐）；传 repo 装任意 GitHub 仓库。装完会被自动检索到。',
        parameters: {
            type: 'object',
            properties: {
                pack_id: { type: 'string', description: '社区包 id，如 atri-meme-pack' },
                repo: { type: 'string', description: '任意 GitHub 仓库 owner/name' },
                ref: { type: 'string', description: '分支或 tag，默认 main' },
                overwrite: { type: 'boolean', description: '已装过时覆盖重装' },
                set_as_default: { type: 'boolean', description: '装完后设为默认包' },
            },
        },
        execute: wrap(async (args) => {
            if (args.pack_id) {
                const started = community.startInstall({
                    pack_id: args.pack_id,
                    overwrite: Boolean(args.overwrite),
                    set_as_default: Boolean(args.set_as_default),
                });
                return waitInstall(started.job_id, '安装');
            }
            if (args.repo) {
                const started = community.startInstall({
                    source: { type: 'github', repo: args.repo, ref: args.ref || 'main', subpath: '.' },
                    overwrite: Boolean(args.overwrite),
                    set_as_default: Boolean(args.set_as_default),
                });
                return waitInstall(started.job_id, '安装');
            }
            throw new Error('需要 pack_id 或 repo。本地目录请到管理页用 zip 导入。');
        }),
    }));

    disposables.push(tools.register('sticker_update', {
        description: '把已装的社区表情包更新到最新版（覆盖安装）。',
        parameters: {
            type: 'object',
            properties: { pack_id: { type: 'string', description: '社区包 id' } },
            required: ['pack_id'],
        },
        execute: wrap(async (args) => {
            const started = community.startInstall({ pack_id: args.pack_id, overwrite: true });
            return waitInstall(started.job_id, '更新');
        }),
    }));

    disposables.push(tools.register('sticker_remove', {
        description: '卸载一个表情包。默认连磁盘文件一起删掉。',
        parameters: {
            type: 'object',
            properties: {
                pack: { type: 'string', description: '包 id' },
                keep_files: { type: 'boolean', description: '只从索引摘掉，保留磁盘文件' },
            },
            required: ['pack'],
        },
        execute: wrap((args) => store.uninstallPack(args.pack, {
            deleteFiles: !args.keep_files,
        })),
    }));

    disposables.push(tools.register('sticker_health', {
        description: '体检表情库：缺失文件、索引漂移、语义描述覆盖率。',
        parameters: { type: 'object', properties: {} },
        execute: wrap(() => {
            const problems = [];
            const packs = store.listPacks();
            for (const pack of packs) {
                const images = store.imagesByCategory(pack.id);
                let missing = 0;
                for (const [category, files] of Object.entries(images)) {
                    for (const filename of files) {
                        if (!existsSync(join(store.memesDir(pack.id), category, filename))) missing += 1;
                    }
                }
                if (missing) problems.push(`${pack.id}: ${missing} 张图片文件缺失`);
                if (!pack.image_count) problems.push(`${pack.id}: 一张图都没读到`);
                if (pack.semantic_status === 'partial' && pack.semantic_caption_failed) {
                    problems.push(`${pack.id}: ${pack.semantic_caption_failed} 条语义描述失败`);
                }
            }
            return {
                ok: problems.length === 0,
                pack_count: packs.length,
                total_images: packs.reduce((sum, pack) => sum + pack.image_count, 0),
                gallery: gallery.status(),
                problems,
            };
        }),
    }));

    disposables.push(tools.register('sticker_gallery', {
        description: '打开本地表情库管理页面。可以浏览、整理、搜索、语义化和改设置。返回可访问的网址。',
        parameters: {
            type: 'object',
            properties: {
                port: { type: 'number', description: '端口，默认 8899' },
                open: { type: 'boolean', description: '是否顺便在浏览器打开，默认 true' },
            },
        },
        execute: wrap(async (args) => {
            const found = await gallery.discover();
            const running = found.running
                ? found
                : await gallery.start(args.port === undefined ? DEFAULT_PORT : Number(args.port));
            if (args.open !== false && ui?.openExternal) {
                try { await ui.openExternal(running.url); } catch { /* 交给用户手动打开 */ }
            }
            return running;
        }),
    }));

    disposables.push(tools.register('sticker_gallery_url', {
        description: '拿到表情库管理页面的地址（自动找到当前真正在跑的那个）。',
        parameters: { type: 'object', properties: {} },
        execute: wrap(() => gallery.discover()),
    }));

    disposables.push(tools.register('sticker_gallery_stop', {
        description: '关掉本地表情库页面服务。',
        parameters: { type: 'object', properties: {} },
        execute: wrap(() => ({ stopped: gallery.stop() })),
    }));

    if (commands?.register) {
        try {
            disposables.push(commands.register('stickers', {
                title: '打开表情包管理',
                description: '在浏览器打开本地表情包管理页面',
                handler: async () => {
                    const found = await gallery.discover();
                    const running = found.running ? found : await gallery.start(DEFAULT_PORT);
                    if (ui?.openExternal) await ui.openExternal(running.url);
                    return { url: running.url };
                },
            }));
        } catch (err) {
            logger.warn?.(`[表情库] 注册命令失败: ${err.message}`);
        }

        try {
            disposables.push(commands.register('stickers-skill', {
                title: '安装表情包技能',
                description: '把表情包礼仪技能装到 ~/.config/alma/skills/sticker-etiquette/',
                handler: async () => installStickerSkill(),
            }));
        } catch (err) {
            logger.warn?.(`[表情库] 注册技能命令失败: ${err.message}`);
        }
    }

    return {
        dispose: () => {
            logger.info?.('[表情库] 插件卸载');
            try { semantic.shutdown(); } catch { /* 模型进程可能已经退出 */ }
            try { gallery.stop(); } catch { /* 已经关了 */ }
            for (const disposable of disposables) {
                try { disposable?.dispose?.(); } catch { /* 忽略 */ }
            }
        },
    };
}

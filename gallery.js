/**
 * 本地管理服务：静态页面 + JSON API + 图片。
 *
 * 只绑定 127.0.0.1。页面完全离线，数据来自 ~/.config/alma/stickers。
 * 旧版 gallery.js 的 /api/catalog、/img 路由保留，避免已有书签失效。
 */

import { copyFileSync, createReadStream, createWriteStream, existsSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { dirname, extname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
    MIME, PACKS_DIR, TMP_DIR, SAFE_ID, ensureDir, fileDataUrl, safeJoin, sha256,
} from './lib/util.js?v=0.3.1-codex-20261114';
import * as store from './lib/store.js?v=0.3.1-codex-20261114';
import * as settings from './lib/settings.js?v=0.3.1-codex-20261114';
import * as semantic from './lib/semantic.js?v=0.3.1-codex-20261114';
import * as community from './lib/community.js?v=0.3.1-codex-20261114';
import * as packsio from './lib/packsio.js?v=0.3.1-codex-20261114';
import * as indexJob from './lib/index-job.js?v=0.3.1-codex-20261114';
import { hybridSearch, retrievalPackIds } from './lib/search.js?v=0.3.1-codex-20261114';

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const WEBUI_DIR = join(PLUGIN_DIR, 'webui');

let server = null;
let host = {
    logger: null,
    getThreads: null,
};

export function setHost(next = {}) {
    host = { ...host, ...next };
}

export function getHost() {
    return host;
}

// ------------------------------------------------------------------ HTTP 工具
function sendJson(res, status, data) {
    const body = JSON.stringify(data ?? {});
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
    });
    res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(text);
}

function readBody(req, limit = 256 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit) {
                reject(new Error('上传内容过大'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

async function readJsonBody(req) {
    const buf = await readBody(req, 32 * 1024 * 1024);
    if (!buf.length) return {};
    try {
        return JSON.parse(buf.toString('utf8'));
    } catch {
        throw new Error('请求 JSON 格式不正确');
    }
}

function parseMultipart(buf, contentType) {
    const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
    if (!match) throw new Error('缺少 multipart boundary');
    const boundary = `--${match[1] || match[2]}`;
    const out = { fields: {}, files: {} };
    const parts = buf.toString('latin1').split(boundary);
    for (const part of parts) {
        if (!part.includes('Content-Disposition')) continue;
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd < 0) continue;
        const rawHeaders = part.slice(0, headerEnd);
        let body = part.slice(headerEnd + 4);
        if (body.endsWith('\r\n')) body = body.slice(0, -2);
        const nameMatch = /name="([^"]+)"/i.exec(rawHeaders);
        if (!nameMatch) continue;
        const filenameMatch = /filename="([^"]*)"/i.exec(rawHeaders);
        const name = nameMatch[1];
        const data = Buffer.from(body, 'latin1');
        if (filenameMatch) {
            out.files[name] = { filename: filenameMatch[1] || 'upload.bin', data };
        } else {
            out.fields[name] = data.toString('utf8');
        }
    }
    return out;
}

async function readUpload(req) {
    const type = String(req.headers['content-type'] || '');
    const buf = await readBody(req, 1024 * 1024 * 1024);
    if (type.includes('multipart/form-data')) return { multipart: parseMultipart(buf, type), buf };
    return { multipart: null, buf };
}

async function readBackupUpload(req) {
    // The archive implementation supports ZIP32; receive large backups without buffering them.
    const limit = 0xFFFFFFFE;
    const tooLarge = () => Object.assign(new Error('备份超过 ZIP32 支持的 4 GiB 上限'), { status: 413 });
    if (Number(req.headers['content-length']) > limit) throw tooLarge();
    const dir = ensureDir(join(TMP_DIR, 'backup-uploads'));
    const path = join(dir, `${randomUUID()}.zip`);
    let size = 0;
    const counter = new Transform({
        transform(chunk, encoding, done) {
            size += chunk.length;
            if (size > limit) done(tooLarge());
            else done(null, chunk);
        },
    });
    try {
        await pipeline(req, counter, createWriteStream(path, { flags: 'wx' }));
        if (!size) throw Object.assign(new Error('备份文件为空'), { status: 400 });
        return path;
    } catch (err) {
        try { rmSync(path, { force: true }); } catch { /* 保留原始上传错误 */ }
        throw err;
    }
}

// ------------------------------------------------------------------ 静态页面
function serveStatic(res, pathname) {
    let rel;
    if (pathname === '/' || pathname === '') {
        res.writeHead(302, { location: '/app/a_manage/index.html' });
        res.end();
        return true;
    }
    if (pathname === '/api/plugin/page/bridge-sdk.js') {
        return serveFile(res, join(WEBUI_DIR, 'bridge.js'));
    }
    if (pathname.startsWith('/app/')) rel = pathname.slice(5);
    else return false;
    if (rel.endsWith('/')) rel += 'index.html';
    let full = safeJoin(WEBUI_DIR, decodeURIComponent(rel));
    if (!full) {
        sendText(res, 404, 'not found');
        return true;
    }
    // 目录地址（如 /app/catalog/）自动取 index.html。
    if (existsSync(full) && statSync(full).isDirectory()) full = join(full, 'index.html');
    if (!existsSync(full) || !statSync(full).isFile()) {
        sendText(res, 404, 'not found');
        return true;
    }
    return serveFile(res, full);
}

function serveFile(res, full) {
    if (!existsSync(full) || !statSync(full).isFile()) {
        sendText(res, 404, 'not found');
        return true;
    }
    res.writeHead(200, {
        'content-type': MIME[extname(full).toLowerCase()] || staticType(full),
        'cache-control': 'no-cache',
    });
    createReadStream(full).pipe(res);
    return true;
}

function staticType(path) {
    const ext = extname(path).toLowerCase();
    if (ext === '.html') return 'text/html; charset=utf-8';
    if (ext === '.js') return 'text/javascript; charset=utf-8';
    if (ext === '.css') return 'text/css; charset=utf-8';
    if (ext === '.json') return 'application/json; charset=utf-8';
    if (ext === '.woff2') return 'font/woff2';
    if (ext === '.woff') return 'font/woff';
    if (ext === '.svg') return 'image/svg+xml';
    return 'application/octet-stream';
}

function serveImage(res, packId, rel) {
    if (!SAFE_ID.test(packId)) {
        sendText(res, 400, 'bad pack id');
        return;
    }
    const base = join(PACKS_DIR, packId, 'memes');
    const full = safeJoin(base, decodeURIComponent(rel));
    if (!full || !existsSync(full) || !statSync(full).isFile()) {
        sendText(res, 404, 'not found');
        return;
    }
    res.writeHead(200, {
        'content-type': MIME[extname(full).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'public, max-age=86400',
    });
    createReadStream(full).pipe(res);
}

// ------------------------------------------------------------------ 选择图包
function resolvePackId(query = {}, body = {}) {
    const candidates = [
        body.managed_pack_id, body.pack_id, body.pack,
        query.managed_pack_id, query.pack_id, query.pack,
        settings.defaultPackId(),
    ];
    for (const value of candidates) {
        const id = String(value || '').trim();
        if (id && store.packExists(id)) return id;
    }
    throw new Error('还没有可用的表情包。请先在资源广场安装一个包。');
}

function packIdOrNull(query = {}, body = {}) {
    try {
        return resolvePackId(query, body);
    } catch {
        return '';
    }
}

function pickupPackIds(query = {}) {
    const explicit = String(query.pack || query.pack_id || '').trim();
    if (explicit) return [explicit];
    return retrievalPackIds(settings.resolvePackIds({}));
}

function pickupIndex(ids) {
    const packs = ids.map((pack) => ({ pack, ...indexJob.indexStatus(pack) }));
    if (!packs.length) {
        return {
            state: 'missing', reason: 'no_packs', model: '', dims: 0, rows: 0,
            captioned_total: 0, built_at: '', progress: null, error: '', packs,
        };
    }
    if (packs.length === 1) return { ...packs[0], packs };
    // 没有描述的包本来就建不出索引，不该让整体状态显示成 partial。
    const searchable = packs.filter((item) => item.captioned_total > 0);
    if (!searchable.length) {
        return {
            state: 'missing', reason: 'no_captions', model: '', dims: 0, rows: 0,
            captioned_total: 0, built_at: '', progress: null, error: '', packs,
        };
    }
    const states = searchable.map((item) => item.state);
    return {
        state: states.every((state) => state === 'fresh') ? 'fresh'
            : states.some((state) => state === 'fresh') ? 'partial'
                : states.some((state) => state === 'building') ? 'building' : 'missing',
        reason: '',
        model: searchable.find((item) => item.model)?.model || '',
        dims: searchable.find((item) => item.dims)?.dims || 0,
        rows: searchable.reduce((sum, item) => sum + item.rows, 0),
        captioned_total: searchable.reduce((sum, item) => sum + item.captioned_total, 0),
        built_at: searchable.find((item) => item.built_at)?.built_at || '',
        progress: null,
        error: searchable.find((item) => item.error)?.error || '',
        packs,
    };
}

function previewRevision(path) {
    const st = statSync(path);
    return sha256(`${path}:${st.mtimeMs}:${st.ctimeMs}:${st.size}:512:webp82-v1`).slice(0, 20);
}

function manifestFor(packId) {
    const root = store.memesDir(packId);
    const versions = {};
    for (const [category, files] of Object.entries(store.imagesByCategory(packId))) {
        for (const filename of files) {
            const full = join(root, category, filename);
            try {
                versions[`${category}/${filename}`] = previewRevision(full);
            } catch { /* 忽略读不到的图 */ }
        }
    }
    let concurrency = Number(settings.getSetting('webui.preview_concurrency', 2));
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) concurrency = 2;
    return { pack_id: packId, concurrency, versions };
}

function imageDataPayload(packId, category, filename, size = 'preview', requestedRevision = '') {
    const full = join(store.memesDir(packId), category, filename);
    const base = store.memesDir(packId);
    if (!safeJoin(base, category, filename)) throw Object.assign(new Error('非法路径'), { status: 403 });
    if (!existsSync(full) || !statSync(full).isFile()) throw Object.assign(new Error('文件不存在'), { status: 404 });
    const revision = previewRevision(full);
    if (requestedRevision && requestedRevision !== revision) {
        throw Object.assign(new Error('Image changed; reload the preview'), { status: 409 });
    }
    const maxBytes = size === 'original' ? 48 * 1024 * 1024 : 24 * 1024 * 1024;
    const st = statSync(full);
    if (st.size > maxBytes) throw Object.assign(new Error('图片过大，无法预览'), { status: 413 });
    const dataUrl = fileDataUrl(full, maxBytes);
    return {
        category,
        filename,
        mime_type: MIME[extname(full).toLowerCase()] || 'application/octet-stream',
        size: st.size,
        revision,
        data_url: dataUrl,
    };
}

// ------------------------------------------------------------------ 打包相关
function transferImages(body) {
    const sourcePack = String(body.source_pack_id || '');
    const targetPack = String(body.target_pack_id || '');
    const items = Array.isArray(body.items) ? body.items : [];
    const mapping = body.category_mapping && typeof body.category_mapping === 'object' ? body.category_mapping : {};
    const mode = String(body.mode || 'keep');
    const targetCategory = String(body.target_category || '').trim();
    if (!sourcePack || !targetPack) throw new Error('缺少来源或目标图包');
    if (sourcePack === targetPack) throw new Error('来源和目标图包相同');
    const targetCategories = new Set(Object.keys(store.imagesByCategory(targetPack)));
    const groups = new Map();
    for (const item of items) {
        const category = String(item?.category || '');
        const emoji = String(item?.emoji || '');
        if (!category || !emoji) continue;
        if (!groups.has(category)) groups.set(category, []);
        groups.get(category).push(emoji);
    }
    const plan = [];
    for (const [category, files] of groups) {
        const dest = mapping[category] || targetCategory || (mode === 'keep' ? category : '');
        const exists = dest ? targetCategories.has(dest) : false;
        plan.push({
            source_category: category,
            count: files.length,
            target_category: dest,
            action: dest ? (exists ? 'merge' : 'create') : '',
            conflict: false,
        });
    }
    if (body.preview) {
        return {
            plan,
            target_categories: Object.fromEntries([...targetCategories].map((name) => [name, name])),
            source_pack_id: sourcePack,
            target_pack_id: targetPack,
        };
    }
    let moved = 0;
    const failed = [];
    for (const [category, files] of groups) {
        const dest = mapping[category] || targetCategory || (mode === 'keep' ? category : '');
        if (!dest) {
            failed.push(...files.map((emoji) => ({ category, emoji })));
            continue;
        }
        for (const emoji of files) {
            try {
                const src = join(store.memesDir(sourcePack), category, emoji);
                if (!existsSync(src)) throw new Error('missing');
                const destDir = ensureDir(join(store.memesDir(targetPack), dest));
                let name = emoji;
                let n = 2;
                while (existsSync(join(destDir, name))) {
                    const ext = extname(emoji);
                    name = `${emoji.slice(0, -ext.length)} (${n})${ext}`;
                    n += 1;
                }
                copyFileSync(src, join(destDir, name));
                moved += 1;
            } catch {
                failed.push({ category, emoji });
            }
        }
    }
    store.invalidatePack(targetPack);
    try { store.syncRegistry(); } catch { /* 忽略 */ }
    return {
        moved,
        failed,
        plan,
        source_pack_id: sourcePack,
        target_pack_id: targetPack,
    };
}

// ------------------------------------------------------------------ 路由
async function handleApi(req, res, url) {
    const route = decodeURIComponent(url.pathname.replace(/^\/api\/?/, '')).replace(/\/+$/, '');
    const query = Object.fromEntries(url.searchParams.entries());
    const method = String(req.method || 'GET').toUpperCase();

    // ---- 页面桥接
    if (route === 'bridge/auth_token') return sendJson(res, 200, { token: '' });

    if ((route === 'pick' || route === 'search') && method === 'GET') {
        const ids = pickupPackIds(query);
        const text = String(query.q || '').trim();
        const topK = Math.max(1, Number(query.top) || settings.getSetting('semantic.top_k', 8));
        const hits = await hybridSearch(ids, text, {
            topK,
            minScore: settings.getSetting('semantic.min_score', 0.02),
            category: query.category || null,
            semantic,
        });
        const picks = hits.slice(0, topK).map((hit) => ({
            id: hit.id,
            pack: hit.pack,
            file: hit.file,
            caption: hit.caption || '',
            visible_text: hit.visible_text || '',
            use_when: hit.use_when || '',
            avoid_when: hit.avoid_when || '',
            categories: Array.isArray(hit.categories) && hit.categories.length
                ? hit.categories : [hit.category].filter(Boolean),
            score: hit.score,
            retrieval: hit.retrieval || 'tokens',
        }));
        const hasVector = picks.some((hit) => hit.retrieval === 'vector');
        const hasTokens = picks.some((hit) => hit.retrieval === 'tokens');
        return sendJson(res, 200, {
            found: picks.length > 0,
            query: text,
            mode: hasVector && hasTokens ? 'mixed' : hasVector ? 'vector' : hasTokens ? 'tokens' : 'none',
            index: pickupIndex(ids),
            picks,
        });
    }

    // ---- 预览
    if (route === 'preview/manifest') {
        const packId = resolvePackId(query);
        return sendJson(res, 200, manifestFor(packId));
    }

    if (route === 'meme_image_data' || route === 'auto-collect/inbox/image_data') {
        const packId = resolvePackId(query);
        const category = String(query.category || '');
        const filename = String(query.filename || '');
        if (!category || !filename) return sendJson(res, 400, { message: '缺少图片参数' });
        if (route === 'auto-collect/inbox/image_data') return sendJson(res, 404, { message: '没有待审核图片' });
        return sendJson(res, 200, imageDataPayload(packId, category, filename, query.size || 'preview', query.v || ''));
    }

    if (route.startsWith('meme_image/')) {
        const rest = route.slice('meme_image/'.length);
        const pos = rest.indexOf('/');
        if (pos <= 0) return sendJson(res, 400, { message: '非法路径' });
        const packId = resolvePackId(query);
        return serveImage(res, packId, rest);
    }

    if (route === 'meme_image_semantic') {
        const packId = resolvePackId(query);
        return sendJson(res, 200, semantic.imageSemantic(packId, String(query.category || ''), String(query.filename || '')));
    }

    // ---- 图库
    if (route === 'packs') return sendJson(res, 200, { packs: store.listPacks() });
    if (route.startsWith('packs/') && method === 'GET' && SAFE_ID.test(route.slice(6))) {
        const packId = route.slice(6);
        const manifest = store.loadManifest(packId);
        return sendJson(res, 200, {
            id: packId,
            manifest,
            pack_dir: store.packDir(packId),
            categories: Object.entries(store.imagesByCategory(packId)).map(([name, files]) => ({ name, image_count: files.length })),
            total_images: store.countPackImages(packId),
            has_semantic_metadata: existsSync(join(store.packDir(packId), 'semantic_metadata.json')),
        });
    }

    if (route === 'emoji') {
        const packId = resolvePackId(query);
        return sendJson(res, 200, store.imagesByCategory(packId));
    }

    if (route.startsWith('emoji/') && method === 'GET') {
        const packId = resolvePackId(query);
        const category = route.slice(6);
        return sendJson(res, 200, store.imagesByCategory(packId)[category] || []);
    }

    if (route === 'emotions') {
        const packId = packIdOrNull(query);
        return sendJson(res, 200, packId ? store.categoryDescriptions(packId) : {});
    }

    // ---- 图片增删改
    if (route.startsWith('emoji/add/') && method === 'POST') {
        const category = route.slice('emoji/add/'.length);
        const packId = resolvePackId(query);
        const upload = await readUpload(req);
        const file = upload.multipart?.files?.file;
        if (!file) return sendJson(res, 400, { message: '没有找到上传的图片文件' });
        try {
            const result = store.addImage(packId, category, file.filename, file.data);
            return sendJson(res, 201, {
                message: '表情添加成功',
                path: join(store.memesDir(packId), result.category, result.filename),
                category: result.category,
                filename: result.filename,
            });
        } catch (err) {
            const status = err.code === 'duplicate_emoji' ? 409 : 400;
            return sendJson(res, status, {
                message: err.message,
                code: err.code || '',
                category,
                filename: err.existing_filename || '',
            });
        }
    }

    if (route === 'emoji/delete' && method === 'POST') {
        const body = await readJsonBody(req);
        const packId = resolvePackId(query, body);
        const deleted = store.deleteImage(packId, body.category, body.image_file);
        if (!deleted) return sendJson(res, 404, { message: '图片不存在' });
        return sendJson(res, 200, { message: '表情删除成功', category: body.category, filename: body.image_file });
    }

    if (route === 'emoji/batch_delete' && method === 'POST') {
        const body = await readJsonBody(req);
        const packId = resolvePackId(query, body);
        return sendJson(res, 200, {
            message: '批量删除完成',
            ...store.batchDelete(packId, body.category, body.image_files || []),
        });
    }

    if (route === 'emoji/move' && method === 'POST') {
        const body = await readJsonBody(req);
        const packId = resolvePackId(query, body);
        try {
            const result = store.moveImage(packId, body.source_category, body.target_category, body.image_file);
            return sendJson(res, 200, { message: '移动成功', filename: result.filename });
        } catch (err) {
            return sendJson(res, err.code === 'missing_file' ? 404 : 409, { message: err.message });
        }
    }

    if (route === 'emoji/batch_move' && method === 'POST') {
        const body = await readJsonBody(req);
        const packId = resolvePackId(query, body);
        return sendJson(res, 200, {
            message: '批量移动完成',
            ...store.batchMove(packId, body.source_category, body.target_category, body.image_files || []),
        });
    }

    if (route === 'emoji/batch_copy' && method === 'POST') {
        const body = await readJsonBody(req);
        const packId = resolvePackId(query, body);
        return sendJson(res, 200, {
            message: '批量复制完成',
            ...store.batchCopy(packId, body.source_category, body.target_category, body.image_files || []),
        });
    }

    if (route === 'emoji/clear_all' && method === 'POST') {
        const body = await readJsonBody(req);
        const packId = resolvePackId(query, body);
        const result = store.clearAllImages(packId);
        return sendJson(res, 200, { message: '所有表情已清空', ...result });
    }

    // ---- 分类
    if (route === 'category/delete' && method === 'POST') {
        const body = await readJsonBody(req);
        const packId = resolvePackId(query, body);
        return sendJson(res, 200, { message: '分类删除成功', ...store.deleteCategory(packId, body.category) });
    }
    if (route === 'category/clear' && method === 'POST') {
        const body = await readJsonBody(req);
        const packId = resolvePackId(query, body);
        return sendJson(res, 200, { message: '分类已清空', ...store.clearCategory(packId, body.category) });
    }
    if (route === 'category/restore' && method === 'POST') {
        const body = await readJsonBody(req);
        const packId = resolvePackId(query, body);
        const result = store.createCategory(packId, body.category, body.description || '');
        return sendJson(res, 200, { message: '分类已恢复', ...result });
    }
    if (route === 'category/rename' && method === 'POST') {
        const body = await readJsonBody(req);
        const packId = resolvePackId(query, body);
        const result = store.renameCategory(packId, body.old_name, body.new_name);
        return sendJson(res, 200, { message: '分类重命名成功', ...result });
    }
    if (route === 'category/update_description' && method === 'POST') {
        const body = await readJsonBody(req);
        const packId = resolvePackId(query, body);
        store.saveCategoryDescription(packId, body.tag, body.description || '');
        return sendJson(res, 200, { message: '分类描述已更新', tag: body.tag });
    }
    if (route === 'category/remove_from_config' && method === 'POST') {
        const body = await readJsonBody(req);
        const packId = resolvePackId(query, body);
        store.removeCategoryDescription(packId, body.category);
        return sendJson(res, 200, { message: '已从配置移除分类', category: body.category });
    }

    // ---- 图包
    if (route === 'packs/create' && method === 'POST') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, store.createPack(body));
    }
    if (route === 'packs/uninstall' && method === 'POST') {
        const body = await readJsonBody(req);
        // 先停掉语义任务，避免收尾时又把包目录写回来。
        semantic.stopJob(String(body.pack_id || ''));
        const result = store.uninstallPack(body.pack_id, { deleteFiles: body.delete_files !== false });
        return sendJson(res, 200, { message: '表情包已卸载', ...result });
    }
    if (route === 'packs/move-images' && method === 'POST') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, transferImages(body));
    }
    if (route === 'packs/export/status') {
        const packId = resolvePackId(query);
        return sendJson(res, 200, packsio.exportStatus(packId));
    }
    if (route === 'packs/export/download') {
        const packId = resolvePackId(query);
        const archive = packsio.buildPackArchive(packId, { mode: query.mode || 'share' });
        res.writeHead(200, {
            'content-type': 'application/zip',
            'content-disposition': `attachment; filename="${archive.filename}"`,
            'content-length': statSync(archive.path).size,
        });
        const stream = createReadStream(archive.path);
        // 临时压缩包只在下载期间存在，避免 _tmp 越积越多。
        const cleanup = () => {
            try { rmSync(archive.path, { force: true }); } catch { /* ignore */ }
        };
        stream.on('close', cleanup);
        stream.on('error', cleanup);
        // 浏览器中途取消下载时 read stream 可能不会触发 close，这里兜底。
        res.on('close', cleanup);
        stream.pipe(res);
        return true;
    }
    if (route === 'packs/import/stage' && method === 'POST') {
        const upload = await readUpload(req);
        const file = upload.multipart?.files?.file;
        if (!file) return sendJson(res, 400, { message: '没有找到 zip 文件' });
        return sendJson(res, 200, packsio.stageImport(file.data, file.filename));
    }
    if (route === 'packs/import/apply' && method === 'POST') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, await packsio.applyImport(body));
    }

    // ---- 社区
    if (route === 'community/index/fetch' && method === 'POST') {
        const body = await readJsonBody(req);
        const data = await community.fetchCommunity({ indexUrl: body.index_url });
        return sendJson(res, 200, {
            message: '社区索引拉取成功',
            ...data,
            pack_count: data.index.packs.length,
        });
    }
    if (route === 'community/index/cache') {
        const data = community.cachedCommunity();
        return sendJson(res, 200, {
            ...data,
            pack_count: data.index.packs.length,
        });
    }
    if (route === 'community/updates') return sendJson(res, 200, community.communityUpdates());
    if (route === 'community/install/start' && method === 'POST') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, community.startInstall(body));
    }
    if (route === 'community/install/status') return sendJson(res, 200, community.installStatus(query.job_id || ''));
    if (route === 'community/install/cancel' && method === 'POST') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, community.cancelInstall(body.job_id || query.job_id || ''));
    }
    if (route === 'community/install_official_first' && method === 'POST') {
        return sendJson(res, 200, community.installOfficialFirst());
    }
    if (route === 'community/update' && method === 'POST') {
        const body = await readJsonBody(req);
        if (body.action === 'preview' || body.action === 'restore_preview') {
            return sendJson(res, 400, { message: 'Alma 版暂不支持逐图差异预览；如需更新，请在资源广场覆盖安装。' });
        }
        return sendJson(res, 400, { message: 'Alma 版暂不支持差异更新；请使用覆盖安装。' });
    }
    if (route === 'community/update/status') return sendJson(res, 404, { message: '更新任务不存在' });
    if (route === 'community/update/image_data') return sendJson(res, 404, { message: '没有可预览的更新图片' });

    // ---- 设置
    if (route === 'settings/config' && method === 'GET') {
        const providers = await settingsProviders();
        return sendJson(res, 200, settings.describeSettings({ providers }));
    }
    if (route === 'settings/config' && method === 'POST') {
        try {
            const body = await readJsonBody(req);
            const applied = settings.applyChanges(body);
            const providers = await settingsProviders();
            return sendJson(res, 200, {
                message: '设置已保存并生效。',
                applied: true,
                revision: applied.revision,
                fields: settings.flattenSchema(settings.loadSchema(), applied.values),
                providers,
            });
        } catch (err) {
            const status = err.code === 'revision_conflict' ? 409 : 400;
            return sendJson(res, status, { message: err.message });
        }
    }
    if (route === 'settings/rules' && method === 'GET') return sendJson(res, 200, settings.getRules());
    if (route === 'settings/rules' && method === 'POST') {
        const body = await readJsonBody(req);
        const ids = new Set(store.installedPackIds());
        const saved = settings.saveRules(body.rules || [], ids);
        return sendJson(res, 200, { message: '规则保存成功', ...saved, semantic_rebuild_packs: [] });
    }
    if (route === 'settings/targets') {
        let threads = [];
        try {
            if (typeof host.getThreads === 'function') threads = await host.getThreads();
        } catch { /* 没有宿主上下文时只返回已保存的规则 target */ }
        const rules = settings.getRules().rules || [];
        const saved = [...new Set(rules.filter((rule) => rule.scope === 'session').map((rule) => rule.target))];
        const sessionTargets = [...new Set([...saved, ...threads.map((item) => item.id)])];
        return sendJson(res, 200, {
            persona_targets: [],
            session_targets: sessionTargets,
            sessions: threads,
        });
    }
    if (route === 'settings/backup/export' && method === 'POST') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, { message: '全量备份导出成功', ...packsio.exportRuntimeBackup(body.output_dir || '') });
    }
    if (route === 'settings/backup/import' && method === 'POST') {
        const type = String(req.headers['content-type'] || '');
        if (type.includes('application/octet-stream') || type.includes('application/zip')) {
            const path = await readBackupUpload(req);
            try {
                const result = packsio.importRuntimeBackup(path, {
                    overwrite: String(query.overwrite || '').toLowerCase() === 'true',
                    fileName: query.file_name || 'backup.zip',
                });
                return sendJson(res, 200, { message: '备份已恢复', ...result });
            } finally {
                rmSync(path, { force: true });
            }
        }
        let buf;
        let fileName = 'backup.zip';
        let overwrite = String(query.overwrite || '').toLowerCase() === 'true';
        if (type.includes('multipart/form-data')) {
            const upload = await readUpload(req);
            const file = upload.multipart?.files?.file;
            if (!file) return sendJson(res, 400, { message: '没有找到备份文件' });
            buf = file.data;
            fileName = file.filename;
            overwrite = String(upload.multipart.fields.overwrite || '').toLowerCase() === 'true';
        } else {
            const body = await readJsonBody(req);
            if (!body.file_b64) return sendJson(res, 400, { message: '缺少备份文件内容' });
            buf = Buffer.from(body.file_b64, 'base64');
            fileName = body.file_name || fileName;
            overwrite = Boolean(body.overwrite);
        }
        return sendJson(res, 200, { message: '备份已恢复', ...packsio.importRuntimeBackup(buf, { overwrite, fileName }) });
    }

    // ---- 语义
    if (route === 'semantic/status') {
        const packId = resolvePackId(query);
        try {
            await semantic.resolveVisionModel();
        } catch { /* Alma 没启动时状态仍可读 */ }
        return sendJson(res, 200, semantic.status(packId));
    }
    if (route === 'semantic/items') {
        const packId = resolvePackId(query);
        return sendJson(res, 200, semantic.items(packId, {
            page: query.page,
            pageSize: query.page_size,
            status: query.status || 'all',
        }));
    }
    if (route === 'semantic/start' && method === 'POST') {
        const body = await readJsonBody(req);
        const packId = resolvePackId(query, body);
        return sendJson(res, 200, { message: '语义化任务已开始', ...(await semantic.start(packId, {
            force: Boolean(body.force),
            concurrency: body.concurrency,
        })) });
    }
    if (route === 'semantic/pause' && method === 'POST') {
        const body = await readJsonBody(req);
        const packId = resolvePackId(query, body);
        return sendJson(res, 200, semantic.pause(packId));
    }
    if (route === 'semantic/resume' && method === 'POST') {
        const body = await readJsonBody(req);
        const packId = resolvePackId(query, body);
        return sendJson(res, 200, semantic.resume(packId));
    }
    if (route === 'semantic/retry' && method === 'POST') {
        const body = await readJsonBody(req);
        const packId = resolvePackId(query, body);
        return sendJson(res, 200, await semantic.retry(packId, { concurrency: body.concurrency }));
    }
    if (route === 'semantic/rebuild-index' && method === 'POST') {
        const body = await readJsonBody(req);
        const packId = resolvePackId(query, body);
        return sendJson(res, 200, semantic.rebuildIndex(packId));
    }
    if (route === 'semantic/save_image' && method === 'POST') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, semantic.saveImageSemantic(body, { updateVector: false }));
    }
    if (route === 'semantic/save_image_and_vector' && method === 'POST') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, semantic.saveImageSemantic(body, { updateVector: true }));
    }
    if (route === 'semantic/restore_image_auto' && method === 'POST') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, semantic.restoreImageAuto(body));
    }
    if (route === 'semantic/confirm_category' && method === 'POST') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, semantic.confirmImageCategory(body));
    }
    if (route === 'semantic/auto_reclassify' && method === 'POST') {
        const body = await readJsonBody(req);
        const packId = resolvePackId(query, body);
        return sendJson(res, 200, await semantic.autoReclassify(packId, {
            dryRun: Boolean(body.dry_run),
        }));
    }
    if (route === 'semantic/propose_image_revision' && method === 'POST') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, await semantic.proposeImageRevision(body));
    }
    if (route === 'semantic/clear-local-state' && method === 'POST') {
        const body = await readJsonBody(req);
        const packId = resolvePackId(query, body);
        return sendJson(res, 200, semantic.clearLocalState(packId));
    }
    if (route === 'semantic/delete-all' && method === 'POST') {
        const body = await readJsonBody(req);
        const packId = resolvePackId(query, body);
        return sendJson(res, 200, semantic.deleteAll(packId));
    }
    if (route === 'semantic/reviews') {
        return sendJson(res, 200, { available: false, items: [], statistics: {} });
    }
    if (route === 'semantic/auto-inbox/import' && method === 'POST') {
        return sendJson(res, 200, { message: '没有待整理的自动收集图片', imported: 0 });
    }
    if (route.startsWith('semantic/')) {
        return sendJson(res, 400, { message: '该语义化操作暂不可用' });
    }

    // ---- 自动收集 / 图床 / 同步（界面保留，功能暂未接入）
    if (route === 'auto-collect/inbox') {
        return sendJson(res, 200, {
            visible: false, count: 0, items: [], categories: {}, counters: {}, pack_id: packIdOrNull(query),
        });
    }
    if (route.startsWith('auto-collect/')) {
        return sendJson(res, 400, { message: 'Alma 版暂未启用自动收集。' });
    }
    if (route === 'img_host/sync/status' || route === 'img_host/sync/task_status' || route === 'sync/status') {
        return sendJson(res, 200, {
            available: false, running: false, configured: false,
            provider: '', message: 'Alma 版暂不支持图床同步。',
        });
    }
    if (route.startsWith('img_host/sync/') || route === 'sync/config') {
        return sendJson(res, 400, { message: 'Alma 版暂不支持图床同步。' });
    }

    // ---- 兼容旧版图库
    if (route === 'catalog') {
        const packId = resolvePackId(query);
        return sendJson(res, 200, buildCatalog(packId));
    }

    return sendJson(res, 404, { message: `未知接口: ${route}` });
}

async function settingsProviders() {
    const chat = [];
    try {
        const models = await semantic.listModels();
        for (const item of models) {
            chat.push({
                id: item.id,
                model: item.name || item.model,
                model_id: item.model,
                provider: item.provider,
                vision: item.vision,
            });
        }
    } catch { /* Alma 没启动时留空，页面仍能编辑其它设置 */ }
    return {
        chat,
        embedding: [{ id: 'alma-descriptions', model: '无需向量模型' }],
    };
}

function buildCatalog(packId) {
    const items = [];
    const cats = {};
    for (const [category, files] of Object.entries(store.imagesByCategory(packId))) {
        cats[category] = (cats[category] || 0) + files.length;
        for (const filename of files) {
            items.push({
                id: `${packId}:${category}/${filename}`,
                pack: packId,
                entry: `${category}/${filename}`,
                rel: `${category}/${filename}`,
                cats: [category],
                caption: '',
                visible: '',
                tags: [],
            });
        }
    }
    return { items, cats, packs: store.listPacks() };
}

// ------------------------------------------------------------------ 服务
function createApp() {
    return createServer(async (req, res) => {
        const remote = req.socket.remoteAddress || '';
        if (!remote.includes('127.0.0.1') && !remote.includes('::1') && !remote.includes('::ffff:127.0.0.1')) {
            sendText(res, 403, 'loopback only');
            return;
        }
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        try {
            if (url.pathname === '/api/shutdown') {
                sendJson(res, 200, { ok: true });
                setImmediate(() => {
                    try { server?.close(); } catch { /* 已经在关 */ }
                    server = null;
                });
                return;
            }
            if (url.pathname === '/api/ping') {
                sendJson(res, 200, { app: 'alma-sticker-library', ok: true, version: 2 });
                return;
            }
            if (url.pathname === '/favicon.ico') {
                // 页面没有 favicon，返回空响应避免浏览器控制台报 404。
                res.writeHead(204);
                res.end();
                return;
            }
            if (url.pathname === '/api/plugin/page/bridge-sdk.js') {
                return serveFile(res, join(WEBUI_DIR, 'bridge.js'));
            }
            if (url.pathname.startsWith('/img/')) {
                const rest = url.pathname.slice(5);
                const slash = rest.indexOf('/');
                if (slash <= 0) return sendText(res, 400, 'bad path');
                return serveImage(res, decodeURIComponent(rest.slice(0, slash)), rest.slice(slash + 1));
            }
            if (url.pathname.startsWith('/api/')) {
                await handleApi(req, res, url);
                return;
            }
            if (serveStatic(res, url.pathname)) return;
            sendText(res, 404, 'not found');
        } catch (err) {
            const status = err?.status
                || (err instanceof URIError ? 400 : 0)
                || (err?.code === 'revision_conflict' ? 409 : 0)
                || (err?.code === 'conflict' || err?.code === 'missing_entry' ? 409 : 0)
                || (err?.code === 'not_found' || err?.code === 'missing_file' ? 404 : 0)
                || (err?.code === 'bad_request' ? 400 : 0)
                || (err?.code === 'exists' || err?.code === 'busy' ? 409 : 0)
                || 500;
            try {
                sendJson(res, status, { message: err?.message || String(err) });
            } catch { /* 响应已发送 */ }
        }
    });
}

export async function start(port = 0) {
    if (server) {
        const p = server.address().port;
        return { port: p, url: `http://127.0.0.1:${p}` };
    }
    let lastErr = null;
    let evicted = false;
    for (let i = 0; i <= 10; i += 1) {
        const tryPort = port === 0 ? 0 : port + i;
        const srv = createApp();
        try {
            await new Promise((resolve, reject) => {
                const onErr = (err) => reject(err);
                srv.once('error', onErr);
                srv.once('listening', () => {
                    srv.removeListener('error', onErr);
                    resolve();
                });
                srv.listen(tryPort, '127.0.0.1');
            });
            server = srv;
            const actual = srv.address().port;
            return { port: actual, url: `http://127.0.0.1:${actual}` };
        } catch (err) {
            lastErr = err;
            try { srv.close(); } catch { /* 没起来 */ }
            if (err.code !== 'EADDRINUSE') throw err;
            if (!evicted && port !== 0) {
                evicted = true;
                if (await tryEvict(port)) {
                    i -= 1;
                    continue;
                }
            }
        }
    }
    throw new Error(`端口 ${port} 起连续 10 个都被占用（${lastErr?.message || '未知'}）`);
}

const PROBE_RANGE = [8899, 8900, 8901, 8902, 8903, 8904, 8905, 8906, 8907, 8908, 8909];

export async function discover() {
    if (server) {
        const p = server.address().port;
        return { port: p, url: `http://127.0.0.1:${p}`, running: true };
    }
    for (const port of PROBE_RANGE) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(600) });
            if (!res.ok) continue;
            const data = await res.json();
            if (data?.app === 'alma-sticker-library') {
                return { port, url: `http://127.0.0.1:${port}`, running: true };
            }
        } catch { /* 继续 */ }
    }
    return { running: false };
}

async function tryEvict(port) {
    const base = `http://127.0.0.1:${port}`;
    try {
        const res = await fetch(`${base}/api/ping`, { signal: AbortSignal.timeout(800) });
        if (!res.ok) return false;
        const data = await res.json();
        if (data?.app !== 'alma-sticker-library') return false;
        try { await fetch(`${base}/api/shutdown`, { signal: AbortSignal.timeout(800) }); } catch { /* 忽略 */ }
        for (let i = 0; i < 6; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            try {
                await fetch(`${base}/api/ping`, { signal: AbortSignal.timeout(400) });
            } catch {
                return true;
            }
        }
        return false;
    } catch {
        return false;
    }
}

export function stop() {
    if (server) {
        server.close();
        server = null;
        return true;
    }
    return false;
}

export function status() {
    if (!server) return { running: false };
    const p = server.address().port;
    return { running: true, port: p, url: `http://127.0.0.1:${p}` };
}

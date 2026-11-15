/**
 * 图包与图片的磁盘操作。
 *
 * 目录协议与 AstrBot 表情包管理器兼容：
 *   packs/<id>/manifest.json
 *   packs/<id>/semantic_metadata.json
 *   packs/<id>/memes_data.json         分类描述（旧协议）
 *   packs/<id>/memes/<category>/*.gif
 *
 * 这里不关心 HTTP，只做文件与索引；所有操作都以 packId + 安全相对路径为边界。
 */

import {
    copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';
import {
    IMAGE_EXTS, INDEX_PATH, PACKS_DIR, SAFE_ID, countImages, ensureDir, fileSha256,
    isImage, isSafeName, listCategoryDirs, listCategoryImages, listDir, nowIso,
    readJson, relPath, sha256, writeJson, writeJsonAtomic,
} from './util.js?v=0.3.1-codex-20261114';
import { ensureDefaultRule, normalizePackIds } from './settings.js?v=0.3.1-codex-20261114';

const summaryCache = new Map();
const SUMMARY_TTL = 1500;

function cacheGet(key) {
    const hit = summaryCache.get(key);
    if (hit && Date.now() - hit.at < SUMMARY_TTL) return hit.value;
    if (hit) summaryCache.delete(key);
    return null;
}

function cacheSet(key, value) {
    summaryCache.set(key, { at: Date.now(), value });
    return value;
}

export function invalidatePack(packId = null) {
    if (packId) summaryCache.delete(packId);
    else summaryCache.clear();
}

export function packDir(packId) {
    const id = String(packId || '').trim();
    if (!SAFE_ID.test(id)) throw new Error(`非法表情包 id: ${packId}`);
    return join(PACKS_DIR, id);
}

export function memesDir(packId) {
    return join(packDir(packId), 'memes');
}

export function packExists(packId) {
    try {
        return existsSync(packDir(packId));
    } catch {
        return false;
    }
}

export function loadManifest(packId) {
    return readJson(join(packDir(packId), 'manifest.json'), {}) || {};
}

export function saveManifest(packId, manifest) {
    writeJsonAtomic(join(packDir(packId), 'manifest.json'), manifest);
    invalidatePack(packId);
}

export function loadRegistry() {
    const data = readJson(INDEX_PATH, null);
    if (data && Array.isArray(data.packs)) return data;
    return { schema_version: 1, packs: [] };
}

export function saveRegistry(data) {
    writeJsonAtomic(INDEX_PATH, { schema_version: 1, packs: data.packs || [] });
}

export function installedPackIds() {
    return listDir(PACKS_DIR, { dirs: true }).filter((id) => SAFE_ID.test(id) && existsSync(join(PACKS_DIR, id, 'manifest.json')));
}

function loadMemesData(packId) {
    return readJson(join(packDir(packId), 'memes_data.json'), {}) || {};
}

export function categoryDescriptions(packId) {
    const manifest = loadManifest(packId);
    const descriptions = {};
    for (const [name, meta] of Object.entries(manifest.categories || {})) {
        const value = typeof meta === 'string' ? meta : meta?.description;
        if (value) descriptions[name] = String(value);
    }
    const data = loadMemesData(packId);
    for (const [name, value] of Object.entries(data)) {
        const text = typeof value === 'string' ? value : value?.description;
        if (text) descriptions[name] = String(text);
    }
    return descriptions;
}

export function saveCategoryDescription(packId, category, description) {
    const manifest = loadManifest(packId);
    if (!manifest.categories || typeof manifest.categories !== 'object') manifest.categories = {};
    const prev = manifest.categories[category];
    manifest.categories[category] = {
        ...(prev && typeof prev === 'object' ? prev : {}),
        description: String(description || ''),
    };
    saveManifest(packId, manifest);
    const data = loadMemesData(packId);
    data[category] = String(description || '');
    writeJsonAtomic(join(packDir(packId), 'memes_data.json'), data);

    const metaPath = join(packDir(packId), 'semantic_metadata.json');
    const meta = readJson(metaPath, null);
    if (meta?.images) {
        let changed = false;
        for (const entry of Object.values(meta.images)) {
            if (entry?.category !== category) continue;
            entry.category_description = String(description || '');
            changed = true;
        }
        if (changed) writeJsonAtomic(metaPath, meta);
    }
    invalidatePack(packId);
}

export function removeCategoryDescription(packId, category) {
    const name = String(category || '').trim();
    const manifest = loadManifest(packId);
    if (manifest.categories) delete manifest.categories[name];
    saveManifest(packId, manifest);
    const data = loadMemesData(packId);
    delete data[name];
    writeJsonAtomic(join(packDir(packId), 'memes_data.json'), data);
    invalidatePack(packId);
    return { category: name };
}

/** 有些图片的描述被整段存成了模型返回的 JSON 字符串，取字段时先拆开。 */
function parseBlob(value) {
    const text = String(value ?? '').trim();
    if (!text.startsWith('{') || !text.includes('"')) return null;
    try {
        const obj = JSON.parse(text);
        if (obj && typeof obj === 'object') return obj;
    } catch {
        // 多半是被 slice 截断的半截 JSON，按字段抠出来。
    }
    const out = {};
    for (const key of ['caption', 'visible_text', 'use_when', 'avoid_when']) {
        // 截断后连收尾引号都可能没有，所以末尾的引号是可选的。
        const match = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"?`).exec(text);
        if (!match) continue;
        try {
            out[key] = JSON.parse(`"${match[1]}"`);
        } catch {
            out[key] = match[1];
        }
    }
    return Object.keys(out).length ? out : null;
}

const BLOB_FIELDS = ['caption', 'visible_text', 'use_when', 'avoid_when'];

function unwrapEntry(entry) {
    if (!entry || typeof entry !== 'object') return entry;
    const blob = parseBlob(entry.caption);
    if (blob) {
        for (const key of BLOB_FIELDS) {
            const value = String(blob[key] ?? '').trim();
            if (value && !String(entry[key] ?? '').trim()) entry[key] = value;
        }
        entry.caption = String(blob.caption || '').trim() || String(entry.caption || '').trim();
    }
    for (const key of BLOB_FIELDS) {
        const nested = parseBlob(entry[key]);
        if (nested && String(nested[key] ?? '').trim()) entry[key] = String(nested[key]).trim();
    }
    return entry;
}

export function loadSemanticMetadata(packId) {
    const data = readJson(join(packDir(packId), 'semantic_metadata.json'), { images: {} });
    if (!data || typeof data !== 'object' || !data.images || typeof data.images !== 'object') {
        return { images: {} };
    }
    for (const entry of Object.values(data.images)) unwrapEntry(entry);
    return data;
}

export function saveSemanticMetadata(packId, data) {
    // 包可能已被卸载；任务收尾时不要再把目录写回来。
    if (!existsSync(packDir(packId))) return;
    writeJsonAtomic(join(packDir(packId), 'semantic_metadata.json'), data);
    invalidatePack(packId);
}

/** 语义条目 → 相对 memes 的路径。 */
export function entryRelPath(entry) {
    const raw = String(entry?.relative_path || entry?.file || entry?.path || '').replace(/\\/g, '/');
    if (!raw) return '';
    return raw.startsWith('memes/') ? raw.slice(6) : raw;
}

export function semanticPathMap(packId) {
    const meta = loadSemanticMetadata(packId);
    const map = new Map();
    for (const [id, entry] of Object.entries(meta.images)) {
        const rel = entryRelPath(entry);
        if (rel) map.set(rel, { id, entry });
    }
    return { meta, map };
}

export function imagesByCategory(packId) {
    const root = memesDir(packId);
    const out = {};
    for (const category of listCategoryDirs(root)) {
        out[category] = listCategoryImages(root, category);
    }
    return out;
}

export function countPackImages(packId) {
    return countImages(memesDir(packId));
}

function entryDone(entry) {
    return Boolean(entry && String(entry.caption || '').trim() && entry.caption_status !== 'failed' && entry.caption_status !== 'pending');
}

export function semanticSummary(packId) {
    const root = memesDir(packId);
    const categories = listCategoryDirs(root);
    let imageCount = 0;
    const rels = new Set();
    for (const category of categories) {
        for (const filename of listCategoryImages(root, category)) {
            imageCount += 1;
            rels.add(`${category}/${filename}`);
        }
    }

    const meta = loadSemanticMetadata(packId);
    const entries = Object.values(meta.images || {});
    const mapped = new Set();
    let done = 0;
    let failed = 0;
    for (const entry of entries) {
        const rel = entryRelPath(entry);
        if (rel && rels.has(rel)) mapped.add(rel);
        if (entryDone(entry)) done += 1;
        else if (entry?.caption_status === 'failed' || entry?.error) failed += 1;
    }
    const total = entries.length;
    const missing = [...rels].filter((rel) => !mapped.has(rel)).length;
    const changed = missing > 0 || (total > 0 && done < imageCount);
    let status = 'none';
    if (total > 0) status = done >= imageCount && imageCount > 0 ? 'complete' : 'partial';

    return {
        semantic_status: status,
        semantic_caption_total: total,
        semantic_caption_done: done,
        semantic_caption_failed: failed,
        semantic_files_changed: changed,
        semantic_missing_files: missing,
        semantic_complete: imageCount > 0 && done >= imageCount,
    };
}

export function packSummary(packId) {
    const cached = cacheGet(`summary:${packId}`);
    if (cached) return cached;
    const dir = packDir(packId);
    if (!existsSync(dir)) throw new Error(`表情包不存在: ${packId}`);
    const manifest = loadManifest(packId);
    const root = join(dir, 'memes');
    const categories = listCategoryDirs(root);
    let imageCount = 0;
    for (const category of categories) imageCount += listCategoryImages(root, category).length;
    const semantic = semanticSummary(packId);
    const registry = loadRegistry();
    const regEntry = (registry.packs || []).find((item) => item?.id === packId) || {};
    const summary = {
        id: packId,
        name: String(regEntry.name || manifest.name || packId),
        version: String(manifest.version || regEntry.version || '0.0.0'),
        description: String(manifest.description || regEntry.description || ''),
        author: manifest.author || '',
        license: manifest.license || '',
        homepage: manifest.homepage || manifest.source?.repo || '',
        enabled: true,
        installed_at: regEntry.installed_at || null,
        is_default: false,
        image_count: imageCount,
        category_count: categories.length,
        categories: Object.fromEntries(categories.map((category) => [category, listCategoryImages(root, category).length])),
        has_semantic_metadata: existsSync(join(dir, 'semantic_metadata.json')),
        is_legacy_pack: false,
        supports_vector_rebuild: true,
        semantic_index_mode: 'descriptions',
        ...semantic,
    };
    return cacheSet(`summary:${packId}`, summary);
}

export function listPacks() {
    const ids = installedPackIds();
    ensureDefaultRule(ids);
    const rules = readJson(join(PACKS_DIR, '..', 'rules.json'), { rules: [] });
    const fallback = rules.rules?.find((rule) => rule?.scope === 'default');
    const defaults = new Set(fallback ? normalizePackIds(fallback) : []);
    const packs = [];
    for (const id of ids) {
        try {
            const pack = packSummary(id);
            pack.is_default = defaults.size ? defaults.has(id) : packs.length === 0;
            packs.push(pack);
        } catch {
            // 单个坏包不能拖垮整页
        }
    }
    return packs;
}

export function syncRegistry() {
    const ids = installedPackIds();
    const packs = [];
    for (const id of ids) {
        const summary = packSummary(id);
        packs.push({
            id,
            name: summary.name,
            version: summary.version,
            description: summary.description,
            license: summary.license,
            image_count: summary.image_count,
            categories: summary.categories,
            has_semantic: summary.has_semantic_metadata,
            path: packDir(id),
            updated_at: nowIso(),
        });
    }
    saveRegistry({ packs });
    return packs;
}

// ------------------------------------------------------------------ 分类
export function updateDescriptionRaw(packId, category, description) {
    saveCategoryDescription(packId, category, description);
}

export function createCategory(packId, category, description = '') {
    const name = String(category || '').trim();
    if (!isSafeName(name) || name.startsWith('.')) throw new Error('分类名称非法');
    ensureDir(join(memesDir(packId), name));
    if (description) saveCategoryDescription(packId, name, description);
    invalidatePack(packId);
    return { category: name, description: description || categoryDescriptions(packId)[name] || '' };
}

export function renameCategory(packId, oldName, newName) {
    const from = String(oldName || '').trim();
    const to = String(newName || '').trim();
    if (!isSafeName(from) || !isSafeName(to) || to.startsWith('.')) throw new Error('分类名称非法');
    if (from === to) return { category: to };
    const root = memesDir(packId);
    const src = join(root, from);
    const dest = join(root, to);
    if (!existsSync(src)) throw new Error(`分类不存在: ${from}`);
    if (existsSync(dest)) throw new Error(`分类已存在: ${to}`);
    renameSync(src, dest);

    const manifest = loadManifest(packId);
    if (manifest.categories && from in manifest.categories) {
        manifest.categories[to] = manifest.categories[from];
        delete manifest.categories[from];
        saveManifest(packId, manifest);
    }
    const data = loadMemesData(packId);
    if (from in data) {
        data[to] = data[from];
        delete data[from];
        writeJsonAtomic(join(packDir(packId), 'memes_data.json'), data);
    }

    const metaPath = join(packDir(packId), 'semantic_metadata.json');
    const meta = readJson(metaPath, null);
    if (meta?.images) {
        let changed = false;
        for (const entry of Object.values(meta.images)) {
            const rel = entryRelPath(entry);
            if (!rel.startsWith(`${from}/`)) continue;
            const next = `${to}/${rel.slice(from.length + 1)}`;
            if (entry.relative_path?.startsWith('memes/')) entry.relative_path = `memes/${next}`;
            if (entry.file) entry.file = next;
            if (entry.path) entry.path = next;
            if (entry.category === from) entry.category = to;
            if (entry.category_tag === `category:${from}`) entry.category_tag = `category:${to}`;
            changed = true;
        }
        if (changed) writeJsonAtomic(metaPath, meta);
    }
    invalidatePack(packId);
    return { category: to, old_category: from };
}

export function deleteCategory(packId, category) {
    const name = String(category || '').trim();
    if (!isSafeName(name)) throw new Error('分类名称非法');
    const dir = join(memesDir(packId), name);
    let removed = 0;
    if (existsSync(dir)) {
        removed = listCategoryImages(memesDir(packId), name).length;
        rmSync(dir, { recursive: true, force: true });
    }
    const manifest = loadManifest(packId);
    if (manifest.categories) delete manifest.categories[name];
    saveManifest(packId, manifest);
    const data = loadMemesData(packId);
    delete data[name];
    writeJsonAtomic(join(packDir(packId), 'memes_data.json'), data);

    const metaPath = join(packDir(packId), 'semantic_metadata.json');
    const meta = readJson(metaPath, null);
    if (meta?.images) {
        let changed = false;
        for (const [id, entry] of Object.entries(meta.images)) {
            if (entry?.category === name || entryRelPath(entry).startsWith(`${name}/`)) {
                delete meta.images[id];
                changed = true;
            }
        }
        if (changed) writeJsonAtomic(metaPath, meta);
    }
    invalidatePack(packId);
    return { category: name, removed_images: removed };
}

export function clearCategory(packId, category) {
    const name = String(category || '').trim();
    if (!isSafeName(name)) throw new Error('分类名称非法');
    const dir = join(memesDir(packId), name);
    let removed = 0;
    if (existsSync(dir)) {
        for (const filename of listCategoryImages(memesDir(packId), name)) {
            rmSync(join(dir, filename), { force: true });
            removed += 1;
        }
    }
    const metaPath = join(packDir(packId), 'semantic_metadata.json');
    const meta = readJson(metaPath, null);
    if (meta?.images) {
        let changed = false;
        for (const [id, entry] of Object.entries(meta.images)) {
            if (entry?.category === name || entryRelPath(entry).startsWith(`${name}/`)) {
                delete meta.images[id];
                changed = true;
            }
        }
        if (changed) writeJsonAtomic(metaPath, meta);
    }
    invalidatePack(packId);
    return { category: name, removed_images: removed };
}

// ------------------------------------------------------------------ 图片
function nextFreeName(dir, filename) {
    if (!existsSync(join(dir, filename))) return filename;
    const ext = extname(filename);
    const stem = basename(filename, ext);
    for (let i = 2; i < 10000; i += 1) {
        const candidate = `${stem} (${i})${ext}`;
        if (!existsSync(join(dir, candidate))) return candidate;
    }
    throw new Error('无法生成不冲突的文件名');
}

export function addImage(packId, category, filename, buffer) {
    const cat = String(category || '').trim();
    if (!isSafeName(cat)) throw new Error('分类名称非法');
    const name = basename(String(filename || '')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    if (!name || !IMAGE_EXTS.has(extname(name).toLowerCase())) throw new Error('不支持的图片格式');
    const dir = ensureDir(join(memesDir(packId), cat));
    const digest = sha256(buffer);
    for (const existing of listCategoryImages(memesDir(packId), cat)) {
        try {
            if (fileSha256(join(dir, existing)) === digest) {
                const err = new Error(`图片内容重复: ${existing}`);
                err.code = 'duplicate_emoji';
                err.existing_filename = existing;
                throw err;
            }
        } catch (err) {
            if (err.code === 'duplicate_emoji') throw err;
        }
    }
    const finalName = nextFreeName(dir, name);
    writeFileSync(join(dir, finalName), buffer);
    invalidatePack(packId);
    return { category: cat, filename: finalName };
}

export function deleteImage(packId, category, filename) {
    const cat = String(category || '').trim();
    const name = String(filename || '').trim();
    if (!isSafeName(cat) || !isSafeName(name)) throw new Error('分类或文件名无效');
    const full = join(memesDir(packId), cat, name);
    if (!existsSync(full)) return false;
    rmSync(full, { force: true });
    removeSemanticEntry(packId, `${cat}/${name}`);
    invalidatePack(packId);
    return true;
}

export function moveImage(packId, sourceCategory, targetCategory, filename) {
    const srcCat = String(sourceCategory || '').trim();
    const dstCat = String(targetCategory || '').trim();
    const name = String(filename || '').trim();
    if (!isSafeName(srcCat) || !isSafeName(dstCat) || !isSafeName(name)) throw new Error('分类或文件名无效');
    const src = join(memesDir(packId), srcCat, name);
    if (!existsSync(src)) {
        const err = new Error(`文件不存在: ${name}`);
        err.code = 'missing_file';
        throw err;
    }
    const dstDir = ensureDir(join(memesDir(packId), dstCat));
    const finalName = nextFreeName(dstDir, name);
    renameSync(src, join(dstDir, finalName));
    renameSemanticEntry(packId, `${srcCat}/${name}`, `${dstCat}/${finalName}`, dstCat);
    invalidatePack(packId);
    return { filename: finalName };
}

export function copyImage(packId, sourceCategory, targetCategory, filename) {
    const srcCat = String(sourceCategory || '').trim();
    const dstCat = String(targetCategory || '').trim();
    const name = String(filename || '').trim();
    if (!isSafeName(srcCat) || !isSafeName(dstCat) || !isSafeName(name)) throw new Error('分类或文件名无效');
    const src = join(memesDir(packId), srcCat, name);
    if (!existsSync(src)) {
        const err = new Error(`文件不存在: ${name}`);
        err.code = 'missing_file';
        throw err;
    }
    const dstDir = ensureDir(join(memesDir(packId), dstCat));
    const digest = fileSha256(src);
    for (const existing of listCategoryImages(memesDir(packId), dstCat)) {
        try {
            if (fileSha256(join(dstDir, existing)) === digest) {
                const err = new Error(`目标分类已有相同图片: ${existing}`);
                err.code = 'conflict_file';
                err.existing_filename = existing;
                throw err;
            }
        } catch (err) {
            if (err.code === 'conflict_file') throw err;
        }
    }
    const finalName = nextFreeName(dstDir, name);
    copyFileSync(src, join(dstDir, finalName));
    invalidatePack(packId);
    return { filename: finalName };
}

export function batchDelete(packId, category, files) {
    const deleted = [];
    const missing = [];
    for (const filename of files || []) {
        try {
            if (deleteImage(packId, category, filename)) deleted.push(filename);
            else missing.push(filename);
        } catch {
            missing.push(filename);
        }
    }
    return { deleted_files: deleted, missing_files: missing, deleted_count: deleted.length };
}

export function batchMove(packId, sourceCategory, targetCategory, files) {
    const moved = [];
    const missing = [];
    const conflicting = [];
    for (const filename of files || []) {
        try {
            const { filename: finalName } = moveImage(packId, sourceCategory, targetCategory, filename);
            moved.push(finalName);
        } catch (err) {
            if (err.code === 'missing_file') missing.push(filename);
            else conflicting.push(filename);
        }
    }
    return {
        moved_files: moved,
        missing_files: missing,
        conflicting_files: conflicting,
        moved_count: moved.length,
    };
}

export function batchCopy(packId, sourceCategory, targetCategory, files) {
    const copied = [];
    const missing = [];
    const conflicting = [];
    for (const filename of files || []) {
        try {
            const { filename: finalName } = copyImage(packId, sourceCategory, targetCategory, filename);
            copied.push(finalName);
        } catch (err) {
            if (err.code === 'missing_file') missing.push(filename);
            else conflicting.push(filename);
        }
    }
    return {
        copied_files: copied,
        missing_files: missing,
        conflicting_files: conflicting,
        copied_count: copied.length,
    };
}

export function clearAllImages(packId) {
    const root = memesDir(packId);
    let total = 0;
    for (const category of listCategoryDirs(root)) {
        for (const filename of listCategoryImages(root, category)) {
            rmSync(join(root, category, filename), { force: true });
            total += 1;
        }
    }
    const metaPath = join(packDir(packId), 'semantic_metadata.json');
    if (existsSync(metaPath)) {
        const meta = readJson(metaPath, { images: {} });
        meta.images = {};
        writeJsonAtomic(metaPath, meta);
    }
    invalidatePack(packId);
    return { deleted_count: total };
}

export function removeSemanticEntry(packId, rel) {
    const metaPath = join(packDir(packId), 'semantic_metadata.json');
    const meta = readJson(metaPath, null);
    if (!meta?.images) return;
    let changed = false;
    for (const [id, entry] of Object.entries(meta.images)) {
        if (entryRelPath(entry) === rel) {
            delete meta.images[id];
            changed = true;
        }
    }
    if (changed) writeJsonAtomic(metaPath, meta);
}

function renameSemanticEntry(packId, oldRel, newRel, category) {
    const metaPath = join(packDir(packId), 'semantic_metadata.json');
    const meta = readJson(metaPath, null);
    if (!meta?.images) return;
    let changed = false;
    for (const entry of Object.values(meta.images)) {
        if (entryRelPath(entry) !== oldRel) continue;
        if (entry.relative_path?.startsWith('memes/')) entry.relative_path = `memes/${newRel}`;
        if (entry.file) entry.file = newRel;
        if (entry.path) entry.path = newRel;
        entry.category = category;
        entry.category_tag = `category:${category}`;
        changed = true;
    }
    if (changed) writeJsonAtomic(metaPath, meta);
}

// ------------------------------------------------------------------ 图包
function safePackId(name) {
    let id = String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
    if (!id || !SAFE_ID.test(id)) id = `pack-${Date.now().toString(36)}`;
    return id;
}

export function createPack({ name, description = '', id = '' }) {
    const displayName = String(name || '').trim();
    if (!displayName) throw new Error('表情包名称不能为空');
    let packId = id ? String(id) : safePackId(displayName);
    if (!SAFE_ID.test(packId)) throw new Error('非法表情包 id');
    let n = 2;
    while (existsSync(join(PACKS_DIR, packId))) {
        packId = `${safePackId(displayName)}-${n}`;
        n += 1;
    }
    const dir = ensureDir(join(PACKS_DIR, packId));
    ensureDir(join(dir, 'memes'));
    const manifest = {
        schema_version: 1,
        id: packId,
        name: displayName,
        version: '1.0.0',
        description: String(description || ''),
        author: '',
        homepage: '',
        license: '',
        tags: [],
        previews: [],
        categories: {},
    };
    writeJsonAtomic(join(dir, 'manifest.json'), manifest);
    writeJsonAtomic(join(dir, 'semantic_metadata.json'), { images: {} });
    writeJsonAtomic(join(dir, 'memes_data.json'), {});
    syncRegistry();
    ensureDefaultRule(installedPackIds());
    invalidatePack(packId);
    return { pack_id: packId, name: displayName, description: String(description || '') };
}

export function uninstallPack(packId, { deleteFiles = true } = {}) {
    const dir = packDir(packId);
    if (!existsSync(dir)) return { removed: false };
    const registry = loadRegistry();
    const before = (registry.packs || []).length;
    registry.packs = (registry.packs || []).filter((item) => item?.id !== packId);
    saveRegistry(registry);
    if (deleteFiles) rmSync(dir, { recursive: true, force: true });
    invalidatePack(packId);
    ensureDefaultRule(installedPackIds());
    return { removed: before !== registry.packs.length, files_deleted: deleteFiles };
}

export { nextFreeName };

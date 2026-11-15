/**
 * 图包导入/导出与运行时全量备份。
 *
 * 导入采用两段式：先 stage 到临时目录并检查，确认后再 apply。
 * 导出是 store-only zip，不压缩图片，避免额外 CPU 与潜在损坏。
 */

import {
    existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
    ROOT, SETTINGS_PATH, RULES_PATH, TMP_DIR, createZip, ensureDir,
    extractZip, listCategoryDirs, listCategoryImages, listDir, readJson,
    sha256,
} from './util.js?v=0.3.1-codex-20261114';
import { packDir, packExists, syncRegistry, installedPackIds } from './store.js?v=0.3.1-codex-20261114';
import { installPackDir } from './community.js?v=0.3.1-codex-20261114';
import { ensureDefaultRule, loadRules, saveRules } from './settings.js?v=0.3.1-codex-20261114';

const STAGE_TTL = 60 * 60 * 1000;
const stages = new Map();

function stageRoot(token) {
    return join(TMP_DIR, 'import', token);
}

function cleanupStages() {
    const now = Date.now();
    for (const [token, data] of stages) {
        if (now - data.at < STAGE_TTL) continue;
        stages.delete(token);
        try { rmSync(stageRoot(token), { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

// 插件重启后内存里的 token 都没了，旧的暂存目录可以直接清掉。
(function cleanupOrphanStages() {
    const root = join(TMP_DIR, 'import');
    try {
        if (!existsSync(root)) return;
        for (const name of readdirSync(root)) {
            rmSync(join(root, name), { recursive: true, force: true });
        }
    } catch {
        // 清理失败不影响使用
    }
})();

function detectRoot(dir) {
    if (existsSync(join(dir, 'manifest.json'))) return dir;
    const dirs = listDir(dir, { dirs: true });
    for (const child of dirs) {
        const candidate = join(dir, child);
        if (existsSync(join(candidate, 'manifest.json'))) return candidate;
    }
    return dir;
}

function inspectPack(dir) {
    const manifest = readJson(join(dir, 'manifest.json'), null);
    if (!manifest || typeof manifest !== 'object') throw new Error('压缩包里没有合法的 manifest.json');
    const memes = join(dir, 'memes');
    const categories = existsSync(memes) ? listCategoryDirs(memes) : [];
    let imageCount = 0;
    for (const category of categories) imageCount += listCategoryImages(memes, category).length;
    const semanticPath = join(dir, 'semantic_metadata.json');
    const semantic = readJson(semanticPath, null);
    const semanticEntries = semantic?.images && typeof semantic.images === 'object'
        ? Object.values(semantic.images) : [];
    const semanticDone = semanticEntries.filter((entry) => String(entry?.caption || '').trim()).length;
    const format = semanticEntries.length
        ? 'v2'
        : (manifest.schema_version >= 2 ? 'v2' : 'v1');
    return {
        pack_id: String(manifest.id || basename(dir)).trim(),
        name: String(manifest.name || manifest.id || basename(dir)),
        version: String(manifest.version || '0.0.0'),
        description: String(manifest.description || ''),
        image_count: imageCount,
        category_count: categories.length,
        semantic_metadata: semanticEntries.length > 0,
        semantic_done: semanticDone,
        vectors_present: existsSync(join(dir, 'semantic_index.json')),
        detected_format: format,
        export_mode: semanticEntries.length ? 'share' : 'legacy',
        warnings: imageCount ? [] : ['压缩包里没有找到图片'],
        manifest,
    };
}

export function stageImport(buffer, filename = 'pack.zip') {
    cleanupStages();
    if (!buffer?.length) throw new Error('上传文件为空');
    if (!String(filename).toLowerCase().endsWith('.zip') && buffer.readUInt32LE?.(0) !== 0x04034b50) {
        throw new Error('请上传 zip 格式的表情包');
    }
    const token = sha256(`${Date.now()}-${filename}-${buffer.length}`).slice(0, 32);
    const dir = stageRoot(token);
    ensureDir(dir);
    try {
        const zipPath = join(dir, 'upload.zip');
        writeFileSync(zipPath, buffer);
        const unpacked = join(dir, 'unpacked');
        extractZip(zipPath, unpacked);
        const root = detectRoot(unpacked);
        const info = inspectPack(root);
        stages.set(token, { at: Date.now(), dir, root, info });
        return { import_token: token, ...info };
    } catch (err) {
        // 解压或检查失败时清掉暂存目录，避免 _tmp/import 越积越多。
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        if (!err.code) err.code = 'bad_request';
        throw err;
    }
}

export async function applyImport({ import_token, overwrite = false, set_as_default = false } = {}) {
    cleanupStages();
    const stage = stages.get(String(import_token || ''));
    if (!stage) {
        const err = new Error('导入凭证已过期，请重新选择压缩包检查');
        err.code = 'not_found';
        throw err;
    }
    if (!existsSync(stage.root)) throw new Error('导入暂存目录已丢失，请重新检查压缩包');
    const packId = stage.info.pack_id;
    if (!packId) throw new Error('压缩包缺少 pack id');
    const result = installPackDir(stage.root, packId, { overwrite });
    let warning = '';
    if (set_as_default) {
        // 安装已经完成，规则写失败只作为警告返回。
        try {
            const rules = loadRules();
            const ids = new Set(installedPackIds());
            if (rules.rules?.length) {
                const next = rules.rules.map((rule) => (rule.scope === 'default'
                    ? { ...rule, pack_id: packId, pack_ids: [packId] } : rule));
                saveRules(next, ids);
            } else {
                ensureDefaultRule([...ids]);
            }
        } catch (err) {
            warning = `默认表情包设置失败：${err.message}`;
        }
    }
    stages.delete(String(import_token));
    try { rmSync(stage.dir, { recursive: true, force: true }); } catch { /* ignore */ }
    return {
        ...result,
        vectors_restored: false,
        vector_warning: 'Alma 版使用本地描述索引，未导入向量。',
        ...(warning ? { warning } : {}),
    };
}

function collectEntries(root, prefix = '') {
    const out = [];
    for (const name of readdirSync(root)) {
        const full = join(root, name);
        const st = statSync(full);
        const published = prefix ? `${prefix}/${name}` : name;
        if (st.isDirectory()) {
            // 保留空分类目录，导入后分类不会丢失。
            out.push({ name: `${published}/`, data: Buffer.alloc(0) });
            out.push(...collectEntries(full, published));
        } else {
            out.push({ name: published, file: full });
        }
    }
    return out;
}

export function exportStatus(packId) {
    return {
        pack_id: packId,
        vector_backup_available: false,
        embedding_model: '本地描述索引',
        embedding_dimension: 0,
    };
}

export function buildPackArchive(packId, { mode = 'share' } = {}) {
    const dir = packDir(packId);
    if (!existsSync(dir)) throw new Error(`表情包不存在: ${packId}`);
    const entries = [];
    for (const name of ['manifest.json', 'semantic_metadata.json', 'memes_data.json',
        'README.md', 'LICENSE', 'LICENSE.md', 'NOTICE.md']) {
        const full = join(dir, name);
        if (existsSync(full) && statSync(full).isFile()) {
            entries.push({ name, data: readFileSync(full) });
        }
    }
    const memes = join(dir, 'memes');
    if (existsSync(memes)) {
        for (const entry of collectEntries(memes, 'memes')) entries.push(entry);
    }
    const previews = join(dir, 'previews');
    if (existsSync(previews)) {
        for (const entry of collectEntries(previews, 'previews')) entries.push(entry);
    }
    const out = join(TMP_DIR, 'export', `${packId}-${mode}-${Date.now()}.zip`);
    createZip(entries, out);
    return { path: out, filename: `${packId}.zip` };
}

function backupDir(outputDir) {
    const chosen = String(outputDir || '').trim();
    if (chosen) {
        const full = resolve(chosen);
        if (!full.startsWith(resolve(homedir()))) throw new Error('备份目录必须位于用户目录内');
        ensureDir(full);
        return full;
    }
    const fallback = join(ROOT, '_backups');
    ensureDir(fallback);
    return fallback;
}

export function exportRuntimeBackup(outputDir = '') {
    const dir = backupDir(outputDir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const out = join(dir, `alma-sticker-backup-${stamp}.zip`);
    const entries = [];
    const tempFiles = [];
    try {
        for (const packId of installedPackIds()) {
            const packArchive = buildPackArchive(packId, { mode: 'backup' });
            entries.push({ name: `packs/${packId}.zip`, file: packArchive.path });
            tempFiles.push(packArchive.path);
        }
        for (const [name, path] of [['settings.json', SETTINGS_PATH], ['rules.json', RULES_PATH]]) {
            if (existsSync(path)) entries.push({ name, file: path });
        }
        createZip(entries, out);
    } finally {
        for (const path of tempFiles) {
            try { rmSync(path, { force: true }); } catch { /* ignore */ }
        }
    }
    return { archive_path: out, pack_count: installedPackIds().length };
}

export function importRuntimeBackup(source, { overwrite = false, fileName = 'backup.zip' } = {}) {
    const work = join(TMP_DIR, 'restore', `${Date.now()}-${basename(fileName)}`);
    ensureDir(work);
    let restored = 0;
    let skipped = 0;
    const failed = [];
    try {
        const zipPath = typeof source === 'string' ? resolve(source) : join(work, 'backup.zip');
        if (typeof source !== 'string') writeFileSync(zipPath, source);
        const unpacked = join(work, 'unpacked');
        extractZip(zipPath, unpacked);
        const packsSource = join(unpacked, 'packs');
        if (existsSync(packsSource)) {
            for (const name of readdirSync(packsSource)) {
                if (!name.endsWith('.zip')) continue;
                const packZip = join(packsSource, name);
                const packId = basename(name, '.zip');
                const tmp = join(work, `pack-${packId}`);
                ensureDir(tmp);
                try {
                    if (!overwrite && packExists(packId)) {
                        skipped += 1;
                        continue;
                    }
                    extractZip(packZip, tmp);
                    const root = detectRoot(tmp);
                    installPackDir(root, packId, { overwrite });
                    restored += 1;
                } catch (err) {
                    // 单个包损坏时跳过，继续恢复其它包。
                    failed.push({ pack: packId, error: err.message });
                }
            }
        }
        for (const [name, dest] of [['settings.json', SETTINGS_PATH], ['rules.json', RULES_PATH]]) {
            const src = join(unpacked, name);
            if (existsSync(src)) writeFileSync(dest, readFileSync(src));
        }
    } finally {
        try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    syncRegistry();
    ensureDefaultRule(installedPackIds());
    return { restored_packs: restored, skipped_packs: skipped, ...(failed.length ? { failed } : {}) };
}

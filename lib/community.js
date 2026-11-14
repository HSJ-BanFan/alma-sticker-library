/**
 * 社区资源广场：索引缓存、后台安装任务。
 *
 * 包来源是 anka-afk/astrbot-meme-pack-index，协议与 AstrBot 插件一致：
 *   { id, name, version, source: { type: 'github', repo, ref, subpath } }
 */

import { copyFileSync, createWriteStream, existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
    PACKS_DIR, ROOT, TMP_DIR, ensureDir, extractZip, listDir, nowIso, readJson,
    SAFE_ID, safeJoin, writeJsonAtomic,
} from './util.js?v=mwbplvvw';
import {
    invalidatePack, installedPackIds, loadManifest, packExists, packSummary,
    syncRegistry,
} from './store.js?v=mwbplvvw';
import { ensureDefaultRule, loadRules, saveRules } from './settings.js?v=mwbplvvw';

export const INDEX_URL = 'https://raw.githubusercontent.com/anka-afk/astrbot-meme-pack-index/main/community-index.json';
const CACHE_PATH = join(ROOT, 'community_index_cache.json');

let indexCache = null;
const jobs = new Map();
let activeJobId = '';

function randomId() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function cachedCommunity() {
    const data = readJson(CACHE_PATH, null);
    if (!data || !data.index || !Array.isArray(data.index.packs)) {
        const err = new Error('社区索引缓存不存在，请先在资源广场点击刷新资源。');
        err.code = 'not_found';
        throw err;
    }
    return data;
}

export async function fetchCommunity({ indexUrl = INDEX_URL, force = true } = {}) {
    if (!force && indexCache) return indexCache;
    const url = String(indexUrl || INDEX_URL);
    let res;
    try {
        res = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'follow' });
    } catch (err) {
        throw new Error(`拉取社区索引失败：${err.message}`);
    }
    if (!res.ok) throw new Error(`拉取社区索引失败：HTTP ${res.status}`);
    const index = await res.json();
    if (!index || !Array.isArray(index.packs)) throw new Error('社区索引格式不正确：缺少 packs');
    const data = {
        fetched_at: nowIso(),
        source_url: url,
        index,
    };
    writeJsonAtomic(CACHE_PATH, data);
    indexCache = data;
    return data;
}

export function findCommunityPack(packId) {
    const data = cachedCommunity();
    return (data.index.packs || []).find((item) => String(item?.id || '') === String(packId)) || null;
}

function badRequest(message) {
    return Object.assign(new Error(message), { code: 'bad_request' });
}

function resolveSource(payload) {
    if (payload?.source && typeof payload.source === 'object') return payload.source;
    const packId = String(payload?.pack_id || '').trim();
    if (!packId) throw badRequest('缺少 pack_id 或 source');
    const pack = findCommunityPack(packId);
    if (!pack) throw badRequest(`社区索引里没有 ${packId}`);
    return pack.source;
}

function sourceLabel(source) {
    return `${source?.repo || '未知仓库'}@${source?.ref || 'main'}`;
}

function archiveUrl(source) {
    const repo = String(source?.repo || '').trim();
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw badRequest('GitHub 仓库格式应为 owner/repo');
    const ref = String(source?.ref || 'main').trim();
    const kind = /^v?\d/.test(ref) ? 'tags' : 'heads';
    return `https://github.com/${repo}/archive/refs/${kind}/${encodeURIComponent(ref)}.zip`;
}

async function downloadWithProgress(url, dest, job) {
    const res = await fetch(url, { signal: job.controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    if (!res.body) throw new Error('下载失败：响应内容为空');
    const total = Number(res.headers.get('content-length') || 0);
    job.total_bytes = total;
    job.phase = 'downloading';
    job.message = '正在下载表情包…';
    ensureDir(join(dest, '..'));
    let downloaded = 0;
    const counter = new Transform({
        transform(chunk, _encoding, callback) {
            downloaded += chunk.length;
            job.downloaded_bytes = downloaded;
            job.progress = total ? Math.min(99, Math.round((downloaded / total) * 100)) : null;
            callback(null, chunk);
        },
    });
    // pipeline 会处理写流出错、取消和资源回收，避免未捕获的 'error' 事件。
    await pipeline(
        Readable.fromWeb(res.body),
        counter,
        createWriteStream(dest),
        { signal: job.controller.signal },
    );
    return downloaded;
}

export function installPackDir(srcDir, packId, options = {}) {
    return installFromDir(srcDir, packId, options);
}

function installFromDir(srcDir, packId, { overwrite = false } = {}) {
    const manifestPath = join(srcDir, 'manifest.json');
    if (!existsSync(manifestPath)) {
        const err = new Error('这个包没有 manifest.json，不是合法的表情包');
        err.code = 'bad_request';
        throw err;
    }
    if (!SAFE_ID.test(packId)) throw badRequest(`非法包 id: ${packId}`);
    const dest = join(PACKS_DIR, packId);
    if (existsSync(dest) && !overwrite) {
        const err = new Error(`${packId} 已经装过了`);
        err.code = 'exists';
        throw err;
    }
    // 先复制到同盘暂存目录，成功后再替换，避免覆盖安装中途失败毁掉旧包。
    const stage = join(PACKS_DIR, `.install-${packId}-${Date.now().toString(36)}`);
    ensureDir(stage);
    try {
        for (const name of ['manifest.json', 'semantic_metadata.json', 'memes_data.json',
            'README.md', 'LICENSE', 'LICENSE.md', 'NOTICE.md']) {
            const src = join(srcDir, name);
            if (existsSync(src)) copyFileSync(src, join(stage, name));
        }
        for (const name of ['memes', 'previews']) {
            const src = join(srcDir, name);
            if (existsSync(src)) copyDirRecursive(src, join(stage, name));
        }
        if (!existsSync(join(stage, 'manifest.json'))) {
            throw new Error('复制表情包失败：manifest.json 没有写入');
        }
        if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
        renameSync(stage, dest);
    } catch (err) {
        try { rmSync(stage, { recursive: true, force: true }); } catch { /* ignore */ }
        throw err;
    }
    const manifest = readJson(manifestPath, {}) || {};
    invalidatePack(packId);
    syncRegistry();
    ensureDefaultRule(installedPackIds());
    return {
        pack_id: packId,
        name: manifest.name || packId,
        version: manifest.version || '0.0.0',
        image_count: packSummary(packId).image_count,
    };
}

function copyDirRecursive(src, dest) {
    ensureDir(dest);
    for (const name of readdirSync(src)) {
        const from = join(src, name);
        const to = join(dest, name);
        const st = statSync(from);
        if (st.isDirectory()) copyDirRecursive(from, to);
        else copyFileSync(from, to);
    }
}

function runInstall(job) {
    const { source, overwrite, setAsDefault } = job;
    const packId = job.pack_id;
    const work = join(TMP_DIR, `install-${job.id}`);
    const zip = join(work, 'pack.zip');
    const out = join(work, 'unpacked');
    (async () => {
        try {
            job.status = 'running';
            job.phase = 'connecting';
            job.message = '正在连接下载源…';
            ensureDir(work);
            await downloadWithProgress(archiveUrl(source), zip, job);
            if (job.status === 'cancelling') throw Object.assign(new Error('安装已取消'), { code: 'aborted' });
            job.phase = 'extracting';
            job.progress = 99;
            job.message = '正在解压…';
            extractZip(zip, out);
            const children = listDir(out, { dirs: true });
            const root = children.length === 1 ? join(out, children[0]) : out;
            const sub = source?.subpath && source.subpath !== '.'
                ? safeJoin(root, String(source.subpath).replace(/\\/g, '/'))
                : root;
            if (!sub) throw Object.assign(new Error('包所在目录不合法'), { code: 'bad_request' });
            job.phase = 'installing';
            job.message = '正在写入表情包…';
            const result = installFromDir(sub, packId, { overwrite });
            if (setAsDefault) {
                // 包已经装好，规则写失败只提示，不把安装判成失败。
                try {
                    const rules = loadRules();
                    const ids = installedPackIds();
                    if (!rules.rules?.length) {
                        ensureDefaultRule(ids);
                    } else {
                        const rulesList = rules.rules.map((rule) => (rule.scope === 'default'
                            ? { ...rule, pack_id: packId, pack_ids: [packId] } : rule));
                        saveRules(rulesList, new Set(ids));
                    }
                } catch (err) {
                    job.warning = `默认表情包设置失败：${err.message}`;
                }
            }
            job.progress = 100;
            job.phase = 'done';
            job.status = 'succeeded';
            job.message = '安装完成';
            job.result = result;
            job.finished_at = nowIso();
        } catch (err) {
            const cancelled = job.status === 'cancelling' || job.cancel_requested
                || err.code === 'aborted' || err.name === 'AbortError';
            job.status = cancelled ? 'cancelled' : 'failed';
            job.message = cancelled ? '安装已取消' : err.message;
            job.error = cancelled ? '' : err.message;
            job.detail = cancelled ? '' : (err.stack || '');
            job.finished_at = nowIso();
        } finally {
            try {
                rmSync(work, { recursive: true, force: true });
            } catch {
                // 清理失败不影响结果
            }
            if (activeJobId === job.id) activeJobId = '';
        }
    })();
}

function nextFreePackId(base) {
    // 留出后缀空间，保证生成结果仍符合 SAFE_ID 的 64 字符上限。
    const stem = String(base).slice(0, 60);
    for (let i = 2; i <= 99; i += 1) {
        const candidate = `${stem}-${i}`;
        if (SAFE_ID.test(candidate) && !packExists(candidate)) return candidate;
    }
    throw new Error(`同名表情包太多，无法为 ${base} 生成新的包 id`);
}

export function startInstall(payload = {}) {
    const running = [...jobs.values()].find((job) => job.status === 'running' || job.status === 'cancelling');
    if (running) {
        const err = new Error('已有安装任务正在执行，请稍后重试');
        err.code = 'busy';
        throw err;
    }
    const source = resolveSource(payload);
    const sourcePack = payload?.pack_id ? findCommunityPack(payload.pack_id) : null;
    const packId = String(payload?.pack_id || payload?.pack_id_hint
        || (sourcePack?.id || '').trim()
        || basename(String(source?.repo || '').split('/').pop() || '').replace(/-\d+\.\d+\.\d+$/, '')
        || `pack-${randomId()}`).trim();
    if (!SAFE_ID.test(packId)) throw badRequest(`非法包 id: ${packId}`);
    // 与源项目一致：未勾选覆盖时保留原包，新包追加 -2、-3 后缀。
    const finalPackId = packExists(packId) && !payload.overwrite ? nextFreePackId(packId) : packId;
    const job = {
        id: randomId(),
        status: 'queued',
        phase: 'queued',
        message: '安装任务已排队',
        progress: 0,
        downloaded_bytes: 0,
        total_bytes: 0,
        created_at: nowIso(),
        pack_id: finalPackId,
        source,
        source_label: sourcePack?.name || sourceLabel(source),
        overwrite: Boolean(payload.overwrite),
        setAsDefault: Boolean(payload.set_as_default),
        controller: new AbortController(),
        result: null,
        error: '',
    };
    jobs.set(job.id, job);
    activeJobId = job.id;
    runInstall(job);
    return { job_id: job.id, pack_id: finalPackId, status: job.status };
}

export function installStatus(jobId = '') {
    const id = String(jobId || activeJobId || '');
    const job = jobs.get(id) || [...jobs.values()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    if (!job) {
        const err = new Error('安装任务不存在或已过期');
        err.code = 'not_found';
        throw err;
    }
    return {
        job_id: job.id,
        status: job.status,
        phase: job.phase,
        message: job.message,
        progress: job.progress,
        downloaded_bytes: job.downloaded_bytes,
        total_bytes: job.total_bytes,
        source_label: job.source_label,
        pack_id: job.pack_id,
        created_at: job.created_at,
        finished_at: job.finished_at || '',
        result: job.result,
        error: job.error,
        detail: job.detail || '',
    };
}

export function cancelInstall(jobId = '') {
    const id = String(jobId || activeJobId || '');
    const job = jobs.get(id) || [...jobs.values()].find((item) => item.status === 'running');
    if (!job) return { message: '没有可取消的安装任务。' };
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) {
        return { message: '任务已经结束。' };
    }
    job.status = 'cancelling';
    job.cancel_requested = true;
    job.message = '正在取消…';
    job.controller.abort();
    return { message: '已请求取消安装。' };
}

/** 社区更新状态。Alma 版先只报告版本差异，更新走覆盖安装。 */
export function communityUpdates() {
    let data;
    try {
        data = cachedCommunity();
    } catch {
        return { packs: {} };
    }
    const index = data.index;
    const byId = new Map((index.packs || []).map((item) => [String(item.id), item]));
    const out = {};
    for (const packId of installedPackIds()) {
        const remote = byId.get(packId);
        if (!remote) continue;
        let current = '0.0.0';
        try {
            current = String(loadManifest(packId).version || '0.0.0');
        } catch {
            // 忽略
        }
        out[packId] = {
            installed: true,
            current_version: current,
            latest_version: String(remote.version || '0.0.0'),
            // 逐图差异更新需要完整的协议支持；先不提供入口，避免误覆盖。
            available: false,
            backups: [],
            latest: remote,
        };
    }
    return { packs: out };
}

export function installOfficialFirst() {
    let pack;
    try {
        const data = cachedCommunity();
        pack = (data.index.packs || []).find((item) => String(item.id || '').startsWith('official-'))
            || data.index.packs?.[0];
    } catch {
        throw new Error('社区索引缓存不存在，请先打开资源广场刷新资源。');
    }
    if (!pack) throw new Error('社区索引里没有可安装的资源包');
    return startInstall({ pack_id: pack.id, source: pack.source, set_as_default: true });
}

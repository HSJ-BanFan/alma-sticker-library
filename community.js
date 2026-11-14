/**
 * 社区表情包 —— 拉 AstrBot 官方的 community-index，装包里任何一个。
 *
 * 协议来源：https://github.com/anka-afk/astrbot-meme-pack-index
 * 索引格式：{ packs: [{ id, name, version, repo: { type, repo, ref, subpath } }] }
 *
 * 装包流程跟 astrbot_plugin_meme_manager 一致：
 *   下载 GitHub archive zip → 解压 → 校验 manifest.json → 搬进 packs/<id>/
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const ROOT = join(homedir(), '.config', 'alma', 'stickers');
const PACKS_DIR = join(ROOT, 'packs');
const TMP_DIR = join(ROOT, '_tmp');
const INDEX_URL =
    'https://raw.githubusercontent.com/anka-afk/astrbot-meme-pack-index/main/community-index.json';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function readJson(path, fallback = null) {
    try {
        return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
    } catch {
        return fallback;
    }
}

function writeJson(path, data) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
}

function loadIndex() {
    return readJson(join(ROOT, 'index.json'), { schema_version: 1, packs: [] });
}

function saveIndex(d) {
    writeJson(join(ROOT, 'index.json'), d);
}

/** 拉社区索引。带 5 分钟内存缓存，避免反复请求 GitHub。 */
let cache = null;

export async function fetchCommunity({ refresh = false } = {}) {
    if (!refresh && cache && Date.now() - cache.at < 5 * 60 * 1000) {
        return cache.data;
    }
    const res = await fetch(INDEX_URL, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`拉社区索引失败: HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !Array.isArray(data.packs)) throw new Error('索引格式不对: 缺 packs');
    cache = { at: Date.now(), data };
    return data;
}

/** 已装包的 id 集合，用来给社区列表打「已装」标记。 */
function installedIds() {
    return new Set((loadIndex().packs || []).map((p) => p.id));
}

export async function listCommunity({ refresh = false } = {}) {
    const data = await fetchCommunity({ refresh });
    const mine = installedIds();

    return {
        total: data.packs.length,
        installed: mine.size,
        packs: data.packs.map((p) => ({
            id: p.id,
            name: p.name || p.id,
            version: p.version || '',
            description: p.description || '',
            license: p.license || '',
            categories: p.categories ? Object.keys(p.categories).length : null,
            image_count: p.image_count || null,
            semantic: Boolean(p.semantic || p.semantic_version),
            repo: (p.source || p.repo)?.repo || '',
            ref: (p.source || p.repo)?.ref || 'main',
            installed: mine.has(p.id),
        })),
    };
}

/**
 * 下载文件。
 *
 * 为什么不用 PowerShell：Alma 主进程的 PATH 里不一定有 powershell.exe
 * （实测在 Alma 里 spawn 会 ENOENT），而 Node 自带 fetch，零依赖最稳。
 */
async function download(url, dest, timeout = 180000) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: 'follow' });
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(dest, buf);
    return buf.length;
}

/**
 * 最小 zip 解压。只支持 store(0) 和 deflate(8) —— GitHub 的 archive 都是这两种。
 *
 * 为什么手写：Node 没有内置 zip 解压，而 Alma 主进程里 spawn
 * powershell / tar 都会 ENOENT。手写这 60 行比引一个依赖更稳。
 */
function extractZip(zipPath, destDir) {
    const buf = readFileSync(zipPath);
    mkdirSync(destDir, { recursive: true });

    // 从尾部找 End of Central Directory (EOCD)
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i -= 1) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 zip 文件');

    const count = buf.readUInt16LE(eocd + 10);
    let ptr = buf.readUInt32LE(eocd + 16);

    for (let n = 0; n < count; n += 1) {
        if (buf.readUInt32LE(ptr) !== 0x02014b50) break;

        const method = buf.readUInt16LE(ptr + 10);
        const compSize = buf.readUInt32LE(ptr + 20);
        const nameLen = buf.readUInt16LE(ptr + 28);
        const extraLen = buf.readUInt16LE(ptr + 30);
        const commentLen = buf.readUInt16LE(ptr + 32);
        const localOff = buf.readUInt32LE(ptr + 42);
        const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
        ptr += 46 + nameLen + extraLen + commentLen;

        // 跳过目录条目和危险路径
        if (name.endsWith('/') || name.includes('..')) continue;

        // 定位本地文件头
        if (buf.readUInt32LE(localOff) !== 0x04034b50) continue;
        const lNameLen = buf.readUInt16LE(localOff + 26);
        const lExtraLen = buf.readUInt16LE(localOff + 28);
        const dataStart = localOff + 30 + lNameLen + lExtraLen;

        const raw = buf.subarray(dataStart, dataStart + compSize);
        let content;
        if (method === 0) content = raw;
        else if (method === 8) content = inflateRawSync(raw);
        else continue; // 未知压缩方式，跳过

        const target = join(destDir, name);
        mkdirSync(join(target, '..'), { recursive: true });
        writeFileSync(target, content);
    }
}

/** 递归复制目录。纯 Node，不依赖 robocopy。 */
function copyDir(src, dest) {
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(src)) {
        const from = join(src, name);
        const to = join(dest, name);
        const st = statSync(from);
        if (st.isDirectory()) copyDir(from, to);
        else writeFileSync(to, readFileSync(from));
    }
}

/** GitHub archive zip 下载 + 解压。纯 Node，零外部依赖。 */
async function downloadAndExtract(repo, ref) {
    const safe = repo.replace(/[^A-Za-z0-9._-]/g, '_');
    const zip = join(TMP_DIR, `${safe}_${ref}.zip`);
    const out = join(TMP_DIR, `${safe}_${ref}`);
    mkdirSync(TMP_DIR, { recursive: true });

    // v1.0.0 这种是 tag，main/master 这种是分支
    const isTag = /^v?\d/.test(ref) || /^v/.test(ref);
    const url = `https://github.com/${repo}/archive/refs/${isTag ? 'tags' : 'heads'}/${ref}.zip`;

    await download(url, zip);
    extractZip(zip, out);

    // GitHub zip 会套一层 <repo>-<ref>/
    const children = readdirSync(out).filter((n) => {
        try {
            return statSync(join(out, n)).isDirectory();
        } catch {
            return false;
        }
    });
    return { dir: children.length === 1 ? join(out, children[0]) : out, zip, out };
}

/** 把解压出来的包目录搬进 packs/<id>。只搬需要的东西。 */
function installFromDir(srcDir, packId, overwrite) {
    const manifest = readJson(join(srcDir, 'manifest.json'));
    if (!manifest) throw new Error('这个包没有 manifest.json，不是合法的表情包');

    if (!SAFE_ID.test(packId)) throw new Error(`非法包 id: ${packId}`);

    const dest = join(PACKS_DIR, packId);
    if (existsSync(dest)) {
        if (!overwrite) throw new Error(`${packId} 已经装过了`);
        rmSync(dest, { recursive: true, force: true });
    }
    mkdirSync(dest, { recursive: true });

    const files = ['manifest.json', 'semantic_metadata.json', 'README.md',
        'LICENSE', 'LICENSE.md', 'NOTICE.md'];
    const dirs = ['memes', 'previews'];

    for (const name of files) {
        const src = join(srcDir, name);
        if (existsSync(src)) {
            writeFileSync(join(dest, name), readFileSync(src));
        }
    }
    for (const name of dirs) {
        const src = join(srcDir, name);
        if (existsSync(src)) copyDir(src, join(dest, name));
    }

    // 统计 + 注册。
    // 社区包两种：有 semantic_metadata.json 的读它，没有的就靠目录名分类。
    const semantic = readJson(join(dest, 'semantic_metadata.json'), { images: {} }).images || {};
    const hasSemantic = Object.keys(semantic).length > 0;

    const cats = {};
    let fileCount = 0;
    const memesDir = join(dest, 'memes');

    if (hasSemantic) {
        for (const item of Object.values(semantic)) {
            for (const t of item.tags || []) {
                if (typeof t === 'string' && t.startsWith('category:')) {
                    const c = t.slice(9);
                    cats[c] = (cats[c] || 0) + 1;
                }
            }
        }
        fileCount = Object.keys(semantic).length;
    } else if (existsSync(memesDir)) {
        // 纯目录分类包：每个一级子目录就是一个分类
        for (const name of readdirSync(memesDir)) {
            const sub = join(memesDir, name);
            let st;
            try { st = statSync(sub); } catch { continue; }
            if (!st.isDirectory()) { fileCount += 1; continue; }

            let n = 0;
            const walk = (d) => {
                for (const f of readdirSync(d)) {
                    const full = join(d, f);
                    const s2 = statSync(full);
                    if (s2.isDirectory()) walk(full);
                    else n += 1;
                }
            };
            walk(sub);
            fileCount += n;
            if (n) cats[name] = n;
        }
    }

    const entry = {
        id: packId,
        name: manifest.name || packId,
        description: manifest.description || '',
        source: manifest.homepage || '',
        license: manifest.license || '',
        image_count: fileCount,
        categories: cats,
        has_semantic: hasSemantic,
        path: dest,
        installed_at: new Date().toISOString(),
    };

    const idx = loadIndex();
    idx.packs = idx.packs.filter((p) => p.id !== packId);
    idx.packs.push(entry);
    idx.packs.sort((a, b) => (a.id < b.id ? -1 : 1));
    saveIndex(idx);

    // 清掉文件哈希缓存 —— 换了内容，旧的 sha 索引已经不对了
    const fi = join(dest, 'file_index.json');
    if (existsSync(fi)) rmSync(fi, { force: true });

    return entry;
}

/** 从社区索引装一个包。 */
export async function installCommunity(packId, { overwrite = false } = {}) {
    const data = await fetchCommunity();
    const pack = data.packs.find((p) => p.id === packId);
    if (!pack) throw new Error(`社区索引里没有 ${packId}`);

    const src = pack.source || pack.repo || {};
    const repo = src.repo;
    const ref = src.ref || 'main';
    if (!repo) throw new Error(`${packId} 在索引里没有 repo 地址`);

    const { dir, zip, out } = await downloadAndExtract(repo, ref);
    try {
        const sub = src.subpath && src.subpath !== '.' ? join(dir, src.subpath) : dir;
        return installFromDir(sub, packId, overwrite);
    } finally {
        // 清临时文件，别把磁盘堆满
        for (const p of [out, zip]) {
            try {
                if (existsSync(p)) rmSync(p, { recursive: true, force: true });
            } catch { /* 清不掉不影响主流程 */ }
        }
    }
}

/** 从任意 GitHub 仓库装（索引里没有的包）。 */
export async function installFromRepo(repo, { ref = 'main', packId = null, overwrite = false } = {}) {
    const { dir, zip, out } = await downloadAndExtract(repo, ref);
    try {
        const id = packId || basename(dir).replace(/-\d+\.\d+\.\d+$/, '') || basename(dir);
        return installFromDir(dir, id, overwrite);
    } finally {
        for (const p of [out, zip]) {
            try {
                if (existsSync(p)) rmSync(p, { recursive: true, force: true });
            } catch { /* 同上 */ }
        }
    }
}

/** 卸载一个包。 */
export function uninstall(packId, { deleteFiles = true } = {}) {
    const idx = loadIndex();
    const before = idx.packs.length;
    idx.packs = idx.packs.filter((p) => p.id !== packId);
    if (idx.packs.length === before) return { removed: false };
    saveIndex(idx);

    if (deleteFiles) {
        const dir = join(PACKS_DIR, packId);
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    return { removed: true, files_deleted: deleteFiles };
}

/** 更新一个已装的包（重装最新版）。 */
export async function update(packId) {
    return installCommunity(packId, { overwrite: true });
}

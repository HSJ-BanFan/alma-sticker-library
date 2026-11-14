/**
 * 表情库共用工具：路径、JSON、哈希、文件遍历、zip。
 *
 * 设计约束：
 * - 只依赖 Node 内置模块，插件不引第三方依赖。
 * - 所有落盘 JSON 用 UTF-8，缩进 2 空格，便于用户直接看。
 * - 所有路径先归一化再校验，图片读写只能落在包自己的 memes 目录内。
 */

import { createHash } from 'node:crypto';
import {
    closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
    renameSync, statSync, writeFileSync, writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

// ALMA_STICKERS_ROOT 是测试钩子，只用于把整套读写指向临时目录。
export const ROOT = process.env.ALMA_STICKERS_ROOT || join(homedir(), '.config', 'alma', 'stickers');
export const PACKS_DIR = join(ROOT, 'packs');
export const TMP_DIR = join(ROOT, '_tmp');
export const INDEX_PATH = join(ROOT, 'index.json');
export const SETTINGS_PATH = join(ROOT, 'settings.json');
export const RULES_PATH = join(ROOT, 'rules.json');

export const IMAGE_EXTS = new Set(['.gif', '.jpg', '.jpeg', '.png', '.webp', '.bmp', '.avif']);
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const MIME = {
    '.gif': 'image/gif',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.avif': 'image/avif',
};

export function nowIso() {
    return new Date().toISOString();
}

export function ensureDir(dir) {
    mkdirSync(dir, { recursive: true });
    return dir;
}

export function readJson(path, fallback = null) {
    try {
        if (!existsSync(path)) return fallback;
        let text = readFileSync(path, 'utf8');
        // 有些包的 manifest.json 带 UTF-8 BOM，JSON.parse 会直接抛错。
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        return JSON.parse(text);
    } catch {
        return fallback;
    }
}

export function writeJson(path, data) {
    ensureDir(dirname(path));
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export function writeJsonAtomic(path, data) {
    ensureDir(dirname(path));
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    try {
        renameSync(tmp, path);
    } catch {
        writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    }
}

export function sha256(input) {
    return createHash('sha256').update(input).digest('hex');
}

export function fileSha256(path) {
    return sha256(readFileSync(path));
}

export function isImage(name) {
    return IMAGE_EXTS.has(extname(name).toLowerCase());
}

export function listDir(path, { dirs = false, files = false } = {}) {
    try {
        const out = [];
        for (const name of readdirSync(path)) {
            let st;
            try {
                st = statSync(join(path, name));
            } catch {
                continue;
            }
            if (st.isDirectory() && dirs) out.push(name);
            if (st.isFile() && files) out.push(name);
        }
        out.sort((a, b) => a.localeCompare(b, 'zh-CN'));
        return out;
    } catch {
        return [];
    }
}

export function listCategoryDirs(memesDir) {
    return listDir(memesDir, { dirs: true });
}

export function listCategoryImages(memesDir, category) {
    return listDir(join(memesDir, category), { files: true }).filter(isImage);
}

export function countImages(memesDir) {
    let total = 0;
    for (const cat of listCategoryDirs(memesDir)) total += listCategoryImages(memesDir, cat).length;
    return total;
}

/** 把相对路径安全地拼到 base 下；越界返回 null。 */
export function safeJoin(base, ...parts) {
    const root = resolve(base);
    const full = resolve(root, ...parts);
    if (full === root) return full;
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
    return full.startsWith(prefix) ? full : null;
}

export function isSafeName(value) {
    const name = String(value || '').trim();
    return Boolean(
        name
        && name !== '.'
        && name !== '..'
        && basename(name) === name
        && !name.includes('/')
        && !name.includes('\\'),
    );
}

export function assertSafeCategory(category) {
    const name = String(category || '').trim();
    if (!isSafeName(name) || name.startsWith('.')) throw new Error(`分类名称非法: ${category}`);
    return name;
}

export function relPath(base, full) {
    return relative(base, full).split(sep).join('/');
}

export function contentType(path) {
    return MIME[extname(path).toLowerCase()] || 'application/octet-stream';
}

/** 读文件并转 data URL；超过上限返回空串，由调用方决定错误文案。 */
export function fileDataUrl(path, maxBytes = 32 * 1024 * 1024) {
    const st = statSync(path);
    if (st.size > maxBytes) return '';
    return `data:${contentType(path)};base64,${readFileSync(path).toString('base64')}`;
}

// ------------------------------------------------------------------ zip 读取
/**
 * 最小 zip 解压：只支持 store(0) / deflate(8)。
 * GitHub archive 与常见表情包都是这两种压缩方式。
 */
export function extractZip(zipPath, destDir) {
    ensureDir(destDir);
    const fd = openSync(zipPath, 'r');
    try {
        const size = fstatSync(fd).size;
        // 末尾最多 64KB 里找 EOCD，避免整包读进内存。
        const tailLen = Math.min(size, 65558);
        const tail = readRangeSync(fd, size - tailLen, tailLen);
        let eocd = -1;
        for (let i = tail.length - 22; i >= 0; i -= 1) {
            if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) throw new Error('不是有效的 zip 文件');

        const count = tail.readUInt16LE(eocd + 10);
        const centralSize = tail.readUInt32LE(eocd + 12);
        const centralStart = tail.readUInt32LE(eocd + 16);
        if (count === 0xFFFF || centralSize === 0xFFFFFFFF || centralStart === 0xFFFFFFFF) {
            throw new Error('暂不支持 Zip64 压缩包（超过 4GB 或 65535 个文件）');
        }
        const central = readRangeSync(fd, centralStart, centralSize);
        let ptr = 0;

        for (let n = 0; n < count; n += 1) {
            if (ptr + 46 > central.length || central.readUInt32LE(ptr) !== 0x02014b50) break;
            const method = central.readUInt16LE(ptr + 10);
            const compSize = central.readUInt32LE(ptr + 20);
            const nameLen = central.readUInt16LE(ptr + 28);
            const extraLen = central.readUInt16LE(ptr + 30);
            const commentLen = central.readUInt16LE(ptr + 32);
            const localOff = central.readUInt32LE(ptr + 42);
            const name = central.toString('utf8', ptr + 46, ptr + 46 + nameLen);
            ptr += 46 + nameLen + extraLen + commentLen;

            if (name.includes('..') || name.startsWith('/')) continue;
            if (name.endsWith('/')) {
                // 保留空目录，导出/导入后分类不会凭空消失。
                const dir = safeJoin(destDir, name.replace(/\/+$/, ''));
                if (dir) ensureDir(dir);
                continue;
            }
            const localHeader = readRangeSync(fd, localOff, 30);
            if (localHeader.readUInt32LE(0) !== 0x04034b50) continue;
            const lNameLen = localHeader.readUInt16LE(26);
            const lExtraLen = localHeader.readUInt16LE(28);
            const dataStart = localOff + 30 + lNameLen + lExtraLen;

            const target = safeJoin(destDir, name);
            if (!target) continue;
            ensureDir(dirname(target));

            if (method === 0) {
                // store：分块复制，大图不占内存。
                const out = openSync(target, 'w');
                try {
                    copyRangeSync(fd, out, dataStart, compSize);
                } finally {
                    closeSync(out);
                }
            } else if (method === 8) {
                const raw = readRangeSync(fd, dataStart, compSize);
                let content;
                try {
                    // 限制单条目解压后的体积，避免压缩炸弹把内存吃光。
                    content = inflateRawSync(raw, { maxOutputLength: 512 * 1024 * 1024 });
                } catch (err) {
                    throw new Error(`解压失败（条目过大或已损坏）：${name}`);
                }
                writeFileSync(target, content);
            }
        }
    } finally {
        closeSync(fd);
    }
}

/** 从指定位置读一小段；用于 zip 头与中央目录。 */
function readRangeSync(fd, start, length) {
    const buf = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
        const n = readSync(fd, buf, done, length - done, start + done);
        if (n <= 0) throw new Error('读取 zip 失败：文件被截断');
        done += n;
    }
    return buf;
}

/** 分块复制一段区间，内存占用固定。 */
function copyRangeSync(inFd, outFd, start, length, onChunk = null) {
    const chunk = Buffer.allocUnsafe(1 << 20);
    let pos = 0;
    while (pos < length) {
        const n = readSync(inFd, chunk, 0, Math.min(chunk.length, length - pos), start + pos);
        if (n <= 0) throw new Error('读取 zip 失败：文件被截断');
        const part = chunk.subarray(0, n);
        if (onChunk) onChunk(part);
        let written = 0;
        while (written < n) written += writeSync(outFd, part, written, n - written);
        pos += n;
    }
}

// ------------------------------------------------------------------ zip 写入
/**
 * 生成 store-only zip。支持 {name, data} 与 {name, file} 两种条目；
 * file 条目分块读取写入，大表情包不会把整包读进内存。
 */
export function createZip(entries, outPath) {
    ensureDir(dirname(outPath));
    // 先做 Zip64 上限检查，避免写到一半才发现溢出，留下坏包。
    if (entries.length >= 0xFFFF) {
        throw new Error('文件数量超过 65534，暂不支持 Zip64 导出');
    }
    let planned = 0;
    for (const entry of entries) {
        const nameLen = Buffer.byteLength(String(entry.name).replace(/\\/g, '/'), 'utf8');
        const size = entry.file
            ? statSync(entry.file).size
            : Buffer.isBuffer(entry.data) ? entry.data.length : Buffer.byteLength(String(entry.data || ''));
        if (size >= 0xFFFFFFFF) throw new Error(`单个文件超过 4GB，暂不支持 Zip64 导出：${entry.name}`);
        planned += size + nameLen * 2 + 112;
    }
    if (planned >= 0xFFFFFFFF) throw new Error('导出内容超过 4GB，暂不支持 Zip64 导出');
    const centralParts = [];
    const dosTime = 0;
    const dosDate = 0x21; // 1980-01-01
    let offset = 0;
    const fd = openSync(outPath, 'w');
    try {
        for (const entry of entries) {
            const nameBuf = Buffer.from(String(entry.name).replace(/\\/g, '/'), 'utf8');
            const localStart = offset;
            const local = Buffer.alloc(30);
            local.writeUInt32LE(0x04034b50, 0);
            local.writeUInt16LE(20, 4);
            // bit 3：CRC 与大小写在数据之后的 descriptor 里，便于流式写入。
            local.writeUInt16LE(0x0808, 6);
            local.writeUInt16LE(0, 8);
            local.writeUInt16LE(dosTime, 10);
            local.writeUInt16LE(dosDate, 12);
            local.writeUInt32LE(0, 14);
            local.writeUInt32LE(0, 18);
            local.writeUInt32LE(0, 22);
            local.writeUInt16LE(nameBuf.length, 26);
            local.writeUInt16LE(0, 28);
            writeAll(fd, local);
            writeAll(fd, nameBuf);
            offset += local.length + nameBuf.length;

            let crc = 0xFFFFFFFF;
            let size = 0;
            if (entry.file) {
                const inFd = openSync(entry.file, 'r');
                try {
                    const total = fstatSync(inFd).size;
                    copyRangeSync(inFd, fd, 0, total, (chunk) => {
                        crc = crc32Update(crc, chunk);
                        size += chunk.length;
                    });
                } finally {
                    closeSync(inFd);
                }
            } else {
                const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '');
                crc = crc32Update(crc, data);
                writeAll(fd, data);
                size = data.length;
            }
            crc = (crc ^ 0xFFFFFFFF) >>> 0;

            const descriptor = Buffer.alloc(16);
            descriptor.writeUInt32LE(0x08074b50, 0);
            descriptor.writeUInt32LE(crc, 4);
            descriptor.writeUInt32LE(size, 8);
            descriptor.writeUInt32LE(size, 12);
            writeAll(fd, descriptor);
            offset += size + descriptor.length;

            const central = Buffer.alloc(46);
            central.writeUInt32LE(0x02014b50, 0);
            central.writeUInt16LE(20, 4);
            central.writeUInt16LE(20, 6);
            central.writeUInt16LE(0x0808, 8);
            central.writeUInt16LE(0, 10);
            central.writeUInt16LE(dosTime, 12);
            central.writeUInt16LE(dosDate, 14);
            central.writeUInt32LE(crc, 16);
            central.writeUInt32LE(size, 20);
            central.writeUInt32LE(size, 24);
            central.writeUInt16LE(nameBuf.length, 28);
            central.writeUInt16LE(0, 30);
            central.writeUInt16LE(0, 32);
            central.writeUInt16LE(0, 34);
            central.writeUInt16LE(0, 36);
            central.writeUInt32LE(0, 38);
            central.writeUInt32LE(localStart, 42);
            centralParts.push(central, nameBuf);
        }

        const centralStart = offset;
        const centralBuf = Buffer.concat(centralParts);
        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(0x06054b50, 0);
        eocd.writeUInt16LE(0, 4);
        eocd.writeUInt16LE(0, 6);
        eocd.writeUInt16LE(entries.length, 8);
        eocd.writeUInt16LE(entries.length, 10);
        eocd.writeUInt32LE(centralBuf.length, 12);
        eocd.writeUInt32LE(centralStart, 16);
        eocd.writeUInt16LE(0, 20);
        writeAll(fd, centralBuf);
        writeAll(fd, eocd);
    } finally {
        closeSync(fd);
    }
    return outPath;
}

function writeAll(fd, buf) {
    let written = 0;
    while (written < buf.length) written += writeSync(fd, buf, written, buf.length - written);
}

let crcTable = null;

/** 可增量使用的 CRC32：传入上一次的中间值，返回新的中间值。 */
export function crc32Update(crc, buf) {
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let i = 0; i < 256; i += 1) {
            let c = i;
            for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            crcTable[i] = c >>> 0;
        }
    }
    let out = crc;
    for (const byte of buf) out = crcTable[(out ^ byte) & 0xFF] ^ (out >>> 8);
    return out;
}

// ------------------------------------------------------------------ 文本
/** 中文单字 + 双字组，英文/数字按词。与旧版检索保持一致。 */
export function tokenize(text) {
    const tokens = new Set();
    if (!text) return tokens;
    const re = /[一-鿿]+|[A-Za-z0-9]+/g;
    let m;
    while ((m = re.exec(String(text))) !== null) {
        const chunk = m[0];
        const code = chunk.charCodeAt(0);
        if (code >= 0x4e00 && code <= 0x9fff) {
            for (const ch of chunk) tokens.add(ch);
            for (let i = 0; i < chunk.length - 1; i += 1) tokens.add(chunk.slice(i, i + 2));
        } else {
            tokens.add(chunk.toLowerCase());
        }
    }
    return tokens;
}

export function slugify(value, fallback = 'pack') {
    const out = String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
    return out || fallback;
}

export function absPath(value) {
    return isAbsolute(value) ? value : resolve(value);
}

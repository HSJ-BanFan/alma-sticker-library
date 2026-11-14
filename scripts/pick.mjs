#!/usr/bin/env node
/**
 * 一次调用选图：优先问本地 HTTP 服务，服务不在时退回进程内检索。
 */

const USAGE = 'Usage: node scripts/pick.mjs --query "想表达的态度" [--top 3] [--pack id] [--category c] [--pretty] [--file-only]';
const SERVER_URL = 'http://127.0.0.1:8899/api/pick';
const SERVER_TIMEOUT = 1200;
const LIB_VERSION = '0.3.1-7';

function fail(message) {
    if (message) process.stderr.write(`pick: ${message}\n`);
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
}

function note(message) {
    process.stderr.write(`pick: ${message}\n`);
}

function text(value) {
    if (value === null || value === undefined) return '';
    return typeof value === 'string' ? value : String(value);
}

function count(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
}

function readArgs(argv) {
    const options = {
        query: '',
        top: 3,
        pack: '',
        category: '',
        pretty: false,
        fileOnly: false,
        help: false,
    };
    const valueOptions = new Set(['--query', '--top', '--pack', '--category']);
    for (let index = 0; index < argv.length; index += 1) {
        const raw = argv[index];
        if (raw === '--pretty') {
            options.pretty = true;
            continue;
        }
        if (raw === '--file-only') {
            options.fileOnly = true;
            continue;
        }
        if (raw === '--help' || raw === '-h') {
            options.help = true;
            continue;
        }
        let key = raw;
        let value;
        const equal = raw.indexOf('=');
        if (raw.startsWith('--') && equal > 2) {
            key = raw.slice(0, equal);
            value = raw.slice(equal + 1);
        }
        if (!valueOptions.has(key)) return { error: `未知参数 ${raw}` };
        if (value === undefined) {
            index += 1;
            value = argv[index];
            if (value === undefined || value.startsWith('--')) {
                return { error: `缺少 ${key} 的值` };
            }
        }
        if (key === '--query') options.query = value;
        else if (key === '--pack') options.pack = value;
        else if (key === '--category') options.category = value;
        else {
            const top = Number(value);
            if (!Number.isInteger(top) || top < 1) {
                return { error: '--top 必须是正整数' };
            }
            options.top = top;
        }
    }
    if (options.help) return { options };
    if (!options.query.trim()) return { error: '缺少 --query' };
    return { options };
}

function serverUrl(options) {
    const url = new URL(SERVER_URL);
    url.searchParams.set('q', options.query);
    url.searchParams.set('top', String(options.top));
    if (options.pack) url.searchParams.set('pack', options.pack);
    if (options.category) url.searchParams.set('category', options.category);
    return url;
}

async function fromServer(options) {
    if (typeof fetch !== 'function') {
        return { data: null, reason: '当前 Node 没有 fetch' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SERVER_TIMEOUT);
    try {
        const response = await fetch(serverUrl(options), {
            headers: { accept: 'application/json' },
            signal: controller.signal,
        });
        if (!response.ok) {
            return { data: null, reason: `本地服务返回 HTTP ${response.status}` };
        }
        let data;
        try {
            data = JSON.parse(await response.text());
        } catch {
            return { data: null, reason: '本地服务返回的不是 JSON' };
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            return { data: null, reason: '本地服务返回格式不正确' };
        }
        return { data, reason: '' };
    } catch (error) {
        const reason = error?.name === 'AbortError'
            ? '本地服务超时'
            : error?.message || '本地服务不可用';
        return { data: null, reason };
    } finally {
        clearTimeout(timer);
    }
}

function normalizeIndex(status) {
    const raw = status?.vector_index;
    if (raw && typeof raw === 'object') {
        return {
            state: text(raw.state) || 'missing',
            model: text(raw.model),
            dims: count(raw.dims),
            rows: count(raw.rows),
            captioned_total: count(raw.captioned_total),
            built_at: text(raw.built_at),
            progress: raw.progress ?? null,
            error: text(raw.error),
            reason: text(raw.reason),
        };
    }
    return {
        state: 'unavailable',
        model: '',
        dims: 0,
        rows: 0,
        captioned_total: 0,
        built_at: '',
        progress: null,
        error: '',
        reason: '当前进程没有提供向量索引状态',
    };
}

async function readIndex(semantic, packId) {
    if (!packId) return normalizeIndex(null);
    try {
        return normalizeIndex(await semantic.status(packId));
    } catch (error) {
        const message = error?.message || String(error);
        note(`读取索引状态失败：${message}`);
        return normalizeIndex({ vector_index: { state: 'unavailable', reason: message } });
    }
}

function normalizePick(item) {
    const categories = Array.isArray(item?.categories)
        ? item.categories.map(text).filter(Boolean)
        : item?.category
            ? [text(item.category)]
            : [];
    const score = Number(item?.score);
    return {
        id: text(item?.id),
        pack: text(item?.pack),
        file: text(item?.file),
        caption: text(item?.caption),
        visible_text: text(item?.visible_text),
        categories,
        score: Number.isFinite(score) ? score : 0,
        retrieval: item?.retrieval === 'vector' ? 'vector' : 'tokens',
    };
}

function modeOf(result, picks) {
    const explicit = text(result?.mode);
    if (['vector', 'tokens', 'mixed'].includes(explicit)) return explicit;
    const kinds = new Set(picks.map((pick) => pick.retrieval).filter(Boolean));
    if (kinds.has('vector') && kinds.has('tokens')) return 'mixed';
    return kinds.has('vector') ? 'vector' : 'tokens';
}

async function fromLocal(options) {
    const [{ hybridSearch, retrievalPackIds }, semantic, settings] = await Promise.all([
        import(`../lib/search.js?v=${LIB_VERSION}`),
        import(`../lib/semantic.js?v=${LIB_VERSION}`),
        import(`../lib/settings.js?v=${LIB_VERSION}`),
    ]);
    let packIds = options.pack
        ? [options.pack]
        : retrievalPackIds(settings.resolvePackIds({}));
    packIds = (Array.isArray(packIds) ? packIds : [])
        .map(text)
        .filter(Boolean);
    if (!packIds.length) packIds = retrievalPackIds();
    const index = await readIndex(semantic, packIds[0] || '');
    if (!packIds.length) {
        return {
            found: false,
            query: options.query,
            mode: 'tokens',
            index,
            picks: [],
        };
    }
    let result;
    try {
        result = await hybridSearch(packIds, options.query, {
            semantic,
            topK: options.top,
            category: options.category || null,
            minScore: 0.02,
        });
    } catch (error) {
        note(`进程内检索失败：${error?.message || error}`);
        return {
            found: false,
            query: options.query,
            mode: 'tokens',
            index,
            picks: [],
        };
    }
    const rawPicks = Array.isArray(result)
        ? result
        : Array.isArray(result?.picks)
            ? result.picks
            : [];
    const picks = rawPicks.map(normalizePick);
    return {
        found: picks.length > 0,
        query: options.query,
        mode: modeOf(result, picks),
        index,
        picks,
    };
}

function output(options, data) {
    if (options.fileOnly) {
        const file = text(data?.picks?.[0]?.file);
        if (file) process.stdout.write(`${file}\n`);
        return;
    }
    process.stdout.write(`${JSON.stringify(data, null, options.pretty ? 2 : 0)}\n`);
}

const parsed = readArgs(process.argv.slice(2));
if (parsed.error) {
    fail(parsed.error);
} else if (parsed.options.help) {
    process.stdout.write(`${USAGE}\n`);
} else if (parsed.options) {
    const server = await fromServer(parsed.options);
    let data = server.data;
    if (!data) {
        note(`${server.reason}，改用进程内检索。`);
        try {
            data = await fromLocal(parsed.options);
        } catch (error) {
            process.stderr.write(`pick: 进程内检索失败：${error?.message || error}\n`);
            process.exitCode = 1;
        }
    }
    if (data) output(parsed.options, data);
}

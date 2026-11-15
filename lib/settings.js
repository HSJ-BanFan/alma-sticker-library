/**
 * 配置与使用规则。
 *
 * 配置 schema 只公开 Alma 版实际支持的设置。
 * 已保存的旧版字段保留在数据文件中，不再作为可用功能展示。
 * 值存放在 ~/.config/alma/stickers/settings.json，与图包数据同目录。
 */

import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    INDEX_PATH, RULES_PATH, SETTINGS_PATH, readJson, sha256, writeJsonAtomic,
} from './util.js?v=0.3.2-1';

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SCHEMA_PATH = join(PLUGIN_DIR, 'settings.schema.json');

const SECRET_KEYS = new Set([
    'key', 'secret', 'password', 'token', 'access_key_id', 'secret_access_key',
]);

let schemaCache = null;
let valuesCache = null;
let valuesMtime = 0;

export function loadSchema() {
    if (!schemaCache) schemaCache = readJson(SCHEMA_PATH, {});
    return schemaCache;
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

export function schemaDefaults(schema = loadSchema()) {
    const out = {};
    for (const [key, spec] of Object.entries(schema || {})) {
        if (!spec || typeof spec !== 'object') continue;
        if (spec.type === 'object') out[key] = schemaDefaults(spec.items || {});
        else out[key] = clone(spec.default ?? defaultFor(spec.type));
    }
    return out;
}

function defaultFor(type) {
    if (type === 'bool') return false;
    if (type === 'int' || type === 'float') return 0;
    if (type === 'list') return [];
    return '';
}

export function loadValues({ refresh = false } = {}) {
    let mtime = 0;
    try {
        mtime = existsSync(SETTINGS_PATH) ? statSync(SETTINGS_PATH).mtimeMs : 0;
    } catch {
        mtime = 0;
    }
    if (!refresh && valuesCache && mtime === valuesMtime) return valuesCache;
    const saved = readJson(SETTINGS_PATH, {}) || {};
    const merged = deepMerge(schemaDefaults(), saved);
    valuesCache = merged;
    valuesMtime = mtime;
    return merged;
}

export function deepMerge(base, patch) {
    const out = clone(base);
    if (!patch || typeof patch !== 'object') return out;
    for (const [key, value] of Object.entries(patch)) {
        if (value && typeof value === 'object' && !Array.isArray(value)
            && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
            out[key] = deepMerge(out[key], value);
        } else {
            out[key] = clone(value);
        }
    }
    return out;
}

export function getSetting(path, fallback = undefined) {
    const values = loadValues();
    let node = values;
    for (const key of String(path).split('.')) {
        if (!node || typeof node !== 'object' || !(key in node)) return fallback;
        node = node[key];
    }
    return node === undefined ? fallback : node;
}

export function setSetting(path, value) {
    const values = loadValues({ refresh: true });
    const keys = String(path).split('.');
    let node = values;
    for (const key of keys.slice(0, -1)) {
        if (!node[key] || typeof node[key] !== 'object') node[key] = {};
        node = node[key];
    }
    node[keys[keys.length - 1]] = value;
    writeJsonAtomic(SETTINGS_PATH, values);
    valuesCache = values;
    return values;
}

// ------------------------------------------------------------------ 描述
/** 把 schema 摊平成设置中心直接可渲染的字段列表。 */
export function flattenSchema(schema = loadSchema(), values = loadValues()) {
    const fields = [];
    const walk = (items, prefix, current, groups) => {
        for (const [key, spec] of Object.entries(items || {})) {
            if (!spec || typeof spec !== 'object') continue;
            const path = [...prefix, key];
            const label = String(spec.description || key);
            if (spec.type === 'object') {
                walk(spec.items || {}, path, current?.[key], [...groups, label]);
                continue;
            }
            const type = spec.type || 'string';
            const secret = SECRET_KEYS.has(key);
            const raw = current?.[key];
            const value = raw === undefined ? clone(spec.default ?? defaultFor(type)) : raw;
            fields.push({
                path: path.join('.'),
                label,
                groups,
                type,
                hint: String(spec.hint || ''),
                default: secret ? '' : clone(spec.default ?? defaultFor(type)),
                value: secret ? '' : clone(value),
                secret,
                configured: secret ? Boolean(value) : false,
                options: spec.options || [],
                special: spec._special || '',
                bounds: spec.slider || {},
                condition: spec.condition || null,
                editor_mode: Boolean(spec.editor_mode),
                editor_language: spec.editor_language || '',
            });
        }
    };
    walk(schema, [], values, []);
    return fields;
}

function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

export function revisionOf(values = loadValues()) {
    return sha256(stableStringify(values));
}

export function describeSettings(extra = {}) {
    const values = loadValues({ refresh: true });
    return {
        revision: revisionOf(values),
        fields: flattenSchema(loadSchema(), values),
        ...extra,
    };
}

// ------------------------------------------------------------------ 保存
function childSchema(path) {
    const parts = String(path).split('.');
    let spec = { type: 'object', items: loadSchema() };
    for (const part of parts) {
        if (!spec || spec.type !== 'object' || !spec.items) return null;
        spec = spec.items[part];
        if (!spec) return null;
    }
    return spec;
}

function validateField(path, value) {
    const spec = childSchema(path);
    if (!spec) throw new Error(`包含未知配置项: ${path}`);
    const type = spec.type || 'string';
    const label = spec.description || path;
    if (type === 'bool' && typeof value !== 'boolean') throw new Error(`「${label}」必须是布尔值`);
    if (type === 'int' && (!Number.isInteger(value))) throw new Error(`「${label}」必须是整数`);
    if (type === 'float' && (typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error(`「${label}」必须是数字`);
    }
    if ((type === 'string' || type === 'text') && typeof value !== 'string') {
        throw new Error(`「${label}」必须是文本`);
    }
    if (type === 'list' && (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))) {
        throw new Error(`「${label}」必须是字符串列表`);
    }
    if (Array.isArray(spec.options) && spec.options.length && !spec.options.includes(value)) {
        throw new Error(`「${label}」的取值不在允许范围内`);
    }
    const bounds = spec.slider || {};
    if ((type === 'int' || type === 'float') && bounds) {
        if (Number.isFinite(bounds.min) && value < bounds.min) throw new Error(`「${label}」不能小于 ${bounds.min}`);
        if (Number.isFinite(bounds.max) && value > bounds.max) throw new Error(`「${label}」不能大于 ${bounds.max}`);
    }
    if (path === 'generation.message.content_cleanup_rule' && value) {
        try {
            new RegExp(value);
        } catch {
            throw new Error('内容过滤正则表达式无效');
        }
    }
    return value;
}

export function applyChanges({ revision, changes }) {
    const current = loadValues({ refresh: true });
    const currentRevision = revisionOf(current);
    if (revision && revision !== currentRevision) {
        const err = new Error('配置已在其他页面更新。请重新加载后再保存，避免覆盖新的设置。');
        err.code = 'revision_conflict';
        throw err;
    }
    if (!changes || typeof changes !== 'object' || !Object.keys(changes).length) {
        throw new Error('没有需要保存的配置更改。');
    }
    const next = clone(current);
    for (const [path, rawValue] of Object.entries(changes)) {
        const spec = childSchema(path);
        if (!spec) throw new Error(`包含未知配置项: ${path}`);
        let value = rawValue;
        if (SECRET_KEYS.has(String(path).split('.').pop()) && value === '') {
            // 留空表示保留已保存的密钥，避免用户为改别的项而重填密钥。
            continue;
        }
        value = validateField(path, value);
        const keys = String(path).split('.');
        let node = next;
        for (const key of keys.slice(0, -1)) {
            if (!node[key] || typeof node[key] !== 'object') node[key] = {};
            node = node[key];
        }
        node[keys[keys.length - 1]] = value;
    }
    writeJsonAtomic(SETTINGS_PATH, next);
    valuesCache = next;
    return { revision: revisionOf(next), values: next };
}

// ------------------------------------------------------------------ 使用规则
export function loadRules() {
    const data = readJson(RULES_PATH, null);
    if (data && Array.isArray(data.rules)) return data;
    return { schema_version: 1, rules: [] };
}

export function defaultPackId() {
    const data = loadRules();
    const rule = data.rules.find((item) => item?.scope === 'default');
    if (rule) {
        const ids = normalizePackIds(rule);
        if (ids.length) return ids[0];
    }
    const registry = readJson(INDEX_PATH, { packs: [] });
    return registry.packs?.[0]?.id || '';
}

export function normalizePackIds(rule) {
    const raw = Array.isArray(rule?.pack_ids) ? rule.pack_ids : [rule?.pack_id];
    return [...new Set(raw.map((id) => String(id || '').trim()).filter(Boolean))];
}

export function getRules() {
    const data = loadRules();
    return {
        schema_version: 1,
        rules: data.rules,
        default_pack_id: defaultPackId(),
    };
}

export function validateRules(rules, availablePackIds) {
    if (!Array.isArray(rules) || !rules.length) throw new Error('rules 不能为空');
    const out = [];
    let defaultCount = 0;
    const seenTargets = new Set();
    const seenIds = new Set();
    rules.forEach((rule, index) => {
        if (!rule || typeof rule !== 'object') throw new Error(`第 ${index + 1} 条规则格式无效`);
        const id = String(rule.id || '').trim();
        const scope = String(rule.scope || '').trim().toLowerCase();
        const ids = normalizePackIds(rule);
        const target = String(rule.target || '').trim();
        if (!id) throw new Error(`第 ${index + 1} 条规则缺少 id`);
        if (seenIds.has(id)) throw new Error(`规则 id 不能重复: ${id}`);
        seenIds.add(id);
        if (!['persona', 'session', 'default'].includes(scope)) {
            throw new Error(`第 ${index + 1} 条规则 scope 非法`);
        }
        if (!ids.length) throw new Error(`第 ${index + 1} 条规则缺少 pack_id`);
        for (const packId of ids) {
            if (!availablePackIds.has(packId)) {
                throw new Error(`第 ${index + 1} 条规则引用的 pack 不存在: ${packId}`);
            }
        }
        const normalized = {
            id,
            scope,
            pack_id: ids[0],
            pack_ids: ids,
        };
        if (scope !== 'default') {
            if (!target) throw new Error(`第 ${index + 1} 条规则缺少 target`);
            const key = `${scope}:${target}`;
            if (seenTargets.has(key)) throw new Error(`第 ${index + 1} 条规则与前序规则冲突: ${scope} 目标 ${target} 重复`);
            seenTargets.add(key);
            normalized.target = target;
        } else {
            defaultCount += 1;
        }
        out.push(normalized);
    });
    if (defaultCount !== 1) throw new Error('必须且仅能存在一条 default 规则');
    if (out[out.length - 1].scope !== 'default') throw new Error('default 规则必须位于最后');
    return out;
}

export function saveRules(rules, availablePackIds) {
    const normalized = validateRules(rules, availablePackIds);
    writeJsonAtomic(RULES_PATH, { schema_version: 1, rules: normalized });
    return getRules();
}

/** 没有规则时，用第一个包生成默认规则，保证工具可用。 */
export function ensureDefaultRule(packIds) {
    const data = loadRules();
    if (data.rules.length) return data;
    const first = packIds?.[0];
    if (!first) return data;
    const rules = [{
        id: 'default',
        scope: 'default',
        pack_id: first,
        pack_ids: [first],
    }];
    writeJsonAtomic(RULES_PATH, { schema_version: 1, rules });
    return loadRules();
}

/** 按 thread/persona 选包；调用方提供匹配函数。 */
export function resolvePackIds({ threadId = '', personaId = '' } = {}) {
    const { rules } = loadRules();
    for (const rule of rules) {
        if (rule.scope === 'session' && rule.target === threadId) return normalizePackIds(rule);
        if (rule.scope === 'persona' && rule.target === personaId) return normalizePackIds(rule);
    }
    const fallback = rules.find((rule) => rule.scope === 'default');
    return fallback ? normalizePackIds(fallback) : [];
}

#!/usr/bin/env node
/**
 * 重建所有已装包的向量索引（Alma 不在运行时也能用）。
 *
 *   node scripts/rebuild-index.mjs            # 全部
 *   node scripts/rebuild-index.mjs kipfel ... # 指定包
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(homedir(), '.config', 'alma', 'stickers');
const { buildIndex, indexStatus } = await import('../lib/index-job.js');

function installed() {
    const registry = JSON.parse(readFileSync(join(ROOT, 'index.json'), 'utf8'));
    return (Array.isArray(registry.packs) ? registry.packs : []).map((pack) => String(pack.id));
}

const wanted = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
const ids = wanted.length ? wanted : installed();

for (const id of ids) {
    const started = Date.now();
    const result = await buildIndex(id, { force: true });
    const status = indexStatus(id);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`${id.padEnd(28)} ${status.state.padEnd(8)} rows=${String(status.rows).padStart(4)} ${seconds}s`
        + (result?.error ? ` error=${result.error}` : ''));
}

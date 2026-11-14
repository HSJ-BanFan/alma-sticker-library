#!/usr/bin/env node
/**
 * Alma 的插件宿主只给入口模块加了缓存参数：
 *   await import(`${entryUrl}?t=${Date.now()}`)
 * 入口里的静态 import 没有参数，所以子模块会被 Electron 主进程按路径永久缓存。
 * 改完代码后运行本脚本，给所有相对 import 统一换一个新的 `?v=` 版本号，
 * 再 disable/enable 插件（或 POST /api/plugins/refresh），新代码才会生效。
 *
 * 用法：
 *   node scripts/bump-cache.mjs            # 用时间戳生成新版本号
 *   node scripts/bump-cache.mjs 0.3.0-7    # 指定版本号
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const version = process.argv[2] || Date.now().toString(36);

function collect(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) {
            if (name === 'webui' || name === 'node_modules' || name.startsWith('.')) continue;
            out.push(...collect(full));
        } else if (name.endsWith('.js')) {
            out.push(full);
        }
    }
    return out;
}

let files = 0;
let specifiers = 0;
const pattern = /(from\s+['"])(\.{1,2}\/[^'"?]+\.js)(?:\?v=[^'"]*)?(['"])/g;
const sideEffect = /(import\s+['"])(\.{1,2}\/[^'"?]+\.js)(?:\?v=[^'"]*)?(['"])/g;

for (const file of collect(root)) {
    if (file.includes(`${join(root, 'scripts')}`)) continue;
    const before = readFileSync(file, 'utf8');
    let hits = 0;
    const after = before
        .replace(pattern, (_m, a, spec, c) => { hits += 1; return `${a}${spec}?v=${version}${c}`; })
        .replace(sideEffect, (_m, a, spec, c) => { hits += 1; return `${a}${spec}?v=${version}${c}`; });
    if (hits && after !== before) {
        writeFileSync(file, after);
        files += 1;
        specifiers += hits;
        console.log(`  ${file.slice(root.length + 1)}: ${hits}`);
    }
}

console.log(`\n版本 ${version}：更新 ${files} 个文件、${specifiers} 处相对 import。`);
console.log('接下来 disable/enable 插件或 POST /api/plugins/refresh 使新模块生效。');

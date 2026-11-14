/**
 * 把随插件附带的技能装到 Alma 的个人技能目录。
 * 只有用户显式执行命令时才写文件。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = join(PLUGIN_DIR, 'skills', 'sticker-etiquette', 'SKILL.md');

export function installStickerSkill({ force = false, root = '' } = {}) {
    const base = root || join(homedir(), '.config', 'alma', 'skills');
    const target = join(base, 'sticker-etiquette', 'SKILL.md');
    if (existsSync(target) && !force) {
        return { installed: false, path: target, reason: '技能已存在；覆盖请传 force' };
    }
    const content = readFileSync(SOURCE, 'utf8');
    mkdirSync(dirname(target), { recursive: true });
    const temp = `${target}.tmp`;
    writeFileSync(temp, content, 'utf8');
    renameSync(temp, target);
    return { installed: true, path: target };
}

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = process.env.CHROME_DEVTOOLS_AXI_BIN
    || join(dirname(process.execPath), 'npm-global', 'node_modules', 'chrome-devtools-axi', 'dist', 'bin', 'chrome-devtools-axi.js');
assert.ok(existsSync(cliPath), 'Set CHROME_DEVTOOLS_AXI_BIN to the chrome-devtools-axi JavaScript entry point');
const env = { ...process.env,
    CHROME_DEVTOOLS_AXI_SESSION: `sticker-ui-${Date.now().toString(36)}`,
    CHROME_DEVTOOLS_AXI_HEADED: '0', CHROME_DEVTOOLS_AXI_AUTO_CONNECT: '0',
};
delete env.CHROME_DEVTOOLS_AXI_BROWSER_URL;
delete env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR;

function cli(...args) {
    return new Promise((resolve, reject) => {
        execFile(process.execPath, [cliPath, ...args], {
            cwd: root, env, windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024,
        }, (error, stdout, stderr) => {
            if (error) reject(new Error(`${args[0]}: ${stderr || stdout || error.message}`));
            else resolve(stdout);
        });
    });
}

async function evaluate(source) {
    const output = await cli('eval', source);
    const line = output.match(/^result:\s*(.+)$/m);
    assert.ok(line, output);
    const result = JSON.parse(line[1]);
    return typeof result === 'string' ? JSON.parse(result) : result;
}

const fixture = spawn(process.execPath, ['scripts/verify-ui.mjs'], {
    cwd: root, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true,
});
const lines = createInterface({ input: fixture.stdout });
const details = await new Promise((resolve, reject) => {
    lines.once('line', (line) => {
        try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
    });
    fixture.once('error', reject);
    fixture.once('exit', (code) => reject(new Error(`Fixture exited early: ${code}`)));
});
const outputDir = join(root, 'verification');
mkdirSync(outputDir, { recursive: true });
const report = { fixture: 'synthetic only', checks: [] };

const restoreExpression = `async () => {
    document.getElementById('import-backup-btn').click();
    const until = Date.now() + 20000;
    do { await new Promise(resolve => setTimeout(resolve, 50)); }
    while (document.getElementById('backup-file-input').disabled && Date.now() < until);
    return { result: document.getElementById('import-result').textContent,
        error: document.getElementById('import-result').classList.contains('error'),
        packs: (await (await fetch('/api/packs')).json()).packs.map(pack => pack.id) };
}`;

async function uploadBackup(path) {
    const snapshot = await cli('snapshot');
    const match = snapshot.match(/uid=(\S+) button "备份压缩包/);
    assert.ok(match, snapshot);
    await cli('upload', `@${match[1]}`, path);
    return evaluate(restoreExpression);
}

try {
    await cli('open', `${details.url}/app/settings/#matching`);
    await cli('resize', '1280', '900');
    const initial = await evaluate(`() => ({
        tabs: [...document.querySelectorAll('[data-settings-tab]')].map(tab => tab.textContent.trim()),
        controls: [...document.querySelectorAll('[data-config-path]')].map(input => input.dataset.configPath),
        legacyModes: document.querySelectorAll('input[name="selection-mode"]').length
    })`);
    assert.equal(initial.legacyModes, 0);
    assert.equal(initial.controls.length, 6);
    assert.equal(initial.tabs.length, 5);
    report.checks.push({ name: 'only supported controls are visible', ...initial });

    const saved = await evaluate(`async () => {
        const input = document.querySelector('[data-config-path="semantic.top_k"]');
        input.value = '3'; input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('save-config-btn').click();
        const until = Date.now() + 10000;
        while (window.MemeSettings.busy && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
        const snapshot = await (await fetch('/api/settings/config')).json();
        return { status: document.getElementById('config-save-status').textContent,
            saved: snapshot.fields.find(field => field.path === 'semantic.top_k').value,
            dirty: window.MemeSettings.dirty };
    }`);
    assert.equal(saved.saved, 3);
    assert.equal(saved.dirty, false);
    assert.match(saved.status, /保存/);
    report.checks.push({ name: 'browser edits persist through the real settings API', ...saved });
    await cli('screenshot', join(outputDir, 'settings-desktop.png'));

    await cli('emulate', '--viewport', '390x844x1,mobile,touch');
    const layout = await evaluate('() => ({ width: document.documentElement.clientWidth, contentWidth: document.documentElement.scrollWidth })');
    assert.equal(layout.width, 390);
    assert.ok(layout.contentWidth <= layout.width + 1, JSON.stringify(layout));
    await cli('screenshot', join(outputDir, 'settings-mobile.png'));
    report.checks.push({ name: 'narrow layout has no page overflow', ...layout });

    await cli('emulate', '--viewport', '1280x900x1');
    await evaluate(`() => {
        document.querySelector('[data-settings-tab="backup"]').click();
        window.MemeUI.confirm = async () => true;
        return { page: location.hash };
    }`);
    const restored = await uploadBackup(details.backup);
    assert.match(restored.result, /已恢复 1 个/);
    assert.ok(restored.packs.includes('large-pack') && restored.packs.includes('ui-pack'));
    report.checks.push({ name: '25 MiB backup restores from the file picker', ...restored });

    const duplicate = await uploadBackup(details.backup);
    assert.match(duplicate.result, /保留 1 个同名/);
    report.checks.push({ name: 'unchecked overwrite keeps the existing pack', ...duplicate });

    const broken = await uploadBackup(details.badBackup);
    assert.match(broken.result, /1 个失败/);
    assert.equal(broken.error, true);
    report.checks.push({ name: 'corrupt nested archives are reported as failures', ...broken });
    await cli('screenshot', join(outputDir, 'backup-error.png'));

    writeFileSync(join(outputDir, 'browser-checks.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ passed: report.checks.length, report: join(outputDir, 'browser-checks.json') }));
} finally {
    try { await cli('stop'); } catch (error) { console.error(error.message); }
    const exited = new Promise((resolve) => fixture.once('exit', resolve));
    fixture.stdin.write('quit\n');
    await exited;
    lines.close();
}

import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('the worker loads the Node export of the packaged Transformers dependency', async () => {
    const root = mkdtempSync(join(tmpdir(), 'alma-transformers-export-'));
    const dependency = join(root, 'transformers');
    mkdirSync(join(dependency, 'src'), { recursive: true });
    mkdirSync(join(dependency, 'dist'), { recursive: true });
    writeFileSync(join(dependency, 'package.json'), JSON.stringify({
        name: '@huggingface/transformers',
        type: 'module',
        main: './src/transformers.js',
        exports: { node: { require: './dist/transformers.node.cjs' } },
    }));
    writeFileSync(join(dependency, 'src', 'transformers.js'),
        'throw new Error("Source entry requires the unavailable browser runtime");');
    writeFileSync(join(dependency, 'dist', 'transformers.node.cjs'), `
        module.exports = {
            env: {},
            pipeline: async () => async texts => ({
                tolist: () => texts.map(() => [1, 0, 0]),
            }),
        };
    `);
    const child = fork(fileURLToPath(new URL('../lib/embed-worker.cjs', import.meta.url)), [], {
        env: { ...process.env, STICKER_TRANSFORMERS_PATH: dependency, STICKER_MODEL_CACHE: join(root, 'cache') },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        windowsHide: true,
    });
    try {
        const result = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Worker response timed out')), 5000);
            const fail = error => { clearTimeout(timer); reject(error); };
            child.once('error', fail);
            child.once('exit', code => fail(new Error(`Worker exited before its result: ${code}`)));
            child.on('message', message => {
                if (message.type === 'error') fail(new Error(message.message));
                if (message.type === 'result') {
                    clearTimeout(timer);
                    resolve(message);
                }
            });
            child.send({ type: 'embed', id: 1, texts: ['开心'], kind: 'document' });
        });
        assert.equal(result.dims, 3);
        assert.deepEqual(result.vectors, [[1, 0, 0]]);
    } finally {
        if (child.exitCode === null) {
            const closed = new Promise(resolve => child.once('exit', resolve));
            child.kill();
            await closed;
        }
        const withinTemp = relative(tmpdir(), root);
        assert.ok(withinTemp && !withinTemp.startsWith('..') && !isAbsolute(withinTemp));
        rmSync(root, { recursive: true, force: true });
    }
});

test('the supervisor does not run the host bootstrap inside the embedding worker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'alma-embed-bootstrap-'));
    const dependency = join(root, 'transformers');
    mkdirSync(dependency);
    writeFileSync(join(dependency, 'package.json'), JSON.stringify({
        name: '@huggingface/transformers', exports: { node: { require: './node.cjs' } },
    }));
    writeFileSync(join(dependency, 'node.cjs'), `module.exports = {
        env: {}, pipeline: async () => async texts => ({ tolist: () => texts.map(() => [1, 0, 0]) })
    };`);
    const names = ['ALMA_TRANSFORMERS_PATH', 'ALMA_EMBED_CACHE', 'ALMA_NODE_PATH', 'STICKER_EMBED_FAKE'];
    const previous = new Map(names.map(name => [name, process.env[name]]));
    const previousArgs = process.execArgv;
    process.env.ALMA_TRANSFORMERS_PATH = dependency;
    process.env.ALMA_EMBED_CACHE = join(root, 'cache');
    process.env.ALMA_NODE_PATH = process.execPath;
    delete process.env.STICKER_EMBED_FAKE;
    process.execArgv = ['--import', 'data:text/javascript,throw%20new%20Error(%22Host%20bootstrap%20must%20not%20run%22)'];
    const embed = await import('../lib/embed.js?test=host-bootstrap');
    try {
        const ready = await embed.warmEmbedder({ timeoutMs: 2000 });
        assert.equal(ready.state, 'ready', ready.error);
        assert.equal(ready.dims, 3);
    } finally {
        embed.shutdownEmbedder();
        process.execArgv = previousArgs;
        for (const [name, value] of previous) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
        const withinTemp = relative(tmpdir(), root);
        assert.ok(withinTemp && !withinTemp.startsWith('..') && !isAbsolute(withinTemp));
        rmSync(root, { recursive: true, force: true });
    }
});

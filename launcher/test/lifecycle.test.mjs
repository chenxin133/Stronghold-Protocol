import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const launcher = fileURLToPath(new URL('..', import.meta.url));

async function waitFor(read, description) {
  const until = Date.now() + 25_000;
  while (Date.now() < until) {
    try { const result = await read(); if (result) return result; } catch { /* server is between versions */ }
    await delay(100);
  }
  throw new Error(`Timed out: ${description}`);
}

async function fixture(t, { matches = 0, failNext = false, offline = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stronghold-pwa-lifecycle-'));
  const reserve = http.createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  for (const name of ['server.mjs', 'game-child.mjs', 'lib.mjs', 'web', 'package.json']) await fs.cp(path.join(launcher, name), path.join(root, name), { recursive: true });
  await fs.symlink(path.join(launcher, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const runtime = path.join(root, '.runtime');
  const control = path.join(root, 'control.json');
  await fs.writeFile(control, JSON.stringify({ matches, offline }));
  const stubServer = `
    import http from 'node:http';
    import fs from 'node:fs';
    export async function startServer({ port, host }) {
      const spec = JSON.parse(fs.readFileSync(new URL('../spec.json', import.meta.url)));
      if (spec.fail) throw new Error('Intentional new-version boot failure');
      const server = http.createServer((req, res) => {
        const control = JSON.parse(fs.readFileSync(process.env.SP_TEST_CONTROL));
        if (req.url === '/healthz') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, matches: control.matches })); }
        else res.end(spec.tag);
      });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      return { port, close: () => new Promise((resolve) => server.close(resolve)) };
    }
  `;
  for (const id of [1, 2]) {
    const version = path.join(runtime, 'versions', `${id}-${id}`);
    const game = path.join(version, 'Stronghold-Protocol');
    await fs.mkdir(path.join(game, 'server'), { recursive: true });
    await fs.writeFile(path.join(game, 'server/index.js'), stubServer);
    await fs.writeFile(path.join(game, 'package.json'), '{"type":"module"}');
    await fs.writeFile(path.join(game, 'spec.json'), JSON.stringify({ tag: `v${id}`, fail: id === 2 && failNext }));
    await fs.writeFile(path.join(version, 'ready.json'), JSON.stringify({ key: `${id}-${id}`, repository: 'example/game', tag: `v${id}` }));
  }
  await fs.writeFile(path.join(runtime, 'current.json'), '{"key":"1-1"}');
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({
    source: 'https://github.com/example/game', port, host: '127.0.0.1', checkIntervalMinutes: 5, assetPublicDirectory: '', subscriptions: [],
  }));
  const mock = path.join(root, 'mock-network.mjs');
  await fs.writeFile(mock, `
    import fs from 'node:fs';
    const actualFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith('https://api.github.com/')) {
        const control = JSON.parse(fs.readFileSync(process.env.SP_TEST_CONTROL));
        if (control.offline) throw new Error('Intentional GitHub outage');
        return new Response(JSON.stringify({ id: 2, tag_name: 'v2', html_url: 'https://github.com/example/game/releases/tag/v2', assets: [
          { id: 2, name: 'Stronghold-Protocol-v2-lite.zip', size: 4, browser_download_url: 'https://github.com/example/game/releases/download/v2/lite.zip' }
        ] }));
      }
      return actualFetch(url, options);
    };
  `);
  const child = spawn(process.execPath, [path.join(root, 'server.mjs')], {
    env: { ...process.env, SP_TEST_CONTROL: control, NODE_OPTIONS: `--import=${pathToFileURL(mock).href}` },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    // A game child also closes its server when its parent IPC disconnects.
    await waitFor(async () => { try { await fetch(`http://127.0.0.1:${port}`); return false; } catch { return true; } }, 'game stops with supervisor');
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return {
    root, runtime, output: () => output,
    game: async () => (await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) })).text(),
    setIdle: () => fs.writeFile(control, JSON.stringify({ matches: 0, offline })),
    status: async (id) => JSON.parse(await fs.readFile(path.join(runtime, 'versions', `${id}-${id}`, 'Stronghold-Protocol/public/subscriptions/status.json'), 'utf8')),
  };
}

test('an idle server activates a prepared release and persists the new version', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  await waitFor(async () => await f.game() === 'v2', 'new game is served');
  await waitFor(async () => JSON.parse(await fs.readFile(path.join(f.runtime, 'current.json'))).key === '2-2', 'new pointer is committed');
  assert.equal((await f.status(2)).current, 'v2');
});

test('an active match keeps its game process until the idle check succeeds', { timeout: 35_000 }, async (t) => {
  const f = await fixture(t, { matches: 1 });
  await waitFor(() => f.output().includes('waiting for an idle server'), 'new release is pending');
  assert.equal(await f.game(), 'v1');
  assert.equal((await f.status(1)).phase, 'waiting-for-match');
  await f.setIdle();
  await waitFor(async () => await f.game() === 'v2', 'idle retry activates update');
});

test('failed new-version startup restores the previous game and pointer', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t, { failNext: true });
  await waitFor(() => f.output().includes('Restoring v1'), 'rollback is attempted');
  await waitFor(async () => await f.game() === 'v1' && (await f.status(1)).error?.includes('restored v1'), 'previous game is restored');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.runtime, 'current.json'))).key, '1-1');
});

test('a GitHub outage does not prevent starting the installed game', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t, { offline: true });
  await waitFor(() => f.output().includes('keeping the installed game'), 'remote check fails');
  assert.equal(await f.game(), 'v1');
  assert.match((await f.status(1)).error, /GitHub outage/);
});

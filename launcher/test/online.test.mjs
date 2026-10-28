import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { onlinePlan, gameReady, waitForGame, launchOnline } from '../online.mjs';
import { connectToolRoot, bundleConnectTool, CONNECTTOOL_REQUIRED } from '../connecttool.mjs';
import { readJson } from '../lib.mjs';

const config = await readJson(new URL('../config.json', import.meta.url));
const configFile = path.resolve('config.json');
const toolFile = path.resolve('bundle/connecttool/connecttool-qt.exe');
function spawner({ failTool = false, exitServer = false } = {}) {
  const calls = [];
  const spawnFn = (executable, args, options) => {
    const child = new EventEmitter();
    child.unref = () => {};
    child.kill = () => { child.killed = true; };
    calls.push({ executable, args, options, child });
    queueMicrotask(() => {
      if (failTool) child.emit('error', new Error('Tool launch failed'));
      else {
        child.emit('spawn');
        if (exitServer && calls.length === 2) setImmediate(() => child.emit('exit', 1));
      }
    });
    return child;
  };
  return { calls, spawnFn };
}

test('host uses the configured game port and guest only opens the forwarded port', () => {
  const host = onlinePlan('host', config, configFile, toolFile);
  assert.equal(host.url, 'http://localhost:3000/');
  assert.equal(host.listenPort, 3001);
  assert.ok(host.serverArgs.includes('--config'));
  assert.equal(onlinePlan('join', config, configFile, toolFile).serverArgs, null);
  assert.equal(onlinePlan('join', config, configFile, toolFile).url, 'http://localhost:3001/');
  assert.throws(() => onlinePlan('host', { ...config, port: 3001 }, configFile), /conflicts/);
  assert.throws(() => onlinePlan('other', config, configFile), /Choose/);
});

test('host launches bundled ConnectTool with its DLL/AppID working directory, then the server, then the game', async () => {
  const f = spawner();
  const events = [];
  await launchOnline(onlinePlan('host', config, configFile, toolFile), {
    spawnFn: f.spawnFn, ready: async () => false,
    wait: async (url) => events.push(`ready:${url}`), open: async (url) => events.push(`open:${url}`),
  });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].executable, toolFile);
  assert.equal(f.calls[0].options.cwd, path.dirname(toolFile));
  assert.equal(f.calls[0].options.windowsHide, false);
  assert.equal(f.calls[1].executable, process.execPath);
  assert.match(f.calls[1].args[0], /server\.mjs$/);
  assert.deepEqual(events, ['ready:http://localhost:3000/', 'open:http://localhost:3000/']);
});

test('guest and an already-running host do not launch a competing game server', async () => {
  for (const mode of ['join', 'host']) {
    const f = spawner();
    await launchOnline(onlinePlan(mode, config, configFile, toolFile), {
      spawnFn: f.spawnFn, ready: async () => true, wait: async () => {}, open: async () => {},
    });
    assert.equal(f.calls.length, 1);
  }
});

test('a ConnectTool launch failure prevents starting the game server', async () => {
  const f = spawner({ failTool: true });
  await assert.rejects(() => launchOnline(onlinePlan('host', config, configFile, toolFile), {
    spawnFn: f.spawnFn, ready: async () => false, open: async () => assert.fail('must not open browser'),
  }), /Tool launch failed/);
  assert.equal(f.calls.length, 1);
});

test('server startup failure aborts the wait and does not open a misleading game window', async () => {
  const f = spawner({ exitServer: true });
  let aborted = false;
  await assert.rejects(() => launchOnline(onlinePlan('host', config, configFile, toolFile), {
    spawnFn: f.spawnFn, ready: async () => false,
    wait: (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); })),
    open: async () => assert.fail('must not open browser'),
  }), /Game server stopped/);
  assert.equal(aborted, true);
});

test('only the game health response releases the connection wait; timeout and cancellation stop it', async () => {
  assert.equal(await gameReady('http://localhost:3001/', async () => new Response('{"ok":true,"app":"0.3.3","build":"abc"}')), true);
  assert.equal(await gameReady('http://localhost:3001/', async () => new Response('{"ok":true}')), false);
  let attempts = 0;
  await waitForGame('http://localhost:3001/', {
    fetchFn: async () => { attempts++; return new Response(attempts === 2 ? '{"ok":true,"app":"0.3.3","build":"abc"}' : '{}'); },
    sleep: async () => {}, attempts: 2,
  });
  assert.equal(attempts, 2);
  await assert.rejects(() => waitForGame('http://localhost:3001/', { fetchFn: async () => new Response('{}'), attempts: 1 }), /not reachable/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => waitForGame('http://localhost:3001/', { signal: controller.signal }), /abort/i);
});

test('ConnectTool staging requires its runtime libraries and the expected AppID; an unverified ZIP is refused', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stronghold-connecttool-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tool = path.join(root, 'official');
  for (const file of CONNECTTOOL_REQUIRED) {
    if (file.startsWith('runtime/')) await fs.mkdir(path.join(tool, file), { recursive: true });
    else { await fs.mkdir(path.dirname(path.join(tool, file)), { recursive: true }); await fs.writeFile(path.join(tool, file), file === 'steam_appid.txt' ? '480\n' : 'fixture'); }
  }
  assert.equal(await connectToolRoot(root), tool);
  await fs.writeFile(path.join(tool, 'steam_appid.txt'), '1234');
  await assert.rejects(() => connectToolRoot(root), /AppID/);
  const zip = path.join(root, 'invalid.zip'); await fs.writeFile(zip, 'not an official ZIP');
  await assert.rejects(() => bundleConnectTool(zip, path.join(root, 'out'), path.join(root, 'extract'), { sha256: '0'.repeat(64) }), /SHA-256/);
});

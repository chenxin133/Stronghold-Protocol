// Test the actual bundled game in a clean runtime while all external fetches in its processes are blocked.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { copyInstalledGame, atomicJson } from './lib.mjs';

export async function smokeOfflineGame(launcherDirectory, node, bundled, config) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'stronghold-offline-smoke-'));
  let child;
  let output = '';
  let port;
  try {
    for (const name of ['package.json', 'server.mjs', 'game-child.mjs', 'lib.mjs', 'local-game.mjs', 'web']) {
      await fs.cp(path.join(launcherDirectory, name), path.join(temporary, name), { recursive: true });
    }
    await fs.symlink(path.join(launcherDirectory, 'node_modules'), path.join(temporary, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const version = path.join(temporary, '.runtime/versions', bundled.metadata.key);
    await copyInstalledGame(bundled.game, path.join(version, 'Stronghold-Protocol'), bundled.metadata.tag);
    await atomicJson(path.join(version, 'ready.json'), bundled.metadata);
    await atomicJson(path.join(temporary, '.runtime/current.json'), { key: bundled.metadata.key });
    const reserve = http.createServer();
    reserve.listen(0, '127.0.0.1');
    await once(reserve, 'listening');
    port = reserve.address().port;
    await new Promise((resolve) => reserve.close(resolve));
    await atomicJson(path.join(temporary, 'config.json'), {
      ...config, host: '127.0.0.1', port, assetPublicDirectory: bundled.sharedPublic, subscriptions: [],
    });
    const preload = path.join(temporary, 'offline.mjs');
    await fs.writeFile(preload, `
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = (url, options) => {
        const parsed = new URL(url);
        if (['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) return nativeFetch(url, options);
        return Promise.reject(new Error('External network blocked for offline package test'));
      };
    `);
    child = spawn(node, [path.join(temporary, 'server.mjs')], {
      cwd: temporary, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GITHUB_TOKEN: '', NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
    });
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    let spawnError;
    child.on('error', (error) => { spawnError = error; });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 300; attempt++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Offline game exited (${child.exitCode}): ${output}`);
      try {
        const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) });
        const health = await response.json();
        if (health.ok && health.app === bundled.metadata.tag.replace(/^v/, '')) { ready = true; break; }
      } catch { /* booting */ }
      await delay(200);
    }
    if (!ready) throw new Error(`Offline game startup timed out: ${output}`);
    for (const route of ['/', '/manifest.json', '/vendor/preact.module.js', '/data/assets.json', '/data/chess.json', `/assets/${bundled.image}`]) {
      const response = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok || !(await response.arrayBuffer()).byteLength) throw new Error(`Offline package route failed: ${route}`);
    }
    if (output.includes('[update] Preparing')) throw new Error('Bundled game tried to install instead of starting offline');
    console.log(`Bundled game ${bundled.metadata.tag}: clean offline start, HTML, manifest, JS and image checks passed.`);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    if (port) {
      for (let attempt = 0; attempt < 50; attempt++) {
        try { await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) }); }
        catch { break; }
        await delay(100);
      }
    }
    const relative = path.relative(os.tmpdir(), temporary);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Refusing to remove an unexpected smoke-test directory');
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

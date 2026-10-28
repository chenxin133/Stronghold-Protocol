// Standalone deployment supervisor. Game rules, browser storage and upstream source remain upstream-owned.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { repository, validateConfig, githubClient, liteAsset, downloadAsset, extractGame, copyInstalledGame, canRestart, atomicJson, readJson } from './lib.mjs';
import { findLocalGame, importLocalGame } from './local-game.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const configArgument = process.argv.indexOf('--config');
const configFile = path.resolve(configArgument >= 0 ? process.argv[configArgument + 1] : path.join(HERE, 'config.json'));
const config = validateConfig(await readJson(configFile));
const stateDir = path.join(HERE, '.runtime');
await fs.mkdir(stateDir, { recursive: true });
const lockFile = path.join(stateDir, 'server.lock');
let lock;
try {
  lock = await fs.open(lockFile, 'wx');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  const pid = Number(await fs.readFile(lockFile, 'utf8'));
  let alive = true;
  try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
  if (alive) throw new Error(`PWA server is already running (PID ${pid}).`);
  await fs.unlink(lockFile);
  lock = await fs.open(lockFile, 'wx');
}
await lock.writeFile(String(process.pid));
const api = githubClient();
const source = repository(config.source);
let child = null;
let current = null;
let pending = null;
let stopped = false;
let checking = false;
let interval;
let retry;
let setupChild;
const status = { source: `https://github.com/${source}`, current: null, latest: null, phase: 'starting', checkedAt: null, subscriptions: [] };

async function writeStatus() {
  if (!current) return;
  await atomicJson(path.join(current.game, 'public/subscriptions/status.json'), status);
}

async function runSetup(game) {
  const setup = spawn(process.execPath, ['tools/setup.mjs', '--no-local', '--no-scenes', '--yes'], {
    cwd: game, stdio: 'inherit', windowsHide: true,
  });
  setupChild = setup;
  const [code] = await once(setup, 'exit');
  setupChild = null;
  if (code !== 0) throw new Error(`Game setup exited ${code}`);
}

async function linkAssets(game) {
  const publicDir = config.assetPublicDirectory
    ? path.resolve(path.dirname(configFile), config.assetPublicDirectory)
    : path.join(stateDir, 'shared/public');
  for (const name of ['assets', 'fonts']) {
    const link = path.join(game, 'public', name);
    const existing = await fs.lstat(link).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
    if (existing) {
      if (!existing.isDirectory() && !existing.isSymbolicLink()) throw new Error(`Invalid game asset directory: ${link}`);
      continue;
    }
    const target = path.join(publicDir, name);
    await fs.mkdir(target, { recursive: true });
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  }
  // Optional extracted art is version-specific; import its manifests only from a matching installation.
  if (config.assetPublicDirectory) {
    const install = path.dirname(publicDir);
    const localPackage = await readJson(path.join(install, 'package.json')).catch(() => null);
    const releasePackage = await readJson(path.join(game, 'package.json'));
    if (localPackage?.version === releasePackage.version) {
      for (const name of ['local-assets.json', 'local-fx.json']) {
        await fs.copyFile(path.join(install, 'data', name), path.join(game, 'data', name)).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    }
  }
}

async function prepare(release) {
  const asset = liteAsset(release);
  const key = `${release.id}-${asset.id}`;
  const destination = path.join(stateDir, 'versions', key);
  const ready = await readJson(path.join(destination, 'ready.json')).catch(() => null);
  if (ready?.key === key && ready.repository === source) return { ...ready, game: path.join(destination, 'Stronghold-Protocol') };
  const staging = await fs.mkdtemp(path.join(stateDir, 'prepare-'));
  console.log(`[update] Preparing ${release.tag_name}: ${asset.name}`);
  const zip = path.join(staging, 'release.zip');
  let game;
  let digest;
  let provenance = 'github-release-zip';
  if (config.seedInstallation) {
    try {
      const seed = path.resolve(path.dirname(configFile), config.seedInstallation);
      const seedGame = path.join(staging, 'seed', 'Stronghold-Protocol');
      digest = await copyInstalledGame(seed, seedGame, release.tag_name);
      game = seedGame;
      provenance = 'verified-local-installation-manifest';
      console.log('[update] Reused the matching local release after checking every program file against MANIFEST.json.');
    } catch (error) { console.warn(`[update] Local seed unavailable: ${error.message}; downloading the release instead.`); }
  }
  if (!game) {
    digest = await downloadAsset(asset, zip);
    game = await extractGame(zip, staging);
    await fs.unlink(zip);
  } else {
    await fs.rename(game, path.join(staging, 'Stronghold-Protocol'));
    game = path.join(staging, 'Stronghold-Protocol');
  }
  await linkAssets(game);
  await runSetup(game);
  await fs.cp(path.join(HERE, 'web'), path.join(game, 'public/subscriptions'), { recursive: true });
  const metadata = { key, repository: source, tag: release.tag_name, releaseUrl: release.html_url, provenance, sha256: digest, installedAt: new Date().toISOString() };
  await atomicJson(path.join(staging, 'ready.json'), metadata);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(staging, destination);
  return { ...metadata, game: path.join(destination, 'Stronghold-Protocol') };
}

async function startGame(installed) {
  if (stopped) return;
  await linkAssets(installed.game);
  await fs.cp(path.join(HERE, 'web'), path.join(installed.game, 'public/subscriptions'), { recursive: true });
  const plugins = path.join(stateDir, 'shared/plugins');
  await fs.mkdir(plugins, { recursive: true });
  const processChild = fork(path.join(HERE, 'game-child.mjs'), [], {
    env: { ...process.env, SP_PWA_GAME: installed.game, SP_PWA_PORT: String(config.port), SP_PWA_HOST: config.host, SP_PWA_PLUGINS: plugins },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true,
  });
  child = processChild;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { processChild.kill(); reject(new Error('Game startup timed out')); }, 60_000);
    processChild.once('error', (error) => { clearTimeout(timer); reject(error); });
    processChild.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Game exited during startup (${code})`)); });
    processChild.on('message', (message) => {
      if (message.ready) { clearTimeout(timer); resolve(); }
      else if (message.error) { clearTimeout(timer); reject(new Error(message.error)); }
    });
  });
  current = installed;
  status.current = installed.tag;
  status.phase = 'running';
  await atomicJson(path.join(stateDir, 'current.json'), { key: installed.key });
  await writeStatus();
  processChild.once('exit', (code) => {
    if (child === processChild && !stopped) {
      console.error(`[server] Game stopped unexpectedly (${code}); restart the launcher to recover.`);
      shutdown(1);
    }
  });
}

async function stopGame() {
  const previous = child;
  child = null;
  if (!previous || previous.exitCode !== null || previous.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => previous.kill(), 12_000);
    previous.once('exit', () => { clearTimeout(timer); resolve(); });
    if (previous.connected) previous.send('stop'); else previous.kill();
  });
}

async function idle() {
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/healthz`, { signal: AbortSignal.timeout(5_000), cache: 'no-store' });
    return response.ok && canRestart(await response.json());
  } catch { return false; }
}

async function applyPending() {
  if (!pending || stopped || !(await idle())) return;
  status.phase = 'preparing';
  await writeStatus();
  const next = await prepare(pending);
  if (stopped || !(await idle())) { status.phase = 'waiting-for-match'; await writeStatus(); return; }
  const previous = current;
  await stopGame();
  try {
    await startGame(next);
    pending = null;
    console.log(`[update] Now serving ${next.tag}. Installed PWAs receive the new game without repackaging.`);
  } catch (error) {
    console.error(`[update] New version failed: ${error.message}. Restoring ${previous.tag}.`);
    await stopGame();
    await startGame(previous);
    pending = null;
    status.error = `Update failed; restored ${previous.tag}: ${error.message}`;
    await writeStatus();
  }
}

async function checkUpdates() {
  if (checking || stopped) return;
  checking = true;
  try {
    const release = await api(`/repos/${source}/releases/latest`);
    const asset = liteAsset(release);
    status.latest = release.tag_name;
    status.checkedAt = new Date().toISOString();
    delete status.error;
    status.subscriptions = await Promise.all(config.subscriptions.map(async (item) => {
      const repo = repository(item.url);
      const url = `https://github.com/${repo}`;
      try {
        const data = await api(`/repos/${repo}/${item.kind === 'releases' ? 'releases/latest' : 'commits?per_page=1'}`);
        const entry = item.kind === 'releases' ? data : data[0];
        const branch = item.kind === 'commits' ? (await api(`/repos/${repo}`)).default_branch : null;
        const feed = item.kind === 'releases' ? `${url}/releases.atom` : `${url}/commits/${encodeURIComponent(branch)}.atom`;
        return { repository: repo, kind: item.kind, version: entry.tag_name || entry.sha?.slice(0, 12), url: entry.html_url, feed };
      } catch (error) { return { repository: repo, kind: item.kind, url, error: error.message }; }
    }));
    const sameLocalVersion = current?.provenance === 'verified-local-installation-manifest' && current.tag === release.tag_name;
    if (current && current.key !== `${release.id}-${asset.id}` && !sameLocalVersion) {
      pending = release;
      status.phase = 'waiting-for-match';
      console.log(`[update] ${release.tag_name} available; waiting for an idle server.`);
      await applyPending();
    }
    await writeStatus();
  } catch (error) {
    status.error = error.message;
    console.warn(`[update] ${error.message}; keeping the installed game.`);
    await writeStatus();
  } finally { checking = false; }
}

async function shutdown(code = 0) {
  if (stopped) return;
  stopped = true;
  clearInterval(interval);
  clearInterval(retry);
  setupChild?.kill();
  await stopGame();
  await lock.close();
  await fs.unlink(lockFile).catch(() => {});
  process.exit(code);
}
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());

try {
  const pointer = await readJson(path.join(stateDir, 'current.json')).catch(() => null);
  if (pointer && /^[0-9]+-[0-9]+$/.test(pointer.key)) {
    const metadata = await readJson(path.join(stateDir, 'versions', pointer.key, 'ready.json')).catch(() => null);
    if (metadata?.repository === source) current = { ...metadata, game: path.join(stateDir, 'versions', pointer.key, 'Stronghold-Protocol') };
  }
  if (!current) {
    const local = await findLocalGame(config, configFile, HERE);
    if (local) {
      console.log(`[startup] Importing local game from ${local}; verifying the release manifest (no download).`);
      current = await importLocalGame(local, stateDir, source);
    } else {
      console.log('[startup] No bundled or local game found. Downloading the first installation; keep this window open.');
      const release = await api(`/repos/${source}/releases/latest`);
      current = await prepare(release);
    }
  }
  if (!config.assetPublicDirectory && current.localAssetPublicDirectory) config.assetPublicDirectory = current.localAssetPublicDirectory;
  console.log(`[startup] Starting installed game ${current.tag}...`);
  await startGame(current);
  console.log(`\nPWA: http://localhost:${config.port}/`);
  console.log(`Subscriptions: http://localhost:${config.port}/subscriptions/`);
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) if (address.family === 'IPv4' && !address.internal) console.log(`LAN: http://${address.address}:${config.port}/`);
  }
  console.log('Use a trusted HTTPS address to install the PWA on iPad/Android. Ctrl+C stops the server.\n');
  await checkUpdates();
  interval = setInterval(() => checkUpdates(), config.checkIntervalMinutes * 60_000);
  retry = setInterval(async () => {
    if (!pending || checking || stopped) return;
    checking = true;
    try { await applyPending(); } catch (error) { status.error = error.message; await writeStatus(); console.warn(`[update] ${error.message}`); }
    finally { checking = false; }
  }, 15_000);
} catch (error) {
  console.error(`[startup] ${error.message}`);
  await shutdown(1);
}

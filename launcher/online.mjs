// i18n-ignore-file: standalone deployment console is bilingual by design.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { readJson, validateConfig } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const JOIN_PORT = 3001;

export function onlinePlan(mode, config, configFile, toolFile = path.join(HERE, '../connecttool/connecttool-qt.exe')) {
  if (!['host', 'join'].includes(mode)) throw new Error('Choose host or join');
  validateConfig(config);
  if (mode === 'host' && config.port === JOIN_PORT) throw new Error('Game port 3001 conflicts with ConnectTool; use another game port');
  return {
    mode, toolFile: path.resolve(toolFile), toolArgs: [],
    targetPort: config.port, listenPort: JOIN_PORT,
    url: `http://localhost:${mode === 'host' ? config.port : JOIN_PORT}/`,
    serverArgs: mode === 'host' ? [path.join(HERE, 'server.mjs'), '--config', path.resolve(configFile)] : null,
  };
}

export async function gameReady(url, fetchFn = fetch) {
  try {
    const response = await fetchFn(new URL('/healthz', url), { signal: AbortSignal.timeout(2000), cache: 'no-store' });
    const health = response.ok ? await response.json() : null;
    return health?.ok === true && typeof health.app === 'string' && typeof health.build === 'string';
  } catch { return false; }
}

export async function waitForGame(url, { fetchFn = fetch, sleep = delay, attempts = 600, signal } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    signal?.throwIfAborted();
    if (await gameReady(url, fetchFn)) return;
    if (attempt + 1 < attempts) await sleep(1000, undefined, { signal });
  }
  throw new Error('Game is not reachable yet. Check the ConnectTool room and TCP ports, then open the printed URL.');
}

async function openGame(url) {
  const candidates = [
    process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA,
  ].filter(Boolean).map((directory) => path.join(directory, 'Microsoft/Edge/Application/msedge.exe'));
  let edge;
  for (const candidate of candidates) if (await fs.stat(candidate).then((stat) => stat.isFile()).catch(() => false)) { edge = candidate; break; }
  const browser = edge
    ? spawn(edge, [`--app=${url}`], { detached: true, stdio: 'ignore', windowsHide: false })
    : spawn('cmd.exe', ['/d', '/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
  browser.on('error', (error) => console.warn(`Open ${url} in your browser (${error.message}).`));
  browser.unref();
}

export async function launchOnline(plan, { spawnFn = spawn, wait = waitForGame, ready = gameReady, open = openGame, node = process.execPath, signal } = {}) {
  const controller = new AbortController();
  if (signal?.aborted) signal.throwIfAborted();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const tool = spawnFn(plan.toolFile, plan.toolArgs, { cwd: path.dirname(plan.toolFile), detached: true, stdio: 'ignore', windowsHide: false });
  await new Promise((resolve, reject) => { tool.once('spawn', resolve); tool.once('error', reject); });
  tool.unref();
  let server;
  if (plan.serverArgs && !(await ready(plan.url))) {
    server = spawnFn(node, plan.serverArgs, { stdio: 'inherit', windowsHide: true });
    await new Promise((resolve, reject) => { server.once('spawn', resolve); server.once('error', reject); });
  }
  let exited = false;
  let onExit;
  const exit = server ? new Promise((resolve, reject) => {
    onExit = (code) => { exited = true; reject(new Error(`Game server stopped (${code}); check whether another server already uses this port`)); };
    server.once('exit', onExit);
  }) : null;
  try {
    const waiting = wait(plan.url, { signal: controller.signal });
    if (exit) await Promise.race([waiting, exit]); else await waiting;
    if (server) server.removeListener('exit', onExit);
    await open(plan.url);
    return server;
  } catch (error) {
    controller.abort();
    if (server && !exited) server.kill();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('This integrated ConnectTool launcher is for Windows');
  const args = process.argv.slice(2);
  const value = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const configFile = path.resolve(value('--config', path.join(HERE, 'config.json')));
  const config = await readJson(configFile);
  let mode = args.includes('--host') ? 'host' : args.includes('--join') ? 'join' : null;
  if (!mode) {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    const choice = await input.question('1. 开服 / Host    2. 加入 / Join\n选择 / Choose [1]: ');
    input.close();
    mode = !choice || choice.trim() === '1' ? 'host' : choice.trim() === '2' ? 'join' : null;
  }
  const plan = onlinePlan(mode, config, configFile, value('--connecttool', undefined));
  await fs.access(plan.toolFile);
  console.log('\n请先登录 Steam。ConnectTool 已随本包提供。 / Sign in to Steam first.\n');
  console.log(`ConnectTool: TCP 转发 / TCP forwarding; 主机目标端口 / target: ${plan.targetPort}; 本地监听端口 / listen: ${plan.listenPort}`);
  console.log(mode === 'host'
    ? '房主：房间 ID 留空，创建房间，再把 ID 发给朋友。 / Host: leave room ID empty and create a room.'
    : '加入者：在 ConnectTool 输入房主的房间 ID，然后加入。 / Guest: enter the host room ID in ConnectTool.');
  console.log(`连通后自动打开 / Opens when connected: ${plan.url}\n游戏同盟密钥与 ConnectTool 房间 ID 不同。 / The game alliance key is separate from the ConnectTool room ID.\n`);
  const controller = new AbortController();
  let server;
  process.on('SIGINT', () => { controller.abort(); server?.kill(); });
  process.on('SIGTERM', () => { controller.abort(); server?.kill(); });
  server = await launchOnline(plan, { signal: controller.signal });
  if (server) {
    server.on('exit', (code) => process.exit(code || 0));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

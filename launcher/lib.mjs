import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import extract from 'extract-zip';

export function repository(input) {
  const url = new URL(input);
  const parts = url.pathname.replace(/\.git\/?$/, '').split('/').filter(Boolean);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password ||
      parts.length < 2 || !parts.slice(0, 2).every((s) => /^[A-Za-z0-9_.-]+$/.test(s) && s !== '.' && s !== '..')) {
    throw new Error('Use an HTTPS GitHub repository link: https://github.com/OWNER/REPO');
  }
  return parts.slice(0, 2).join('/');
}

export function validateConfig(config) {
  repository(config.source);
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('Invalid port');
  if (typeof config.host !== 'string' || !config.host) throw new Error('Invalid host');
  if (!Number.isFinite(config.checkIntervalMinutes) || config.checkIntervalMinutes < 5) throw new Error('Check interval must be at least 5 minutes');
  if (typeof config.assetPublicDirectory !== 'string') throw new Error('Invalid assetPublicDirectory');
  if (!Array.isArray(config.subscriptions) || config.subscriptions.length > 10) throw new Error('At most 10 subscriptions');
  for (const item of config.subscriptions) {
    repository(item.url);
    if (!['releases', 'commits'].includes(item.kind)) throw new Error('Subscription kind must be releases or commits');
  }
  return config;
}

export function githubClient(fetchFn = fetch, token = process.env.GITHUB_TOKEN) {
  const cache = new Map();
  return async (endpoint) => {
    if (!endpoint.startsWith('/repos/')) throw new Error('Invalid GitHub endpoint');
    const previous = cache.get(endpoint);
    const response = await fetchFn(`https://api.github.com${endpoint}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Stronghold-PWA-Server',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(previous ? { 'If-None-Match': previous.etag } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 304 && previous) return previous.body;
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}${response.status === 403 || response.status === 429 ? ' (rate limit; retry later)' : ''}`);
    const body = await response.json();
    const etag = response.headers.get('etag');
    if (etag) cache.set(endpoint, { etag, body });
    return body;
  };
}

export function liteAsset(release) {
  if (!Number.isSafeInteger(release.id) || release.id <= 0 || release.draft || release.prerelease || typeof release.tag_name !== 'string') {
    throw new Error('Expected a stable GitHub release');
  }
  const asset = release.assets?.find((a) => /^Stronghold-Protocol-v.+-lite\.zip$/.test(a.name));
  if (!asset || !Number.isSafeInteger(asset.id) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 512 * 1024 * 1024) {
    throw new Error('This release has no supported Stronghold-Protocol lite ZIP');
  }
  const url = new URL(asset.browser_download_url);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port) throw new Error('Invalid release download URL');
  if (asset.digest && !/^sha256:[a-f0-9]{64}$/i.test(asset.digest)) throw new Error('Unsupported release digest');
  return asset;
}

export function safeZipEntry(entry) {
  const name = entry.fileName;
  if (name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name) ||
      name.split('/').some((part) => part === '..') || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) {
    throw new Error(`Unsafe ZIP entry: ${name}`);
  }
}

export async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function downloadAsset(asset, file, fetchFn = fetch) {
  const response = await fetchFn(asset.browser_download_url, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`Download HTTP ${response.status}`);
  let bytes = 0;
  const body = Readable.fromWeb(response.body);
  body.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > asset.size) body.destroy(new Error('Release download exceeds its advertised size'));
  });
  await pipeline(body, createWriteStream(file, { flags: 'wx' }));
  if (bytes !== asset.size) throw new Error('Release download is incomplete');
  const digest = await sha256(file);
  if (asset.digest && asset.digest.toLowerCase() !== `sha256:${digest}`) throw new Error('Release SHA-256 mismatch');
  return digest;
}

export async function extractGame(zip, destination) {
  await extract(zip, { dir: path.resolve(destination), onEntry: safeZipEntry });
  const root = path.join(destination, 'Stronghold-Protocol');
  for (const required of ['package.json', 'server/index.js', 'public/index.html', 'public/manifest.json', 'node_modules/ws/package.json', 'public/vendor/preact.module.js']) {
    if (!(await fs.stat(path.join(root, required))).isFile()) throw new Error(`Incomplete game package: ${required}`);
  }
  return root;
}

export async function copyInstalledGame(installation, destination, tag) {
  const manifestFile = path.join(installation, 'MANIFEST.json');
  const manifest = await readJson(manifestFile);
  const pkg = await readJson(path.join(installation, 'package.json'));
  if (manifest.format !== 1 || manifest.app !== tag.replace(/^v/, '') || pkg.version !== manifest.app ||
      !manifest.files || !Object.keys(manifest.files).length) throw new Error('Existing installation does not match this release');
  const files = Object.entries(manifest.files);
  // Validate everything before copying; only the release manifest's allowlist can enter the new runtime.
  for (let index = 0; index < files.length; index += 16) {
    await Promise.all(files.slice(index, index + 16).map(async ([name, expected]) => {
      safeZipEntry({ fileName: name, externalFileAttributes: 0 });
      if (!name || name.split('/').some((part) => !part || part === '.') || !/^[a-f0-9]{64}$/.test(expected.sha256)) throw new Error('Invalid installation manifest');
      const file = path.join(installation, name);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size !== expected.size || await sha256(file) !== expected.sha256) throw new Error(`Existing installation file changed: ${name}`);
    }));
  }
  for (const [name] of files) {
    const target = path.join(destination, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(installation, name), target);
  }
  return sha256(manifestFile);
}

export function canRestart(health) {
  return health?.ok === true && Number.isInteger(health.matches) && health.matches === 0;
}

export async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, file);
}

export async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

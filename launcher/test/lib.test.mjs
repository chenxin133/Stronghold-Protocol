import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { repository, validateConfig, githubClient, liteAsset, fullAsset, safeZipEntry, downloadAsset, copyInstalledGame, canRestart, atomicJson, readJson } from '../lib.mjs';

const validAsset = {
  id: 20, name: 'Stronghold-Protocol-v0.3.3-lite.zip', size: 4,
  browser_download_url: 'https://github.com/example/game/releases/download/v0.3.3/game-lite.zip',
};
const release = { id: 10, tag_name: 'v0.3.3', assets: [validAsset] };

test('repository links accept repository, release and commit links; reject other hosts and credentials', () => {
  for (const suffix of ['', '.git', '/releases/latest', '/commits/master']) assert.equal(repository(`https://github.com/sganggs/Stronghold-Protocol${suffix}`), 'sganggs/Stronghold-Protocol');
  for (const url of ['http://github.com/a/b', 'https://github.com.evil.test/a/b', 'https://user:secret@github.com/a/b', 'https://github.com/a', 'https://github.com:444/a/b']) assert.throws(() => repository(url));
});

test('config checks subscription kinds and rejects excessive polling', async () => {
  const config = await readJson(new URL('../config.json', import.meta.url));
  assert.equal(validateConfig(config), config);
  assert.throws(() => validateConfig({ ...config, checkIntervalMinutes: 0 }));
  assert.throws(() => validateConfig({ ...config, port: 0 }));
  assert.throws(() => validateConfig({ ...config, subscriptions: [{ url: config.source, kind: 'execute' }] }));
});

test('only stable releases with a bounded lite ZIP are executable sources', () => {
  assert.equal(liteAsset(release), validAsset);
  for (const change of [{ prerelease: true }, { draft: true }, { id: '../other' }, { assets: [] },
    { assets: [{ ...validAsset, size: 1024 ** 3 }] }, { assets: [{ ...validAsset, browser_download_url: 'https://evil.test/code.zip' }] },
    { assets: [{ ...validAsset, digest: 'sha1:1234' }] }]) assert.throws(() => liteAsset({ ...release, ...change }));
});

test('ZIP traversal, drive paths, backslashes and symlinks are rejected', () => {
  safeZipEntry({ fileName: 'Stronghold-Protocol/server/index.js', externalFileAttributes: 0 });
  for (const fileName of ['../outside', '/outside', 'C:/outside', 'dir/../../outside', 'dir\\..\\outside']) {
    assert.throws(() => safeZipEntry({ fileName, externalFileAttributes: 0 }));
  }
  assert.throws(() => safeZipEntry({ fileName: 'link', externalFileAttributes: 0xa000 << 16 }));
});

test('the full game selector excludes update/lite ZIPs and allows the complete asset package', () => {
  const full = { ...validAsset, id: 21, name: 'Stronghold-Protocol-v0.3.3.zip', size: 861090941 };
  assert.equal(fullAsset({ ...release, assets: [validAsset, { ...validAsset, name: 'Stronghold-Protocol-v0.3.3-update.zip' }, full] }), full);
  assert.throws(() => fullAsset(release), /full ZIP/);
  assert.throws(() => fullAsset({ ...release, assets: [{ ...full, size: 3 * 1024 ** 3 }] }), /full ZIP/);
});

test('a server only restarts with an explicit zero active-match count', () => {
  assert.equal(canRestart({ ok: true, matches: 0 }), true);
  for (const health of [null, {}, { ok: true }, { ok: true, matches: 1 }, { ok: true, matches: '0' }, { ok: false, matches: 0 }]) assert.equal(canRestart(health), false);
});

test('GitHub conditional requests reuse a cached body on 304; errors remain errors', async () => {
  const calls = [];
  const client = githubClient(async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? new Response(JSON.stringify(release), { headers: { etag: '"release"' } }) : new Response(null, { status: 304 });
  }, 'test-token');
  assert.deepEqual(await client('/repos/a/b/releases/latest'), release);
  assert.deepEqual(await client('/repos/a/b/releases/latest'), release);
  assert.equal(calls[1].options.headers['If-None-Match'], '"release"');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
  await assert.rejects(() => githubClient(async () => new Response('', { status: 403 }), '')('/repos/a/b/releases/latest'), /rate limit/);
  await assert.rejects(() => client('https://evil.test/'), /Invalid/);
});

test('downloads enforce length and SHA-256 before a release can be activated', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stronghold-download-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const digest = crypto.createHash('sha256').update('test').digest('hex');
  const asset = { ...validAsset, digest: `sha256:${digest}` };
  const fetchFn = async () => new Response('test');
  assert.equal(await downloadAsset(asset, path.join(dir, 'good.zip'), fetchFn), digest);
  await assert.rejects(() => downloadAsset({ ...asset, digest: `sha256:${'0'.repeat(64)}` }, path.join(dir, 'bad.zip'), fetchFn), /SHA-256/);
  await assert.rejects(() => downloadAsset({ ...asset, size: 5 }, path.join(dir, 'short.zip'), fetchFn), /incomplete/);
  await assert.rejects(() => downloadAsset({ ...asset, size: 3 }, path.join(dir, 'long.zip'), fetchFn), /exceeds/);
});

test('atomic state replacement leaves valid JSON and no temporary files', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stronghold-state-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  await atomicJson(file, { tag: 'v1' });
  await atomicJson(file, { tag: 'v2' });
  assert.deepEqual(await readJson(file), { tag: 'v2' });
  assert.deepEqual(await fs.readdir(dir), ['state.json']);
});

test('an existing installation is copied only after its version and every manifest digest match', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stronghold-seed-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'existing');
  await fs.mkdir(source);
  const content = '{"version":"0.3.3"}';
  const expected = { size: Buffer.byteLength(content), sha256: crypto.createHash('sha256').update(content).digest('hex') };
  await fs.writeFile(path.join(source, 'package.json'), content);
  await atomicJson(path.join(source, 'MANIFEST.json'), { format: 1, app: '0.3.3', files: { 'package.json': expected } });
  await atomicJson(path.join(source, 'data/assets.json'), { chars: { fixture: {} } });
  await copyInstalledGame(source, path.join(dir, 'good'), 'v0.3.3');
  assert.equal(await fs.readFile(path.join(dir, 'good/package.json'), 'utf8'), content);
  assert.deepEqual(await readJson(path.join(dir, 'good/data/assets.json')), { chars: { fixture: {} } });
  await assert.rejects(() => copyInstalledGame(source, path.join(dir, 'wrong-version'), 'v0.4.0'), /does not match/);
  await fs.writeFile(path.join(source, 'package.json'), '{"version":"0.3.3","changed":true}');
  await assert.rejects(() => copyInstalledGame(source, path.join(dir, 'changed'), 'v0.3.3'), /file changed/);
});

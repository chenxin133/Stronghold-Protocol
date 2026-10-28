import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { findLocalGame, importLocalGame } from '../local-game.mjs';
import { readJson, atomicJson } from '../lib.mjs';

test('manual game folders are recognized directly or inside the official ZIP top-level folder', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stronghold-local-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const launcher = path.join(root, 'launcher');
  const game = path.join(root, 'game/Stronghold-Protocol');
  await fs.mkdir(launcher, { recursive: true });
  const pkg = JSON.stringify({ name: 'stronghold-protocol-alliance', version: '0.3.3' });
  await atomicJson(path.join(game, 'MANIFEST.json'), { format: 1, app: '0.3.3', files: {
    'package.json': { size: Buffer.byteLength(pkg), sha256: crypto.createHash('sha256').update(pkg).digest('hex') },
  } });
  await fs.writeFile(path.join(game, 'package.json'), pkg);
  await atomicJson(path.join(game, 'data/assets.json'), { version: 1 });
  const configFile = path.join(launcher, 'config.json');
  assert.equal(await findLocalGame({}, configFile, launcher), game);
  assert.equal(await findLocalGame({ seedInstallation: '../game' }, configFile, launcher), game);
  assert.equal(await findLocalGame({ seedInstallation: game }, configFile, launcher), game);
  await assert.rejects(() => findLocalGame({ seedInstallation: '../missing' }, configFile, launcher), /seedInstallation/);
  const runtime = path.join(launcher, '.runtime'); await fs.mkdir(runtime);
  const installed = await importLocalGame(game, runtime, 'sganggs/Stronghold-Protocol');
  assert.match(installed.key, /^0-\d+$/);
  assert.equal(installed.tag, 'v0.3.3');
  assert.equal(installed.localAssetPublicDirectory, path.join(game, 'public'));
  assert.deepEqual(await readJson(path.join(installed.game, 'data/assets.json')), { version: 1 });
  assert.equal((await importLocalGame(game, runtime, 'sganggs/Stronghold-Protocol')).key, installed.key);
});

import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, copyInstalledGame, atomicJson, sha256 } from './lib.mjs';

export async function findLocalGame(config, configFile, launcherDirectory) {
  const explicit = config.seedInstallation ? path.resolve(path.dirname(configFile), config.seedInstallation) : null;
  const candidates = explicit ? [explicit, path.join(explicit, 'Stronghold-Protocol')]
    : [path.join(launcherDirectory, '../game'), path.join(launcherDirectory, '../game/Stronghold-Protocol')];
  for (const directory of candidates) {
    const pkg = await readJson(path.join(directory, 'package.json')).catch(() => null);
    if (pkg?.name === 'stronghold-protocol-alliance' && await fs.stat(path.join(directory, 'MANIFEST.json')).then((stat) => stat.isFile()).catch(() => false)) return directory;
  }
  if (explicit) throw new Error('seedInstallation must point to an extracted game release containing package.json and MANIFEST.json');
  return null;
}

export async function importLocalGame(directory, stateDirectory, source) {
  const pkg = await readJson(path.join(directory, 'package.json'));
  const digest = await sha256(path.join(directory, 'MANIFEST.json'));
  const key = `0-${BigInt(`0x${digest.slice(0, 13)}`).toString()}`;
  const destination = path.join(stateDirectory, 'versions', key);
  const existing = await readJson(path.join(destination, 'ready.json')).catch(() => null);
  if (existing?.sha256 === digest && existing.repository === source && existing.tag === `v${pkg.version}`) {
    return { ...existing, localAssetPublicDirectory: path.join(directory, 'public'), game: path.join(destination, 'Stronghold-Protocol') };
  }
  const staging = await fs.mkdtemp(path.join(stateDirectory, 'prepare-local-'));
  await copyInstalledGame(directory, path.join(staging, 'Stronghold-Protocol'), `v${pkg.version}`);
  const metadata = {
    key, repository: source, tag: `v${pkg.version}`, provenance: 'verified-local-installation-manifest', sha256: digest,
    localAssetPublicDirectory: path.join(directory, 'public'), installedAt: new Date().toISOString(),
  };
  await atomicJson(path.join(staging, 'ready.json'), metadata);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(staging, destination);
  return { ...metadata, game: path.join(destination, 'Stronghold-Protocol') };
}

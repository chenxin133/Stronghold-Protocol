import fs from 'node:fs/promises';
import path from 'node:path';
import { repository, githubClient, liteAsset, fullAsset, downloadAsset, extractGame, atomicJson } from './lib.mjs';

export async function firstImage(directory, prefix = '') {
  const entries = await fs.readdir(path.join(directory, prefix), { withFileTypes: true });
  for (const entry of entries) if (entry.isFile() && /\.(?:png|webp|jpe?g)$/i.test(entry.name)) return path.posix.join(prefix, entry.name);
  for (const entry of entries) if (entry.isDirectory()) {
    const found = await firstImage(directory, path.posix.join(prefix, entry.name));
    if (found) return found;
  }
  return null;
}

export async function bundleGame(launcherDirectory, temporaryDirectory, config, { api = githubClient(), fetchFn = fetch } = {}) {
  const source = repository(config.source);
  const release = await api(`/repos/${source}/releases/latest`);
  const asset = fullAsset(release);
  if (!asset.digest) throw new Error('Bundling a full game requires a published SHA-256 digest');
  // The updater uses the lite asset as its release identity. A bundled full copy is the same game version.
  const key = `${release.id}-${liteAsset(release).id}`;
  const runtime = path.join(launcherDirectory, '.runtime');
  const version = path.join(runtime, 'versions', key);
  const archive = path.join(temporaryDirectory, 'game-full.zip');
  console.log(`Bundling complete game ${release.tag_name} (${Math.ceil(asset.size / 1024 / 1024)} MiB download)...`);
  const digest = await downloadAsset(asset, archive, fetchFn);
  const game = await extractGame(archive, version);
  const sharedPublic = path.join(runtime, 'shared/public');
  await fs.mkdir(sharedPublic, { recursive: true });
  for (const name of ['assets', 'fonts']) {
    const folder = path.join(game, 'public', name);
    if (!(await fs.readdir(folder)).length) throw new Error(`Full game package has no ${name}`);
    // No junctions in the ZIP: the server creates the local links after extraction on the player's computer.
    await fs.rename(folder, path.join(sharedPublic, name));
  }
  const image = await firstImage(path.join(sharedPublic, 'assets'));
  if (!image) throw new Error('Full game package has no image assets');
  const metadata = {
    key, repository: source, tag: release.tag_name, releaseUrl: release.html_url,
    provenance: 'bundled-full-github-release', sha256: digest, installedAt: new Date().toISOString(),
  };
  await atomicJson(path.join(version, 'ready.json'), metadata);
  await atomicJson(path.join(runtime, 'current.json'), { key });
  console.log(`Bundled full game ${metadata.tag}: program, dependencies and assets verified.`);
  return { metadata, game, sharedPublic, image };
}

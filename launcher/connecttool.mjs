import fs from 'node:fs/promises';
import path from 'node:path';
import extract from 'extract-zip';
import { safeZipEntry, sha256 } from './lib.mjs';

export const CONNECTTOOL_REQUIRED = [
  'connecttool-qt.exe', 'steam_api64.dll', 'steam_appid.txt', 'Qt6Core.dll',
  'Qt6Gui.dll', 'Qt6Quick.dll', 'runtime/qml', 'runtime/plugins', 'licenses/THIRD_PARTY_NOTICES.md',
];

export async function connectToolRoot(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const candidates = [directory, ...entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(directory, entry.name))];
  const roots = [];
  for (const candidate of candidates) {
    if (await fs.stat(path.join(candidate, 'connecttool-qt.exe')).then((stat) => stat.isFile()).catch(() => false)) roots.push(candidate);
  }
  if (roots.length !== 1) throw new Error('Expected exactly one ConnectTool program directory');
  for (const name of CONNECTTOOL_REQUIRED) {
    const stat = await fs.stat(path.join(roots[0], name));
    if (name.startsWith('runtime/') ? !stat.isDirectory() : !stat.isFile()) throw new Error(`Incomplete ConnectTool package: ${name}`);
  }
  if ((await fs.readFile(path.join(roots[0], 'steam_appid.txt'), 'utf8')).trim() !== '480') throw new Error('Unexpected ConnectTool Steam AppID');
  return roots[0];
}

export async function bundleConnectTool(zip, destination, extractionDirectory, pin) {
  if (await sha256(zip) !== pin.sha256) throw new Error('Official ConnectTool ZIP SHA-256 mismatch');
  await extract(zip, { dir: path.resolve(extractionDirectory), onEntry: safeZipEntry });
  const root = await connectToolRoot(extractionDirectory);
  await fs.cp(root, destination, { recursive: true });
  await fs.writeFile(path.join(destination, 'BUNDLED-VERSION.json'), `${JSON.stringify(pin, null, 2)}\n`);
}

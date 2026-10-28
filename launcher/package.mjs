// One-time Windows bootstrap package; game releases are fetched at runtime, without rebuilding this ZIP.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import extract from 'extract-zip';
import { sha256, safeZipEntry, readJson } from './lib.mjs';

if (process.platform !== 'win32') throw new Error('Build the Windows bootstrap ZIP on Windows (or use the GitHub workflow).');
const here = path.dirname(fileURLToPath(import.meta.url));
const version = (await readJson(path.join(here, 'package.json'))).version;
const outIndex = process.argv.indexOf('--out');
const out = path.resolve(outIndex >= 0 ? process.argv[outIndex + 1] : path.join(here, 'dist'));
await fs.mkdir(out, { recursive: true });
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'stronghold-pwa-package-'));
// Same official Node pin as the upstream Windows bundle; update the hash together with the version.
const nodeVersion = 'v22.23.3';
const nodeFolder = `node-${nodeVersion}-win-x64`;
const expectedHash = '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71';
const nodeZip = path.join(temp, 'node.zip');
const response = await fetch(`https://nodejs.org/dist/${nodeVersion}/${nodeFolder}.zip`, { signal: AbortSignal.timeout(5 * 60_000) });
if (!response.ok) throw new Error(`Node download HTTP ${response.status}`);
await fs.writeFile(nodeZip, Buffer.from(await response.arrayBuffer()));
if (await sha256(nodeZip) !== expectedHash) throw new Error('Official Node ZIP SHA-256 mismatch');
await extract(nodeZip, { dir: temp, onEntry: safeZipEntry });
const stage = path.join(temp, 'Stronghold-PWA-Server');
await fs.mkdir(path.join(stage, 'node'), { recursive: true });
await fs.mkdir(path.join(stage, 'launcher'), { recursive: true });
await fs.copyFile(path.join(temp, nodeFolder, 'node.exe'), path.join(stage, 'node/node.exe'));
await fs.copyFile(path.join(temp, nodeFolder, 'LICENSE'), path.join(stage, 'node/LICENSE-node.txt'));
for (const name of ['package.json', 'package-lock.json', 'config.json', 'server.mjs', 'game-child.mjs', 'lib.mjs', 'Start-PWA.cmd', 'web', 'node_modules']) {
  await fs.cp(path.join(here, name), path.join(stage, 'launcher', name), { recursive: true });
}
for (const name of ['LICENSE', 'NOTICE.md', 'THIRD-PARTY-NOTICES.md']) await fs.copyFile(path.join(here, '..', name), path.join(stage, name));
await fs.copyFile(path.join(here, '../docs/PWA-SUBSCRIPTIONS.md'), path.join(stage, 'README.md'));
await fs.writeFile(path.join(stage, 'Start-PWA.cmd'), '@echo off\r\ncall "%~dp0launcher\\Start-PWA.cmd" %*\r\n');
const zip = path.join(out, `Stronghold-PWA-Server-${version}-Windows-x64.zip`);
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  "$ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath $env:SP_PWA_STAGE -DestinationPath $env:SP_PWA_ZIP -CompressionLevel Optimal"],
{ env: { ...process.env, SP_PWA_STAGE: stage, SP_PWA_ZIP: zip }, stdio: 'inherit', windowsHide: true });
const checksum = `${await sha256(zip)}  ${path.basename(zip)}\n`;
await fs.writeFile(`${zip}.sha256`, checksum);
console.log(zip);
console.log(checksum.trim());
// This directory was just created by mkdtemp and is never supplied by the user.
await fs.rm(temp, { recursive: true, force: true });

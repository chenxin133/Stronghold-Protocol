// Complete Windows package; later game releases are fetched without rebuilding this ZIP.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import extract from 'extract-zip';
import { sha256, safeZipEntry, readJson, downloadAsset } from './lib.mjs';
import { bundleConnectTool, connectToolRoot } from './connecttool.mjs';
import { bundleGame } from './bundle-game.mjs';
import { smokeOfflineGame } from './package-smoke.mjs';

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
for (const name of ['package.json', 'package-lock.json', 'config.json', 'server.mjs', 'game-child.mjs', 'lib.mjs', 'local-game.mjs', 'online.mjs', 'Start-PWA.cmd', 'Start-Online.cmd', 'connecttool.json', 'web', 'node_modules']) {
  await fs.cp(path.join(here, name), path.join(stage, 'launcher', name), { recursive: true });
}
for (const name of ['LICENSE', 'NOTICE.md', 'THIRD-PARTY-NOTICES.md']) await fs.copyFile(path.join(here, '..', name), path.join(stage, name));
await fs.copyFile(path.join(here, '../docs/PWA-SUBSCRIPTIONS.md'), path.join(stage, 'README.md'));
await fs.writeFile(path.join(stage, 'Start-PWA.cmd'), '@echo off\r\ncall "%~dp0launcher\\Start-PWA.cmd" %*\r\n');
await fs.writeFile(path.join(stage, 'Start-Online.cmd'), '@echo off\r\ncall "%~dp0launcher\\Start-Online.cmd" %*\r\n');
await fs.writeFile(path.join(stage, 'Host-Game.cmd'), '@echo off\r\ncall "%~dp0launcher\\Start-Online.cmd" --host %*\r\n');
await fs.copyFile(path.join(here, '../Join-Game.cmd'), path.join(stage, 'Join-Game.cmd'));
const pin = await readJson(path.join(here, 'connecttool.json'));
const toolIndex = process.argv.indexOf('--connecttool-zip');
let toolZip;
if (toolIndex >= 0) {
  toolZip = path.resolve(process.argv[toolIndex + 1]);
} else {
  toolZip = path.join(temp, 'connecttool.zip');
  await downloadAsset({ browser_download_url: pin.url, size: pin.size, digest: `sha256:${pin.sha256}` }, toolZip);
}
await bundleConnectTool(toolZip, path.join(stage, 'connecttool'), path.join(temp, 'connecttool-extract'), pin);
await fs.copyFile(path.join(here, 'connecttool-LICENSE.txt'), path.join(stage, 'connecttool/LICENSE.txt'));
const toolRoot = await connectToolRoot(path.join(stage, 'connecttool'));
// Run a separate copy so build-machine logs or crash dumps never enter the distributed package.
const smokeDirectory = path.join(temp, 'connecttool-smoke');
await fs.cp(toolRoot, smokeDirectory, { recursive: true });
const smoke = spawnSync(path.join(smokeDirectory, 'connecttool-qt.exe'), ['--software-renderer', '--qml-smoke-test'], {
  cwd: smokeDirectory, env: { ...process.env, QT_QPA_PLATFORM: 'windows' }, timeout: 60_000, windowsHide: true, encoding: 'utf8',
});
if (smoke.error || smoke.status !== 0) throw new Error(`Bundled ConnectTool failed its QML smoke test: ${smoke.error?.message || smoke.stderr || smoke.status}`);
console.log(`Bundled ConnectTool ${pin.version}: SHA-256 and QML smoke test passed.`);
const config = await readJson(path.join(here, 'config.json'));
const bundled = await bundleGame(path.join(stage, 'launcher'), temp, config);
await smokeOfflineGame(path.join(stage, 'launcher'), path.join(stage, 'node/node.exe'), bundled, config);
await fs.writeFile(path.join(stage, 'BUNDLE.json'), `${JSON.stringify({ launcher: version, connecttool: pin.version, game: bundled.metadata.tag, offlineGame: true }, null, 2)}\n`);
const zip = path.join(out, `Stronghold-PWA-Server-${version}-Windows-x64.zip`);
console.log('Creating full Windows ZIP...');
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [AppContext]::SetSwitch('Switch.System.IO.Compression.ZipFile.UseBackslash', $false); [System.IO.Compression.ZipFile]::CreateFromDirectory($env:SP_PWA_STAGE, $env:SP_PWA_ZIP, [System.IO.Compression.CompressionLevel]::Fastest, $true)"],
{ env: { ...process.env, SP_PWA_STAGE: stage, SP_PWA_ZIP: zip }, stdio: 'inherit', windowsHide: true });
console.log('ZIP created; checking bundled runtime, game, image and ConnectTool entries...');
// Verify the actual ZIP includes the dot-prefixed runtime, not just the staging directory.
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
  $ErrorActionPreference = 'Stop'
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($env:SP_PWA_ZIP)
  try {
    foreach ($required in ($env:SP_PWA_REQUIRED | ConvertFrom-Json)) {
      if ($null -eq $archive.GetEntry($required)) { throw "Missing bundled file: $required" }
    }
  } finally { $archive.Dispose() }
`], { env: { ...process.env, SP_PWA_ZIP: zip, SP_PWA_REQUIRED: JSON.stringify([
  'Stronghold-PWA-Server/launcher/.runtime/current.json',
  `Stronghold-PWA-Server/launcher/.runtime/versions/${bundled.metadata.key}/Stronghold-Protocol/server/index.js`,
  `Stronghold-PWA-Server/launcher/.runtime/shared/public/assets/${bundled.image}`,
  'Stronghold-PWA-Server/connecttool/connecttool-qt.exe',
]) }, stdio: 'inherit', windowsHide: true });
const checksum = `${await sha256(zip)}  ${path.basename(zip)}\n`;
await fs.writeFile(`${zip}.sha256`, checksum);
console.log(zip);
console.log(checksum.trim());
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'package-online-update.ps1'), '-OutDirectory', out], { stdio: 'inherit', windowsHide: true });
// This directory was just created by mkdtemp and is never supplied by the user.
await fs.rm(temp, { recursive: true, force: true });

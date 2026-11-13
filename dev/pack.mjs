import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { packager } from '@electron/packager';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const electronVersion = require('electron/package.json').version;
const zipName = `electron-v${electronVersion}-win32-x64.zip`;

function findCachedZip() {
  const roots = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'electron', 'Cache') : '',
    path.join(os.homedir(), 'AppData', 'Local', 'electron', 'Cache'),
    path.join(root, 'dev', '.cache')
  ].filter(Boolean);
  for (const dir of roots) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(dir, entry.name, zipName);
      if (fs.existsSync(candidate)) return candidate;
    }
    const direct = path.join(dir, zipName);
    if (fs.existsSync(direct)) return direct;
  }
  return null;
}

async function downloadZip(dest) {
  const url = `https://npmmirror.com/mirrors/electron/${electronVersion}/${zipName}`;
  console.log(`下载 Electron ${electronVersion}：${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length')) || 0;
  const file = fs.createWriteStream(dest);
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.length;
    if (total && received % (8 * 1024 * 1024) < chunk.length) {
      process.stdout.write(`\r${(received / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB`);
    }
    if (!file.write(chunk)) await new Promise((resolve) => file.once('drain', resolve));
  }
  await new Promise((resolve, reject) => file.end((error) => (error ? reject(error) : resolve())));
  if (total) process.stdout.write('\n');
}

let zip = findCachedZip();
if (!zip) {
  const cacheDir = path.join(root, 'dev', '.cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  zip = path.join(cacheDir, zipName);
  await downloadZip(zip);
} else {
  console.log(`使用本地 Electron 包：${zip}`);
}

const out = await packager({
  dir: root,
  name: 'ChromeHub',
  platform: 'win32',
  arch: 'x64',
  out: 'dist',
  overwrite: true,
  icon: path.join(root, 'assets', 'icon.ico'),
  appCopyright: 'ChromeHub',
  asar: true,
  electronZipDir: path.dirname(zip),
  ignore: [/^\/dev(\/|$)/, /^\/dist(\/|$)/, /^dev(\/|$)/, /^dist(\/|$)/]
});
console.log('打包完成：', out.join(', '));

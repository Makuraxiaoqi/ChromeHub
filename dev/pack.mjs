import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { packager } from '@electron/packager';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const electronVersion = require('electron/package.json').version;

function readOption(name, fallback) {
  const withEquals = process.argv.find((item) => item.startsWith(`--${name}=`));
  if (withEquals) return withEquals.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    return process.argv[index + 1];
  }
  return fallback;
}

const platform = readOption('platform', process.argv.includes('--linux') ? 'linux' : 'win32');
const arch = readOption('arch', 'x64');
if (!['win32', 'linux'].includes(platform) || arch !== 'x64') {
  console.error(`暂不支持 ${platform}-${arch}，可选 win32-x64 / linux-x64`);
  process.exit(1);
}

const zipName = `electron-v${electronVersion}-${platform}-${arch}.zip`;

function findCachedZip() {
  const roots = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'electron', 'Cache') : '',
    process.env.XDG_CACHE_HOME ? path.join(process.env.XDG_CACHE_HOME, 'electron') : '',
    path.join(os.homedir(), 'AppData', 'Local', 'electron', 'Cache'),
    path.join(os.homedir(), '.cache', 'electron'),
    path.join(root, 'dev', '.cache')
  ].filter(Boolean);
  for (const dir of roots) {
    if (!fs.existsSync(dir)) continue;
    const direct = path.join(dir, zipName);
    if (fs.existsSync(direct)) return direct;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(dir, entry.name, zipName);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

async function downloadZip(dest) {
  const url = `https://npmmirror.com/mirrors/electron/${electronVersion}/${zipName}`;
  console.log(`下载 Electron ${electronVersion} (${platform}-${arch})：${url}`);
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60 * 1000) });
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

const options = {
  dir: root,
  name: 'ChromeHub',
  platform,
  arch,
  out: 'dist',
  overwrite: true,
  icon: path.join(root, 'assets', platform === 'linux' ? 'icon.png' : 'icon.ico'),
  appCopyright: 'ChromeHub',
  asar: true,
  electronZipDir: path.dirname(zip),
  ignore: [/^\/dev(\/|$)/, /^\/dist(\/|$)/, /^dev(\/|$)/, /^dist(\/|$)/]
};

const out = await packager(options);
console.log(`打包完成（${platform}-${arch}）：`, out.join(', '));

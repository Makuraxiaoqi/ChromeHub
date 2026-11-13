const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const os = require('node:os');
const { chromium } = require('playwright');
const extractZip = require('extract-zip');
const { ensureDir } = require('./util');

function playwrightPackageDir() {
  try {
    return path.dirname(require.resolve('playwright-core/package.json'));
  } catch {
    return path.join(path.dirname(require.resolve('playwright/package.json')), '..', 'playwright-core');
  }
}

function chromiumBuildInfo() {
  try {
    const file = path.join(playwrightPackageDir(), 'browsers.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entry = (data.browsers || []).find((item) => item.name === 'chromium');
    if (!entry) throw new Error('未找到 chromium 构建信息');
    return { revision: entry.revision, browserVersion: entry.browserVersion };
  } catch (error) {
    return { revision: '', browserVersion: '', error: error.message };
  }
}

function chromiumPaths() {
  const executable = chromium.executablePath();
  const revisionDir = path.dirname(path.dirname(executable));
  return { executable, revisionDir, ...chromiumBuildInfo() };
}

function chromiumStatus() {
  const info = chromiumPaths();
  return {
    ...info,
    exists: fs.existsSync(info.executable),
    cacheDir: path.dirname(info.revisionDir),
    platform: process.platform,
    arch: process.arch
  };
}

function chromiumDownloadTarget(platform = process.platform, arch = process.arch) {
  if (arch !== 'x64' || (platform !== 'win32' && platform !== 'linux')) {
    throw new Error(`暂不支持当前平台（${platform}-${arch}），目前提供 Windows x64 / Linux x64`);
  }
  if (platform === 'win32') {
    return {
      platform,
      arch,
      ctfPlatform: 'win64',
      zipName: 'chrome-win64.zip',
      folder: 'chrome-win64',
      executable: 'chrome.exe'
    };
  }
  return {
    platform,
    arch,
    ctfPlatform: 'linux64',
    zipName: 'chrome-linux64.zip',
    folder: 'chrome-linux64',
    executable: 'chrome'
  };
}

function makeExecutable(file) {
  if (process.platform === 'win32') return;
  try {
    fs.chmodSync(file, 0o755);
  } catch {
    /* 非关键：权限设置失败时保留原权限 */
  }
}

function download(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('下载重定向次数过多'));
    const client = url.startsWith('http://') ? http : https;
    const request = client.get(url, { headers: { 'User-Agent': 'ChromeHub/1.0' } }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, url).toString();
        return download(next, dest, onProgress, redirects + 1).then(resolve, reject);
      }
      if (status !== 200) {
        response.resume();
        return reject(new Error(`下载失败：HTTP ${status}`));
      }
      const total = Number(response.headers['content-length']) || 0;
      let received = 0;
      let lastTick = 0;
      const file = fs.createWriteStream(dest);
      response.on('data', (chunk) => {
        received += chunk.length;
        const now = Date.now();
        if (now - lastTick > 350) {
          lastTick = now;
          onProgress?.({ received, total, percent: total ? (received / total) * 100 : 0 });
        }
      });
      response.pipe(file);
      file.on('finish', () => file.close(() => resolve({ received, total })));
      file.on('error', reject);
      response.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(10 * 60 * 1000, () => request.destroy(new Error('下载超时')));
  });
}

async function installChromium(onProgress, { force = false } = {}) {
  const status = chromiumStatus();
  if (status.exists && !force) return status;
  const target = chromiumDownloadTarget();
  if (!status.browserVersion || !status.revision) {
    throw new Error('无法读取 Playwright 的 Chromium 版本信息，请重新安装依赖');
  }

  const cacheDir = status.cacheDir;
  ensureDir(cacheDir);
  const zipPath = path.join(cacheDir, `chromehub-chromium-${status.revision}.zip`);
  const sources = [
    `https://cdn.npmmirror.com/binaries/chrome-for-testing/${status.browserVersion}/${target.ctfPlatform}/${target.zipName}`,
    `https://storage.googleapis.com/chrome-for-testing-public/${status.browserVersion}/${target.ctfPlatform}/${target.zipName}`
  ];

  let lastError = null;
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index];
    try {
      onProgress?.({ phase: 'download', message: `正在下载浏览器内核（${index + 1}/${sources.length}）...`, percent: 0 });
      await download(source, zipPath, (progress) => {
        onProgress?.({
          phase: 'download',
          message: `正在下载浏览器内核... ${progress.percent ? progress.percent.toFixed(1) + '%' : Math.round(progress.received / 1048576) + ' MB'}`,
          percent: progress.percent
        });
      });
      onProgress?.({ phase: 'extract', message: '正在解压浏览器内核...', percent: 100 });
      fs.rmSync(status.revisionDir, { recursive: true, force: true });
      ensureDir(status.revisionDir);
      await extractZip(zipPath, { dir: status.revisionDir });
      const executable = path.join(status.revisionDir, target.folder, target.executable);
      makeExecutable(executable);
      makeExecutable(path.join(status.revisionDir, target.folder, 'chrome_crashpad_handler'));
      makeExecutable(path.join(status.revisionDir, target.folder, 'chrome_sandbox'));
      fs.writeFileSync(path.join(status.revisionDir, 'INSTALLATION_COMPLETE'), '');
      fs.rmSync(zipPath, { force: true });
      const after = chromiumStatus();
      if (!after.exists) throw new Error(`解压完成但未找到 ${target.executable}`);
      onProgress?.({ phase: 'done', message: '浏览器内核安装完成', percent: 100 });
      return after;
    } catch (error) {
      lastError = error;
      try {
        fs.rmSync(zipPath, { force: true });
      } catch {
        /* ignore */
      }
      if (index < sources.length - 1) {
        onProgress?.({ phase: 'download', message: `下载源 ${index + 1} 失败，正在切换...`, percent: 0 });
      }
    }
  }
  throw new Error(`浏览器内核安装失败：${lastError?.message || '未知错误'}`);
}

module.exports = {
  chromiumStatus,
  installChromium,
  chromiumPaths,
  chromiumDownloadTarget
};

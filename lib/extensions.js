const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { ensureDir, fileToDataUrl, dirSize, randomId } = require('./util');

function isSafeEntryName(name) {
  const normalized = String(name).replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return false;
  return !normalized.split('/').some((part) => part === '..');
}

function extractZipBuffer(buffer, destDir) {
  const zip = new AdmZip(buffer);
  ensureDir(destDir);
  for (const entry of zip.getEntries()) {
    const name = entry.entryName.replace(/\\/g, '/');
    if (!isSafeEntryName(name)) continue;
    const target = path.resolve(destDir, name);
    if (!target.startsWith(path.resolve(destDir) + path.sep) && target !== path.resolve(destDir)) continue;
    if (entry.isDirectory) {
      ensureDir(target);
    } else {
      ensureDir(path.dirname(target));
      fs.writeFileSync(target, entry.getData());
    }
  }
}

function crxToZipBuffer(crxPath) {
  const data = fs.readFileSync(crxPath);
  if (data.length < 16 || data.toString('utf8', 0, 4) !== 'Cr24') {
    throw new Error('不是有效的 CRX 文件');
  }
  const version = data.readUInt32LE(4);
  let offset = -1;
  if (version === 2) {
    const publicKeyLength = data.readUInt32LE(8);
    const signatureLength = data.readUInt32LE(12);
    offset = 16 + publicKeyLength + signatureLength;
  } else if (version === 3) {
    const headerLength = data.readUInt32LE(8);
    offset = 12 + headerLength;
  } else {
    throw new Error(`不支持的 CRX 版本：${version}`);
  }
  if (offset <= 0 || offset >= data.length) {
    offset = data.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  }
  if (offset < 0 || data.toString('utf8', offset, offset + 2) !== 'PK') {
    throw new Error('CRX 中未找到 ZIP 数据');
  }
  return data.subarray(offset);
}

function findManifestRoot(rootDir) {
  const rootManifest = path.join(rootDir, 'manifest.json');
  if (fs.existsSync(rootManifest)) return rootDir;

  const candidates = [];
  const queue = [{ dir: rootDir, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (depth > 3) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      if (fs.existsSync(path.join(child, 'manifest.json'))) candidates.push(child);
      queue.push({ dir: child, depth: depth + 1 });
    }
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    const unique = [...new Set(candidates.map((item) => fs.readFileSync(path.join(item, 'manifest.json'), 'utf8')))];
    if (unique.length > 1) throw new Error('压缩包内包含多个扩展，请一次只导入一个');
    return candidates[0];
  }
  throw new Error('未找到 manifest.json，这不是有效的 Chrome 扩展');
}

function readLocaleMessages(extensionDir, locale) {
  if (!locale) return {};
  const candidates = [
    path.join(extensionDir, '_locales', locale, 'messages.json'),
    path.join(extensionDir, '_locales', String(locale).replace(/-/g, '_'), 'messages.json')
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  }
  return {};
}

function localizeText(value, messages) {
  if (typeof value !== 'string') return '';
  return value.replace(/__MSG_([A-Za-z0-9_@]+)__/g, (match, key) => {
    const entry = messages[key] || messages[key.toLowerCase()];
    return entry && typeof entry.message === 'string' ? entry.message : match;
  });
}

function pickIcon(extensionDir, manifest, messages) {
  const candidates = [];
  const push = (value, size) => {
    if (!value) return;
    if (typeof value === 'string') candidates.push({ file: value, size: Number(size) || 0 });
    else if (typeof value === 'object') {
      for (const [key, file] of Object.entries(value)) {
        if (typeof file === 'string') candidates.push({ file, size: Number(key) || 0 });
      }
    }
  };
  push(manifest.icons);
  if (manifest.action) push(manifest.action.default_icon);
  if (manifest.browser_action) push(manifest.browser_action.default_icon);
  if (manifest.page_action) push(manifest.page_action.default_icon);
  candidates.sort((a, b) => b.size - a.size);
  for (const candidate of candidates) {
    const file = localizeText(candidate.file, messages);
    const full = path.resolve(extensionDir, file);
    if (!full.startsWith(path.resolve(extensionDir))) continue;
    if (!fs.existsSync(full)) continue;
    const dataUrl = fileToDataUrl(full);
    if (dataUrl) return dataUrl;
  }
  return '';
}

function readExtensionMeta(extensionDir) {
  const manifestPath = path.join(extensionDir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`manifest.json 读取失败：${error.message}`);
  }
  if (!manifest || !manifest.manifest_version) {
    throw new Error('manifest.json 缺少 manifest_version');
  }
  const messages = readLocaleMessages(extensionDir, manifest.default_locale);
  const name = localizeText(manifest.name, messages) || path.basename(extensionDir);
  const description = localizeText(manifest.description, messages);
  return {
    name,
    version: String(manifest.version || '0.0.0'),
    description,
    manifestVersion: Number(manifest.manifest_version) || 3,
    icon: pickIcon(extensionDir, manifest, messages),
    size: dirSize(extensionDir)
  };
}

function importExtensionFromPath(sourcePath, extensionsRoot) {
  const stat = fs.statSync(sourcePath);
  const id = randomId('ext_');
  const tempDir = path.join(extensionsRoot, `.tmp-${id}`);
  const destDir = path.join(extensionsRoot, id);
  ensureDir(extensionsRoot);

  try {
    let extensionRoot;
    if (stat.isDirectory()) {
      extensionRoot = findManifestRoot(sourcePath);
    } else {
      const ext = path.extname(sourcePath).toLowerCase();
      ensureDir(tempDir);
      if (ext === '.crx') {
        extractZipBuffer(crxToZipBuffer(sourcePath), tempDir);
      } else if (ext === '.zip') {
        extractZipBuffer(fs.readFileSync(sourcePath), tempDir);
      } else {
        throw new Error('仅支持 .crx、.zip 或扩展文件夹');
      }
      extensionRoot = findManifestRoot(tempDir);
    }

    const meta = readExtensionMeta(extensionRoot);
    fs.cpSync(extensionRoot, destDir, {
      recursive: true,
      filter: (src) => !src.includes(`${path.sep}.git${path.sep}`)
    });
    return {
      id,
      ...meta,
      path: destDir,
      source: path.basename(sourcePath),
      addedAt: Date.now()
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (fs.existsSync(destDir) && !fs.existsSync(path.join(destDir, 'manifest.json'))) {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
  }
}

module.exports = {
  importExtensionFromPath,
  readExtensionMeta,
  crxToZipBuffer,
  extractZipBuffer,
  findManifestRoot
};

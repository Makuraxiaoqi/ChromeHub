const path = require('node:path');
const fs = require('node:fs');
const { readJson, writeJsonAtomic, ensureDir } = require('./util');

function defaultSettings() {
  return {
    memoryMode: 'auto',
    jsHeapMb: 512,
    defaultWindowMode: 'visible',
    confirmOnClose: true,
    downloadDirMode: 'system',
    downloadCustomDir: '',
    downloadAsk: false
  };
}

function defaultState() {
  return {
    version: 1,
    settings: defaultSettings(),
    presets: [],
    extensions: [],
    scripts: [],
    profiles: []
  };
}

function normalizeScript(script) {
  return {
    id: String(script.id || ''),
    name: String(script.name || '未命名脚本'),
    version: String(script.version || '1.0.0'),
    namespace: String(script.namespace || ''),
    description: String(script.description || ''),
    matches: Array.isArray(script.matches) && script.matches.length ? script.matches.map(String) : ['*://*/*'],
    excludes: Array.isArray(script.excludes) ? script.excludes.map(String) : [],
    runAt: String(script.runAt || 'document-start'),
    code: String(script.code || ''),
    enabled: script.enabled !== false,
    createdAt: Number(script.createdAt) || Date.now(),
    updatedAt: Number(script.updatedAt) || Date.now()
  };
}

function normalizeProfile(profile) {
  return {
    id: String(profile.id || ''),
    name: String(profile.name || '未命名浏览器'),
    note: String(profile.note || ''),
    group: String(profile.group || ''),
    presetId: String(profile.presetId || ''),
    windowMode: profile.windowMode === 'hidden' ? 'hidden' : 'visible',
    memoryMode: ['inherit', 'auto', 'balanced', 'saver', 'extreme'].includes(profile.memoryMode)
      ? profile.memoryMode
      : 'inherit',
    extensions: Array.isArray(profile.extensions) ? [...new Set(profile.extensions.map(String))] : [],
    scripts: Array.isArray(profile.scripts) ? [...new Set(profile.scripts.map(String))] : [],
    startupUrls: Array.isArray(profile.startupUrls) ? profile.startupUrls.map(String).filter(Boolean) : [],
    extraArgs: String(profile.extraArgs || ''),
    keepAlive: profile.keepAlive !== false,
    createdAt: Number(profile.createdAt) || Date.now(),
    lastLaunchedAt: Number(profile.lastLaunchedAt) || 0
  };
}

function normalizePreset(preset) {
  return {
    id: String(preset.id || ''),
    name: String(preset.name || '未命名预设'),
    description: String(preset.description || ''),
    windowMode: preset.windowMode === 'hidden' ? 'hidden' : 'visible',
    memoryMode: ['auto', 'balanced', 'saver', 'extreme'].includes(preset.memoryMode) ? preset.memoryMode : 'auto',
    extensions: Array.isArray(preset.extensions) ? [...new Set(preset.extensions.map(String))] : [],
    scripts: Array.isArray(preset.scripts) ? [...new Set(preset.scripts.map(String))] : [],
    startupUrls: Array.isArray(preset.startupUrls) ? preset.startupUrls.map(String).filter(Boolean) : [],
    extraArgs: String(preset.extraArgs || ''),
    keepAlive: preset.keepAlive !== false,
    createdAt: Number(preset.createdAt) || Date.now(),
    updatedAt: Number(preset.updatedAt) || Date.now()
  };
}

function normalizeState(raw) {
  const state = defaultState();
  if (!raw || typeof raw !== 'object') return state;
  state.settings = { ...state.settings, ...(raw.settings || {}) };
  state.presets = Array.isArray(raw.presets) ? raw.presets.map(normalizePreset).filter((item) => item.id) : [];
  state.extensions = Array.isArray(raw.extensions)
    ? raw.extensions.map((item) => ({
        id: String(item.id || ''),
        name: String(item.name || '未命名扩展'),
        version: String(item.version || '0.0.0'),
        description: String(item.description || ''),
        manifestVersion: Number(item.manifestVersion) || 3,
        icon: String(item.icon || ''),
        size: Number(item.size) || 0,
        source: String(item.source || ''),
        path: String(item.path || ''),
        addedAt: Number(item.addedAt) || Date.now()
      })).filter((item) => item.id && item.path)
    : [];
  state.scripts = Array.isArray(raw.scripts) ? raw.scripts.map(normalizeScript).filter((item) => item.id) : [];
  state.profiles = Array.isArray(raw.profiles) ? raw.profiles.map(normalizeProfile).filter((item) => item.id) : [];
  if (!['auto', 'balanced', 'saver', 'extreme'].includes(state.settings.memoryMode)) state.settings.memoryMode = 'auto';
  const heap = Number(state.settings.jsHeapMb);
  state.settings.jsHeapMb = Number.isFinite(heap) && heap >= 0 ? heap : 512;
  if (!['visible', 'hidden'].includes(state.settings.defaultWindowMode)) state.settings.defaultWindowMode = 'visible';
  if (!['system', 'profile', 'custom'].includes(state.settings.downloadDirMode)) state.settings.downloadDirMode = 'system';
  state.settings.downloadCustomDir = String(state.settings.downloadCustomDir || '');
  state.settings.downloadAsk = state.settings.downloadAsk === true;
  return state;
}

class StateStore {
  constructor(userDataDir) {
    this.dir = userDataDir;
    this.file = path.join(userDataDir, 'state.json');
    this.state = defaultState();
    this.saveChain = Promise.resolve();
  }

  load() {
    ensureDir(this.dir);
    const raw = readJson(this.file, null);
    this.state = normalizeState(raw);
    if (!raw) {
      this.save(this.state).catch(() => {});
    }
    return this.state;
  }

  get() {
    return this.state;
  }

  set(raw) {
    this.state = normalizeState(raw);
    return this.state;
  }

  save(raw) {
    if (raw) this.state = normalizeState(raw);
    const snapshot = this.state;
    this.saveChain = this.saveChain
      .then(() => writeJsonAtomic(this.file, snapshot))
      .catch((error) => console.error('保存状态失败', error));
    return this.saveChain.then(() => snapshot);
  }

  backup() {
    try {
      if (fs.existsSync(this.file)) {
        const backupFile = `${this.file}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
        fs.copyFileSync(this.file, backupFile);
      }
    } catch {
      /* ignore */
    }
  }
}

module.exports = {
  StateStore,
  defaultState,
  defaultSettings,
  normalizeState,
  normalizeProfile,
  normalizePreset,
  normalizeScript
};

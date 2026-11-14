const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { ensureDir } = require('./util');
const { buildChromiumArgs, effectiveMemoryMode } = require('./flags');
const { buildInjection } = require('./scripts');
const { chromiumStatus } = require('./chromium');

function normalizeStartupUrl(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  if (/^(https?|file|about|chrome|data):/i.test(url)) return url;
  return `https://${url}`;
}

function safeDownloadName(value) {
  let name = path
    .basename(String(value || '').replace(/\\/g, '/'))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  if (!name) name = 'download';
  if (name.length > 180) name = name.slice(0, 180);
  return name;
}

function uniqueDownloadPath(dir, fileName, reserved) {
  const candidate = path.join(dir, fileName);
  if (!fs.existsSync(candidate) && !reserved.has(candidate)) return candidate;
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length) || 'download';
  let index = 1;
  let next = path.join(dir, `${stem} (${index})${ext}`);
  while (fs.existsSync(next) || reserved.has(next)) {
    index += 1;
    next = path.join(dir, `${stem} (${index})${ext}`);
  }
  return next;
}

class BrowserRuntime {
  constructor({ getState, userDataDir, systemDownloadsDir, onEvent, onDownloadPath }) {
    this.getState = getState;
    this.userDataDir = userDataDir;
    this.systemDownloadsDir = systemDownloadsDir || path.join(userDataDir, 'Downloads');
    this.onEvent = onEvent;
    this.onDownloadPath = onDownloadPath;
    this.reservedDownloads = new Set();
    this.sessions = new Map();
    this.states = new Map();
    this.launching = new Set();
    this.quitting = false;
  }

  profileDir(profileId) {
    return path.join(this.userDataDir, 'profiles', profileId);
  }

  downloadsDir(profileId) {
    return path.join(this.profileDir(profileId), 'Downloads');
  }

  tempDownloadsDir(profileId) {
    return path.join(this.profileDir(profileId), '.downloads-tmp');
  }

  resolveDownloadDir(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const expanded =
      raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')
        ? path.join(os.homedir(), raw.slice(1))
        : raw;
    return path.resolve(expanded);
  }

  downloadDirMode() {
    const mode = this.getState().settings?.downloadDirMode;
    return ['system', 'profile', 'custom'].includes(mode) ? mode : 'system';
  }

  downloadsRoot() {
    const settings = this.getState().settings || {};
    const mode = this.downloadDirMode();
    if (mode === 'profile') return path.join(this.userDataDir, 'profiles');
    if (mode === 'custom') return this.resolveDownloadDir(settings.downloadCustomDir) || this.systemDownloadsDir;
    return this.systemDownloadsDir;
  }

  downloadDir(profileId) {
    return this.downloadDirMode() === 'profile' ? this.downloadsDir(profileId) : this.downloadsRoot();
  }

  status() {
    return [...this.states.values()].map((item) => ({ ...item }));
  }

  emit() {
    this.onEvent?.({ type: 'status', status: this.status() });
  }

  setState(profileId, patch) {
    const current = this.states.get(profileId) || { profileId, state: 'stopped', pages: 0, startedAt: 0, error: '' };
    this.states.set(profileId, { ...current, ...patch, profileId });
    this.emit();
  }

  async launch(profileId) {
    if (this.quitting) throw new Error('应用正在退出');
    if (this.sessions.has(profileId) || this.launching.has(profileId)) {
      return this.states.get(profileId);
    }
    const state = this.getState();
    const profile = state.profiles.find((item) => item.id === profileId);
    if (!profile) throw new Error('浏览器配置不存在');
    const browserStatus = chromiumStatus();
    if (!browserStatus.exists) {
      throw new Error('浏览器内核未安装，请到设置页安装内置 Chromium');
    }

    this.launching.add(profileId);
    this.setState(profileId, {
      state: 'starting',
      pages: 0,
      startedAt: Date.now(),
      error: '',
      windowMode: profile.windowMode,
      memoryMode: effectiveMemoryMode(state.settings, profile)
    });

    const profileDir = ensureDir(this.profileDir(profileId));
    const tempDownloads = ensureDir(this.tempDownloadsDir(profileId));
    try {
      for (const name of fs.readdirSync(tempDownloads)) {
        try {
          fs.rmSync(path.join(tempDownloads, name), { recursive: true, force: true });
        } catch {
          /* 上次退出遗留的文件可能仍被占用 */
        }
      }
    } catch {
      /* ignore */
    }
    const extensionPaths = [];
    const warnings = [];
    for (const id of profile.extensions) {
      const ext = state.extensions.find((item) => item.id === id);
      if (!ext) {
        warnings.push('有扩展已被删除');
        continue;
      }
      if (!fs.existsSync(path.join(ext.path, 'manifest.json'))) {
        warnings.push(`扩展“${ext.name}”文件缺失`);
        continue;
      }
      extensionPaths.push(ext.path);
    }

    const scripts = state.scripts.filter((script) => profile.scripts.includes(script.id) && script.enabled !== false);
    const args = buildChromiumArgs({ settings: state.settings, profile, extensionPaths });
    const headless = profile.windowMode === 'hidden';

    let context;
    try {
      context = await chromium.launchPersistentContext(profileDir, {
        headless,
        channel: headless ? 'chromium' : undefined,
        viewport: null,
        acceptDownloads: true,
        downloadsPath: tempDownloads,
        ignoreDefaultArgs: ['--enable-automation', '--disable-extensions'],
        args,
        timeout: 60000
      });
    } catch (error) {
      this.launching.delete(profileId);
      this.setState(profileId, { state: 'error', error: error.message, pages: 0 });
      throw error;
    }

    const session = {
      profile,
      context,
      pages: new Set(),
      cdp: new Map(),
      stopping: false,
      startedAt: Date.now(),
      warnings
    };
    this.sessions.set(profileId, session);
    this.launching.delete(profileId);

    context.on('close', () => {
      if (this.sessions.get(profileId) !== session) return;
      this.sessions.delete(profileId);
      for (const cdp of session.cdp.values()) {
        try {
          cdp.detach().catch(() => {});
        } catch {
          /* ignore */
        }
      }
      session.cdp.clear();
      this.setState(profileId, {
        state: 'stopped',
        pages: 0,
        stoppedAt: Date.now(),
        error: session.lastError || '',
        windowMode: profile.windowMode
      });
    });
    context.on('page', (page) => this.attachPage(session, page));

    const injection = buildInjection(scripts);
    if (injection) {
      await context.addInitScript({ content: injection });
    }

    for (const page of context.pages()) {
      this.attachPage(session, page);
    }

    this.setState(profileId, {
      state: 'running',
      pages: context.pages().length,
      startedAt: session.startedAt,
      windowMode: profile.windowMode,
      memoryMode: effectiveMemoryMode(state.settings, profile),
      warnings: warnings.length ? warnings : undefined,
      error: ''
    });

    const startupUrls = (profile.startupUrls || []).map(normalizeStartupUrl).filter(Boolean);
    const pages = context.pages();
    const firstPage = pages[0] || await context.newPage();
    if (startupUrls.length) {
      await firstPage.goto(startupUrls[0], { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((error) => {
        session.lastError = `打开 ${startupUrls[0]} 失败：${error.message}`;
      });
      for (const url of startupUrls.slice(1)) {
        const page = await context.newPage();
        page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      }
    }
    this.refreshPageCount(session);
    return this.states.get(profileId);
  }

  attachPage(session, page) {
    if (!session.pages.has(page)) {
      session.pages.add(page);
      page.on('download', (download) => {
        this.handleDownload(session, download).catch((error) => {
          this.onEvent?.({ type: 'download', profileId: session.profile.id, error: error.message });
        });
      });
      page.once('close', () => {
        session.pages.delete(page);
        session.cdp.delete(page);
        this.refreshPageCount(session);
        this.maybeReopen(session);
      });
      page.on('crash', () => {
        session.lastError = '页面进程崩溃，正在尝试重建';
        session.pages.delete(page);
        this.refreshPageCount(session);
        page.close().catch(() => {}).finally(() => this.maybeReopen(session));
      });
    }
    this.refreshPageCount(session);
  }

  async handleDownload(session, download) {
    const settings = this.getState().settings || {};
    const profileId = session.profile.id;
    const dir = ensureDir(this.downloadDir(profileId));
    const suggested = safeDownloadName(download.suggestedFilename());
    let target = '';

    if (settings.downloadAsk && typeof this.onDownloadPath === 'function') {
      const chosen = await this.onDownloadPath({
        profileId,
        profileName: session.profile.name,
        suggestedName: suggested,
        directory: dir
      });
      if (!chosen) {
        try {
          if (typeof download.cancel === 'function') await download.cancel();
          else await download.delete();
        } catch {
          /* ignore */
        }
        return;
      }
      target = path.resolve(String(chosen));
      ensureDir(path.dirname(target));
    } else {
      target = uniqueDownloadPath(dir, suggested, this.reservedDownloads);
    }

    this.reservedDownloads.add(target);
    try {
      await download.saveAs(target);
      this.onEvent?.({
        type: 'download',
        profileId,
        fileName: path.basename(target),
        path: target
      });
    } finally {
      this.reservedDownloads.delete(target);
      try {
        await download.delete();
      } catch {
        /* 临时文件可能已被清理 */
      }
    }
  }

  refreshPageCount(session) {
    const profileId = session.profile.id;
    if (this.sessions.get(profileId) !== session) return;
    this.setState(profileId, {
      pages: [...session.pages].filter((page) => !page.isClosed()).length,
      windowMode: session.profile.windowMode
    });
  }

  maybeReopen(session) {
    if (session.stopping || this.quitting) return;
    if (!session.profile.keepAlive) return;
    if (this.sessions.get(session.profile.id) !== session) return;
    setTimeout(async () => {
      if (session.stopping || this.quitting) return;
      if (this.sessions.get(session.profile.id) !== session) return;
      const alive = [...session.pages].filter((page) => !page.isClosed());
      if (alive.length > 0) return;
      try {
        const page = await session.context.newPage();
        this.attachPage(session, page);
        const url = (session.profile.startupUrls || []).map(normalizeStartupUrl).filter(Boolean)[0];
        if (url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      } catch {
        /* browser may have exited */
      }
    }, 800);
  }

  async stop(profileId) {
    const session = this.sessions.get(profileId);
    if (!session) {
      this.setState(profileId, { state: 'stopped', pages: 0 });
      return;
    }
    session.stopping = true;
    this.setState(profileId, { state: 'stopping', pages: 0 });
    try {
      await Promise.race([
        session.context.close(),
        new Promise((resolve) => setTimeout(resolve, 8000))
      ]);
    } catch {
      /* ignore */
    }
    this.sessions.delete(profileId);
    this.setState(profileId, { state: 'stopped', pages: 0, stoppedAt: Date.now() });
  }

  async stopAll() {
    this.quitting = true;
    const ids = [...this.sessions.keys()];
    await Promise.allSettled(ids.map((id) => this.stop(id)));
    this.quitting = false;
  }

  async metrics(profileId) {
    const session = this.sessions.get(profileId);
    if (!session) return null;
    let heap = 0;
    let nodes = 0;
    let documents = 0;
    let pageCount = 0;
    const pages = [];
    for (const page of session.context.pages()) {
      if (page.isClosed()) continue;
      pageCount += 1;
      pages.push({ url: page.url() });
      try {
        let cdp = session.cdp.get(page);
        if (!cdp) {
          cdp = await session.context.newCDPSession(page);
          session.cdp.set(page, cdp);
          await cdp.send('Performance.enable').catch(() => {});
        }
        const perf = await cdp.send('Performance.getMetrics');
        const map = Object.fromEntries((perf.metrics || []).map((item) => [item.name, item.value]));
        heap += Number(map.JSHeapUsedSize) || 0;
        const dom = await cdp.send('Memory.getDOMCounters').catch(() => null);
        if (dom) {
          nodes += Number(dom.nodes) || 0;
          documents += Number(dom.documents) || 0;
        }
      } catch {
        /* page may have navigated or closed */
      }
    }
    return {
      profileId,
      pages: pageCount,
      heapBytes: heap,
      nodes,
      documents,
      pageUrls: pages,
      memoryMode: effectiveMemoryMode(this.getState().settings, session.profile)
    };
  }

  async metricsAll() {
    const result = {};
    for (const profileId of this.sessions.keys()) {
      try {
        const item = await this.metrics(profileId);
        if (item) result[profileId] = item;
      } catch {
        /* ignore */
      }
    }
    return result;
  }

  isRunning(profileId) {
    return this.sessions.has(profileId);
  }
}

module.exports = {
  BrowserRuntime,
  normalizeStartupUrl
};

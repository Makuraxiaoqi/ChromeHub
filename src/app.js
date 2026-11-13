(() => {
  'use strict';

  const api = window.api;
  const ICONS = window.ICONS || {};

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
  const icon = (name) => ICONS[name] || '';
  const uid = (prefix = 'id_') => `${prefix}${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const clone = (value) => JSON.parse(JSON.stringify(value));

  const MEMORY_MODES = {
    auto: { label: '自动', hint: '前台均衡 · 后台省内存', desc: '前台窗口保留 GPU；后台常驻自动关闭 GPU、限制渲染进程。' },
    balanced: { label: '均衡', hint: '性能优先', desc: '保留 GPU 与站点隔离，只关闭后台服务，适合日常登录和调试。' },
    saver: { label: '省内存', hint: '推荐多开', desc: '关闭 GPU、限制渲染进程、关闭站点隔离，多开时明显省内存。' },
    extreme: { label: '极限', hint: '压缩到最小', desc: '单渲染进程 + 关闭 GPU，最省内存，复杂页面可能变慢。' }
  };

  const STATUS_TEXT = {
    running: '运行中',
    starting: '启动中',
    stopping: '停止中',
    stopped: '已停止',
    error: '启动失败'
  };

  let state = null;
  let info = null;
  let runtimeStatus = [];
  let metrics = {};
  let currentView = 'profiles';
  let profileFilter = { search: '', status: 'all' };
  let installProgress = null;
  let installing = false;
  let metricsTimer = null;
  let modalEscHandler = null;

  function ensureState(raw) {
    const next = raw && typeof raw === 'object' ? raw : {};
    next.settings = Object.assign({ memoryMode: 'auto', jsHeapMb: 512, defaultWindowMode: 'visible' }, next.settings || {});
    next.presets = Array.isArray(next.presets) ? next.presets : [];
    next.extensions = Array.isArray(next.extensions) ? next.extensions : [];
    next.scripts = Array.isArray(next.scripts) ? next.scripts : [];
    next.profiles = Array.isArray(next.profiles) ? next.profiles : [];
    return next;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
  }

  function formatMb(bytes) {
    const mb = (Number(bytes) || 0) / 1048576;
    if (mb <= 0) return '—';
    return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
  }

  function formatDate(ts) {
    if (!ts) return '—';
    try {
      return new Date(ts).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
    } catch {
      return '—';
    }
  }

  function firstChar(name) {
    const chars = [...String(name || 'B').trim()];
    return chars[0] || 'B';
  }

  function statusFor(id) {
    return runtimeStatus.find((item) => item.profileId === id) || { profileId: id, state: 'stopped', pages: 0 };
  }

  function isActiveStatus(status) {
    return status === 'running' || status === 'starting' || status === 'stopping';
  }

  function presetById(id) {
    return state.presets.find((item) => item.id === id) || null;
  }

  function extensionById(id) {
    return state.extensions.find((item) => item.id === id) || null;
  }

  function scriptById(id) {
    return state.scripts.find((item) => item.id === id) || null;
  }

  function profileById(id) {
    return state.profiles.find((item) => item.id === id) || null;
  }

  function totalHeap() {
    return Object.values(metrics).reduce((sum, item) => sum + (Number(item.heapBytes) || 0), 0);
  }

  function totalPages() {
    return runtimeStatus.reduce((sum, item) => sum + (item.state === 'running' ? Number(item.pages) || 0 : 0), 0);
  }

  function runningProfiles() {
    return runtimeStatus.filter((item) => isActiveStatus(item.state));
  }

  async function persist() {
    state = ensureState(await api.saveState(state));
  }

  function setHeader(title, subtitle, actions = '') {
    $('#viewTitle').textContent = title;
    $('#viewSubtitle').textContent = subtitle;
    $('#viewActions').innerHTML = actions;
  }

  function toast(message, type = 'success') {
    const root = $('#toastRoot');
    const el = document.createElement('div');
    el.className = `toast ${type === 'error' ? 'error' : type === 'info' ? 'info' : ''}`;
    el.innerHTML = `${icon(type === 'error' ? 'alert' : type === 'info' ? 'alert' : 'check')}<span>${esc(message)}</span>`;
    root.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity .2s';
      setTimeout(() => el.remove(), 220);
    }, 4200);
    el.addEventListener('click', () => el.remove());
  }

  function confirmDialog({ title, message, confirmText = '确定', cancelText = '取消', danger = false }) {
    return new Promise((resolve) => {
      const root = $('#dialogRoot');
      root.innerHTML = `<div class="confirm-overlay">
        <div class="confirm" role="dialog" aria-modal="true">
          <h3>${esc(title)}</h3>
          <p>${esc(message)}</p>
          <div class="confirm-actions">
            <button class="btn btn-ghost" data-confirm-cancel>${esc(cancelText)}</button>
            <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-confirm-ok>${esc(confirmText)}</button>
          </div>
        </div>
      </div>`;
      const done = (value) => {
        root.innerHTML = '';
        document.removeEventListener('keydown', onKey);
        resolve(value);
      };
      const onKey = (event) => {
        if (event.key === 'Escape') done(false);
      };
      document.addEventListener('keydown', onKey);
      $('[data-confirm-cancel]', root).onclick = () => done(false);
      $('[data-confirm-ok]', root).onclick = () => done(true);
      $('.confirm-overlay', root).addEventListener('click', (event) => {
        if (event.target === event.currentTarget) done(false);
      });
      $('[data-confirm-ok]', root).focus();
    });
  }

  function closeModal() {
    $('#modalRoot').innerHTML = '';
    if (modalEscHandler) {
      document.removeEventListener('keydown', modalEscHandler);
      modalEscHandler = null;
    }
  }

  function openModal({ title, subtitle = '', body, footer = '', wide = false, narrow = false, onMount }) {
    closeModal();
    const root = $('#modalRoot');
    root.innerHTML = `<div class="modal-overlay">
      <div class="modal ${wide ? 'wide' : ''} ${narrow ? 'narrow' : ''}" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div>
            <h2>${esc(title)}</h2>
            ${subtitle ? `<p>${esc(subtitle)}</p>` : ''}
          </div>
          <div class="spacer"></div>
          <button class="icon-btn" data-modal-close title="关闭">${icon('close')}</button>
        </div>
        <div class="modal-body">${body}</div>
        ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
      </div>
    </div>`;
    const overlay = $('.modal-overlay', root);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closeModal();
    });
    $('[data-modal-close]', root).onclick = closeModal;
    modalEscHandler = (event) => {
      if (event.key === 'Escape') closeModal();
    };
    document.addEventListener('keydown', modalEscHandler);
    onMount?.(root);
    const focusable = $('input:not([type=radio]):not([type=checkbox]), textarea, select', root);
    setTimeout(() => focusable?.focus(), 30);
  }

  function updateSidebar() {
    const active = runningProfiles();
    const badge = $('#navRunningBadge');
    badge.hidden = active.length === 0;
    badge.textContent = active.length;
    const pages = totalPages();
    $('#memorySummary').textContent = `${active.length} 个运行中 · ${pages} 个常驻页面`;
    const heap = totalHeap();
    $('#memoryHeap').textContent = heap ? formatMb(heap) : '0 MB';
    $('#memoryBarFill').style.width = `${Math.min(100, (heap / 1048576 / 2048) * 100)}%`;
    $('#stopAllBtn').disabled = active.length === 0;
  }

  function updateRuntimeUI() {
    updateSidebar();
    if (currentView === 'profiles') {
      renderStats();
      updateBrowserCards();
    }
  }

  async function refreshMetrics() {
    if (runningProfiles().length === 0) {
      metrics = {};
      updateRuntimeUI();
      return;
    }
    try {
      metrics = await api.getMetrics();
    } catch {
      metrics = {};
    }
    updateRuntimeUI();
  }

  function scheduleMetrics() {
    if (metricsTimer) clearInterval(metricsTimer);
    metricsTimer = setInterval(refreshMetrics, 5000);
  }

  function switchView(view) {
    currentView = view;
    $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
    renderView();
  }

  function renderView() {
    updateSidebar();
    if (currentView === 'profiles') renderProfiles();
    else if (currentView === 'presets') renderPresets();
    else if (currentView === 'extensions') renderExtensions();
    else if (currentView === 'scripts') renderScripts();
    else if (currentView === 'settings') renderSettings();
  }

  /* ------------------------------ profiles ------------------------------ */

  function renderProfiles() {
    setHeader(
      '浏览器',
      '每个浏览器都有独立的 Cookie、缓存与登录状态，重新打开会保留',
      `<button class="btn btn-ghost" data-act="refresh-profiles">${icon('refresh')}刷新</button>
       <button class="btn btn-primary" data-act="new-profile">${icon('plus')}新建浏览器</button>`
    );
    const missing = info && info.browser && !info.browser.exists;
    $('#viewRoot').innerHTML = `
      ${missing ? `<div class="banner warn">${icon('alert')}<div>尚未安装内置 Chromium。浏览器多开与 CRX 扩展加载依赖它，首次使用需要下载约 215 MB。<div class="spacer"></div></div><button class="btn" data-act="go-settings">去安装</button></div>` : ''}
      <div class="stats-strip" id="profileStats"></div>
      <div class="toolbar">
        <div class="search">
          <span class="search-icon">${icon('search')}</span>
          <input class="input" id="profileSearch" placeholder="搜索名称、分组或备注" value="${esc(profileFilter.search)}" />
        </div>
        <div class="segmented" id="profileStatusFilter">
          ${[
            ['all', '全部'],
            ['running', '运行中'],
            ['stopped', '已停止']
          ].map(([key, label]) => `<button data-status="${key}" class="${profileFilter.status === key ? 'active' : ''}">${label}</button>`).join('')}
        </div>
      </div>
      <div id="profileGrid"></div>`;

    $('#profileSearch').addEventListener('input', (event) => {
      profileFilter.search = event.target.value;
      renderProfileGrid();
    });
    $('#profileStatusFilter').addEventListener('click', (event) => {
      const button = event.target.closest('[data-status]');
      if (!button) return;
      profileFilter.status = button.dataset.status;
      $$('#profileStatusFilter button').forEach((item) => item.classList.toggle('active', item === button));
      renderProfileGrid();
    });
    renderStats();
    renderProfileGrid();
  }

  function renderStats() {
    const container = $('#profileStats');
    if (!container) return;
    const active = runningProfiles();
    const pages = totalPages();
    const heap = totalHeap();
    container.innerHTML = `
      <div class="stat"><label>浏览器</label><strong>${state.profiles.length}<small>个</small></strong></div>
      <div class="stat"><label>运行中</label><strong>${active.length}<small>个</small></strong></div>
      <div class="stat"><label>常驻页面</label><strong>${pages}<small>个</small></strong></div>
      <div class="stat"><label>页面 JS 堆</label><strong>${heap ? formatMb(heap) : '0 MB'}</strong></div>`;
  }

  function renderProfileGrid() {
    const grid = $('#profileGrid');
    if (!grid) return;
    const search = profileFilter.search.trim().toLowerCase();
    const profiles = state.profiles.filter((profile) => {
      const status = statusFor(profile.id);
      if (profileFilter.status === 'running' && !isActiveStatus(status.state)) return false;
      if (profileFilter.status === 'stopped' && isActiveStatus(status.state)) return false;
      if (!search) return true;
      return [profile.name, profile.group, profile.note, presetById(profile.presetId)?.name]
        .filter(Boolean).some((value) => String(value).toLowerCase().includes(search));
    });

    if (state.profiles.length === 0) {
      grid.innerHTML = `<div class="empty">
        <div class="empty-icon">${icon('browser')}</div>
        <h3>还没有浏览器</h3>
        <p>新建一个独立浏览器，并在创建时选择要预装的 CRX 扩展、用户脚本与启动页面。Cookie、缓存和登录状态会单独保存在该浏览器自己的目录里。</p>
        <button class="btn btn-primary" data-act="new-profile">${icon('plus')}新建浏览器</button>
        <button class="btn" data-act="new-preset">创建预设</button>
      </div>`;
      return;
    }
    if (profiles.length === 0) {
      grid.innerHTML = `<div class="empty"><div class="empty-icon">${icon('search')}</div><h3>没有匹配的浏览器</h3><p>换个关键词或切换状态筛选试试。</p></div>`;
      return;
    }
    grid.innerHTML = `<div class="grid">${profiles.map(browserCard).join('')}</div>`;
  }

  function browserCard(profile) {
    const status = statusFor(profile.id);
    const metric = metrics[profile.id];
    const preset = presetById(profile.presetId);
    const heap = metric?.heapBytes || 0;
    const pages = metric?.pages ?? (status.pages || 0);
    const active = isActiveStatus(status.state);
    const busy = status.state === 'starting' || status.state === 'stopping';
    const memMode = status.memoryMode || profile.memoryMode || 'inherit';
    const memLabel = memMode === 'inherit' ? '跟随全局' : (MEMORY_MODES[memMode]?.label || memMode);
    return `<article class="card browser-card ${status.state === 'running' ? 'is-running' : ''} ${status.state === 'error' ? 'is-error' : ''}" data-id="${esc(profile.id)}">
      <div class="card-head">
        <div class="avatar">${esc(firstChar(profile.name))}</div>
        <div class="card-title">
          <h3 title="${esc(profile.name)}">${esc(profile.name)}</h3>
          <p>${esc(profile.note || profile.group || '独立 Cookie 与登录状态')}</p>
        </div>
        <span class="status-pill ${esc(status.state)}">${STATUS_TEXT[status.state] || '已停止'}</span>
      </div>
      <div class="chips">
        ${preset ? `<span class="chip accent">${esc(preset.name)}</span>` : ''}
        <span class="chip">${profile.windowMode === 'hidden' ? '后台常驻' : '前台窗口'}</span>
        <span class="chip">${esc(memLabel)}</span>
        <span class="chip">${profile.extensions.length} 个扩展</span>
        <span class="chip">${profile.scripts.length} 个脚本</span>
      </div>
      <div class="card-meta">
        <span>页面 <strong>${pages}</strong> · JS 堆 <strong>${heap ? formatMb(heap) : '—'}</strong></span>
        <span>${profile.keepAlive ? '页面保活' : '普通模式'}</span>
      </div>
      ${status.error ? `<div class="error-text">${esc(status.error)}</div>` : ''}
      ${status.warnings?.length ? `<div class="warn-text">${esc(status.warnings.join('；'))}</div>` : ''}
      <div class="card-actions">
        <button class="btn ${active ? 'btn-danger' : 'btn-primary'}" data-act="toggle-profile" ${busy ? 'disabled' : ''}>
          ${icon(active ? 'stop' : 'play')}${busy ? STATUS_TEXT[status.state] : active ? '停止' : '启动'}
        </button>
        <button class="btn btn-ghost" data-act="edit-profile">${icon('edit')}编辑</button>
        <div class="spacer"></div>
        <button class="icon-btn" data-act="open-profile-data" title="打开数据目录">${icon('folder')}</button>
        <button class="icon-btn danger" data-act="delete-profile" title="删除浏览器">${icon('trash')}</button>
      </div>
    </article>`;
  }

  function updateBrowserCards() {
    const grid = $('#profileGrid');
    if (!grid) return;
    $$('.browser-card', grid).forEach((card) => {
      const profile = profileById(card.dataset.id);
      if (!profile) return;
      const template = document.createElement('template');
      template.innerHTML = browserCard(profile).trim();
      const next = template.content.firstElementChild;
      if (next) card.replaceWith(next);
    });
  }

  function newProfileModel(preset = null) {
    const model = {
      id: uid('p_'),
      name: '',
      note: '',
      group: '',
      presetId: '',
      windowMode: state.settings.defaultWindowMode || 'visible',
      memoryMode: 'inherit',
      extensions: [],
      scripts: [],
      startupUrls: [],
      extraArgs: '',
      keepAlive: true,
      createdAt: Date.now()
    };
    if (preset) {
      model.presetId = preset.id;
      model.windowMode = preset.windowMode;
      model.memoryMode = 'inherit';
      model.extensions = [...preset.extensions];
      model.scripts = [...preset.scripts];
      model.startupUrls = [...preset.startupUrls];
      model.extraArgs = preset.extraArgs;
      model.keepAlive = preset.keepAlive;
      model.name = `${preset.name} 浏览器`;
    }
    return model;
  }

  function browserFormBody(model, isEdit) {
    const presets = state.presets.map((preset) => `<option value="${esc(preset.id)}" ${model.presetId === preset.id ? 'selected' : ''}>${esc(preset.name)}</option>`).join('');
    const extensionRows = state.extensions.length
      ? state.extensions.map((ext) => `<label class="picker-row">
          <input type="checkbox" data-ext-pick value="${esc(ext.id)}" ${model.extensions.includes(ext.id) ? 'checked' : ''} />
          <span class="picker-icon">${ext.icon ? `<img src="${esc(ext.icon)}" alt="" />` : icon('puzzle')}</span>
          <span class="picker-text"><strong>${esc(ext.name)}</strong><span>v${esc(ext.version)} · ${formatBytes(ext.size)}</span></span>
        </label>`).join('')
      : `<div class="picker-empty">扩展库还是空的。导入 CRX / ZIP 后就能在预设里勾选。</div>`;
    const scriptRows = state.scripts.length
      ? state.scripts.map((script) => `<label class="picker-row">
          <input type="checkbox" data-script-pick value="${esc(script.id)}" ${model.scripts.includes(script.id) ? 'checked' : ''} ${script.enabled === false ? 'disabled' : ''} />
          <span class="picker-icon">${icon('code')}</span>
          <span class="picker-text"><strong>${esc(script.name)} ${script.enabled === false ? '（已停用）' : ''}</strong><span>${esc((script.matches || []).join(' · ') || '*://*/*')}</span></span>
        </label>`).join('')
      : `<div class="picker-empty">脚本库还是空的。新建脚本或导入 .user.js 后就能在预设里勾选。</div>`;

    return `<div class="form-stack" id="browserForm">
      <div class="form-section">
        <div class="field-row">
          <div class="field"><label>名称</label><input class="input" name="pf-name" value="${esc(model.name)}" placeholder="例如：课程 A / 采集 01" /></div>
          <div class="field"><label>分组（可选）</label><input class="input" name="pf-group" value="${esc(model.group)}" placeholder="例如：采集、课程、测试" /></div>
        </div>
        <div class="field" style="margin-top:12px"><label>备注（可选）</label><input class="input" name="pf-note" value="${esc(model.note)}" placeholder="这个浏览器用来做什么" /></div>
      </div>

      <div class="form-section">
        <div class="form-section-title">${icon('preset')}套用预设</div>
        <div class="field">
          <select class="select" data-role="preset-select">
            <option value="">不套用预设</option>
            ${presets}
          </select>
          <span class="field-hint">切换预设会覆盖下面的扩展、脚本、启动页和运行方式，仍可手动调整。</span>
        </div>
      </div>

      <div class="form-section">
        <div class="form-section-title">${icon('memory')}运行方式与内存</div>
        <div class="radio-cards">
          <label class="radio-card ${model.windowMode === 'visible' ? 'checked' : ''}">
            <input type="radio" name="pf-window" value="visible" ${model.windowMode === 'visible' ? 'checked' : ''} />
            <span><strong>前台窗口</strong><span>能看到页面，适合登录、验证码和调试。</span></span>
          </label>
          <label class="radio-card ${model.windowMode === 'hidden' ? 'checked' : ''}">
            <input type="radio" name="pf-window" value="hidden" ${model.windowMode === 'hidden' ? 'checked' : ''} />
            <span><strong>后台常驻</strong><span>无窗口运行，页面与脚本保持加载，最省内存。</span></span>
          </label>
        </div>
        <div class="field" style="margin-top:12px">
          <label>内存策略</label>
          <select class="select" name="pf-memory">
            ${['inherit', 'auto', 'balanced', 'saver', 'extreme'].map((key) => `<option value="${key}" ${model.memoryMode === key ? 'selected' : ''}>${key === 'inherit' ? '跟随全局设置' : MEMORY_MODES[key].label + ' · ' + MEMORY_MODES[key].hint}</option>`).join('')}
          </select>
        </div>
        <label class="check" style="margin-top:12px">
          <input type="checkbox" name="pf-keepalive" ${model.keepAlive ? 'checked' : ''} />
          <span><strong>页面保活</strong><span>最后一个页面被关掉时，自动重新打开启动页，让扩展和脚本继续常驻。</span></span>
        </label>
      </div>

      <div class="form-section">
        <div class="form-section-title">${icon('browser')}启动页面</div>
        <div class="field">
          <textarea class="textarea" name="pf-urls" placeholder="每行一个网址，例如：\nhttps://www.example.com\nhttps://admin.example.com">${esc((model.startupUrls || []).join('\n'))}</textarea>
          <span class="field-hint">每个网址会打开一个标签页。留空则打开 Chromium 新标签页。</span>
        </div>
      </div>

      <div class="form-section">
        <div class="form-section-title">${icon('puzzle')}预装扩展 <span class="muted" style="font-weight:400">（${model.extensions.length}）</span></div>
        <div class="picker">${extensionRows}</div>
        <span class="field-hint">扩展会以解压后的目录加载；CRX 导入时会自动解包。每次启动都会按这里的勾选加载。</span>
      </div>

      <div class="form-section">
        <div class="form-section-title">${icon('code')}注入脚本 <span class="muted" style="font-weight:400">（${model.scripts.length}）</span></div>
        <div class="picker">${scriptRows}</div>
        <span class="field-hint">脚本按 @match 自动注入页面；后台常驻时只要页面不关闭，脚本就会持续运行。</span>
      </div>

      <div class="form-section">
        <div class="form-section-title">${icon('settings')}高级</div>
        <div class="field">
          <label>额外 Chromium 启动参数</label>
          <textarea class="textarea code" name="pf-args" style="min-height:80px" placeholder="每行一个参数，例如：\n--lang=zh-CN\n--window-size=1440,900">${esc(model.extraArgs || '')}</textarea>
        </div>
      </div>
    </div>`;
  }

  function openBrowserModal({ profile = null, preset = null } = {}) {
    const isEdit = !!profile;
    const model = profile ? clone(profile) : newProfileModel(preset);
    const title = isEdit ? '编辑浏览器' : '新建浏览器';
    const subtitle = isEdit
      ? '修改只影响下一次启动；正在运行的浏览器需要停止后重新启动才会应用。'
      : '创建后立即拥有独立的 Cookie、缓存和登录状态，重新打开会自动恢复。';

    openModal({
      title,
      subtitle,
      wide: true,
      body: browserFormBody(model, isEdit),
      footer: `<button class="btn btn-danger ${isEdit ? '' : 'hidden'}" data-modal-action="delete">${icon('trash')}删除</button>
        <div class="spacer"></div>
        <button class="btn btn-ghost" data-modal-action="cancel">取消</button>
        <button class="btn" data-modal-action="save">保存</button>
        <button class="btn btn-primary" data-modal-action="save-launch">${icon('play')}保存并启动</button>`,
      onMount(root) {
        const form = $('[data-role="preset-select"]', root);
        form?.addEventListener('change', () => {
          const selected = state.presets.find((item) => item.id === form.value);
          if (!selected) {
            model.presetId = '';
            return;
          }
          const name = $('[name="pf-name"]', root)?.value ?? model.name;
          const group = $('[name="pf-group"]', root)?.value ?? model.group;
          const note = $('[name="pf-note"]', root)?.value ?? model.note;
          Object.assign(model, {
            presetId: selected.id,
            windowMode: selected.windowMode,
            extensions: [...selected.extensions],
            scripts: [...selected.scripts],
            startupUrls: [...selected.startupUrls],
            extraArgs: selected.extraArgs,
            keepAlive: selected.keepAlive,
            name, group, note
          });
          const body = $('.modal-body', root);
          body.innerHTML = browserFormBody(model, isEdit);
          bindBrowserForm(root, model, isEdit);
        });
        bindBrowserForm(root, model, isEdit);

        const collect = () => {
          const name = $('[name="pf-name"]', root).value.trim();
          if (!name) {
            toast('请填写浏览器名称', 'error');
            $('[name="pf-name"]', root).focus();
            return null;
          }
          return {
            ...model,
            name,
            group: $('[name="pf-group"]', root).value.trim(),
            note: $('[name="pf-note"]', root).value.trim(),
            presetId: $('[data-role="preset-select"]', root).value,
            windowMode: $('[name="pf-window"]:checked', root)?.value === 'hidden' ? 'hidden' : 'visible',
            memoryMode: $('[name="pf-memory"]', root).value,
            keepAlive: $('[name="pf-keepalive"]', root).checked,
            startupUrls: $('[name="pf-urls"]', root).value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
            extraArgs: $('[name="pf-args"]', root).value.trim(),
            extensions: $$('[data-ext-pick]:checked', root).map((item) => item.value),
            scripts: $$('[data-script-pick]:checked', root).map((item) => item.value)
          };
        };

        const save = async (launchAfter) => {
          const value = collect();
          if (!value) return;
          if (isEdit) {
            const index = state.profiles.findIndex((item) => item.id === value.id);
            if (index >= 0) state.profiles[index] = { ...state.profiles[index], ...value };
          } else {
            value.createdAt = Date.now();
            state.profiles.push(value);
          }
          try {
            await persist();
          } catch (error) {
            toast(`保存失败：${error.message}`, 'error');
            return;
          }
          closeModal();
          currentView = 'profiles';
          $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === 'profiles'));
          renderView();
          toast(isEdit ? '已保存浏览器配置' : '浏览器已创建');
          if (launchAfter) await launchProfile(value.id);
        };

        ($('.modal', root) || root).addEventListener('click', async (event) => {
          const action = event.target.closest('[data-modal-action]')?.dataset.modalAction;
          if (!action) return;
          if (action === 'cancel') closeModal();
          else if (action === 'save') await save(false);
          else if (action === 'save-launch') await save(true);
          else if (action === 'delete' && isEdit) {
            closeModal();
            await deleteProfile(model.id);
          }
        });
      }
    });
  }

  function bindBrowserForm(root, model, isEdit) {
    const updateWindowCards = () => {
      $$('.radio-card', root).forEach((card) => {
        const input = $('input[name="pf-window"]', card);
        card.classList.toggle('checked', !!input?.checked);
      });
    };
    $$('input[name="pf-window"]', root).forEach((input) => input.addEventListener('change', updateWindowCards));
  }

  async function launchProfile(id) {
    const profile = profileById(id);
    if (!profile) return;
    if (info?.browser && !info.browser.exists) {
      toast('浏览器内核未安装，请先到设置页安装', 'error');
      switchView('settings');
      return;
    }
    try {
      await persist();
      await api.launchProfile(id);
      profile.lastLaunchedAt = Date.now();
      await persist();
      toast('浏览器已启动，页面会保持常驻');
      await refreshMetrics();
    } catch (error) {
      toast(error.message || '启动失败', 'error');
    }
  }

  async function stopProfile(id) {
    try {
      await api.stopProfile(id);
      await refreshMetrics();
    } catch (error) {
      toast(error.message || '停止失败', 'error');
    }
  }

  async function deleteProfile(id) {
    const profile = profileById(id);
    if (!profile) return;
    const ok = await confirmDialog({
      title: '删除浏览器',
      message: `将删除“${profile.name}”及其独立的 Cookie、缓存、登录状态和本地数据，无法恢复。\n如果只是想释放内存，可以点“停止”而不是删除。`,
      confirmText: '删除',
      danger: true
    });
    if (!ok) return;
    try {
      await api.clearProfileData(id);
      state.profiles = state.profiles.filter((item) => item.id !== id);
      await persist();
      renderView();
      toast('浏览器已删除');
    } catch (error) {
      toast(`删除失败：${error.message}`, 'error');
    }
  }

  /* ------------------------------ presets ------------------------------ */

  function renderPresets() {
    setHeader('预设', '预设保存扩展、脚本、启动页与运行方式，新建浏览器时一键套用', `<button class="btn btn-primary" data-act="new-preset">${icon('plus')}新建预设</button>`);
    const cards = state.presets.map(presetCard).join('');
    $('#viewRoot').innerHTML = cards
      ? `<div class="grid">${cards}</div>`
      : `<div class="empty">
          <div class="empty-icon">${icon('preset')}</div>
          <h3>还没有预设</h3>
          <p>把常用的 CRX 扩展、用户脚本和启动页组合保存成预设。以后新建浏览器时选一下，就能自动装好同样的环境。</p>
          <button class="btn btn-primary" data-act="new-preset">${icon('plus')}新建预设</button>
        </div>`;
  }

  function presetCard(preset) {
    const extCount = (preset.extensions || []).filter((id) => extensionById(id)).length;
    const scriptCount = (preset.scripts || []).filter((id) => scriptById(id)).length;
    const mode = MEMORY_MODES[preset.memoryMode] || MEMORY_MODES.auto;
    return `<article class="card preset-card" data-id="${esc(preset.id)}">
      <div class="card-head">
        <div class="avatar">${esc(firstChar(preset.name))}</div>
        <div class="card-title"><h3>${esc(preset.name)}</h3><p>${preset.startupUrls?.length ? esc(preset.startupUrls.join(' · ')) : '未设置启动页'}</p></div>
        <span class="status-pill running">预设</span>
      </div>
      <p class="preset-desc">${esc(preset.description || '未填写说明')}</p>
      <div class="chips">
        <span class="chip">${preset.windowMode === 'hidden' ? '后台常驻' : '前台窗口'}</span>
        <span class="chip">${esc(mode.label)}</span>
        <span class="chip">${extCount} 个扩展</span>
        <span class="chip">${scriptCount} 个脚本</span>
      </div>
      <div class="card-actions">
        <button class="btn btn-primary" data-act="use-preset">${icon('plus')}用此预设新建</button>
        <div class="spacer"></div>
        <button class="icon-btn" data-act="edit-preset" title="编辑">${icon('edit')}</button>
        <button class="icon-btn danger" data-act="delete-preset" title="删除">${icon('trash')}</button>
      </div>
    </article>`;
  }

  function presetFormBody(model) {
    return `<div class="form-stack" id="presetForm">
      <div class="field-row">
        <div class="field"><label>预设名称</label><input class="input" name="ps-name" value="${esc(model.name)}" placeholder="例如：课程平台常驻" /></div>
        <div class="field"><label>说明（可选）</label><input class="input" name="ps-description" value="${esc(model.description)}" placeholder="这个预设装了什么" /></div>
      </div>
      <div class="form-section">
        <div class="form-section-title">${icon('memory')}默认运行方式</div>
        <div class="radio-cards">
          <label class="radio-card ${model.windowMode === 'visible' ? 'checked' : ''}"><input type="radio" name="ps-window" value="visible" ${model.windowMode === 'visible' ? 'checked' : ''} /><span><strong>前台窗口</strong><span>适合需要登录和人工操作的场景。</span></span></label>
          <label class="radio-card ${model.windowMode === 'hidden' ? 'checked' : ''}"><input type="radio" name="ps-window" value="hidden" ${model.windowMode === 'hidden' ? 'checked' : ''} /><span><strong>后台常驻</strong><span>无窗口运行，页面和脚本继续工作。</span></span></label>
        </div>
        <div class="field" style="margin-top:12px">
          <label>内存策略</label>
          <select class="select" name="ps-memory">
            ${['auto', 'balanced', 'saver', 'extreme'].map((key) => `<option value="${key}" ${model.memoryMode === key ? 'selected' : ''}>${MEMORY_MODES[key].label} · ${MEMORY_MODES[key].hint}</option>`).join('')}
          </select>
        </div>
        <label class="check" style="margin-top:12px"><input type="checkbox" name="ps-keepalive" ${model.keepAlive ? 'checked' : ''} /><span><strong>页面保活</strong><span>页面关闭后自动重建启动页，保持脚本和扩展常驻。</span></span></label>
      </div>
      <div class="form-section">
        <div class="form-section-title">${icon('browser')}启动页面</div>
        <textarea class="textarea" name="ps-urls" placeholder="每行一个网址">${esc((model.startupUrls || []).join('\n'))}</textarea>
      </div>
      <div class="form-section">
        <div class="form-section-title">${icon('puzzle')}扩展</div>
        <div class="picker">${state.extensions.length ? state.extensions.map((ext) => `<label class="picker-row"><input type="checkbox" data-ps-ext value="${esc(ext.id)}" ${model.extensions.includes(ext.id) ? 'checked' : ''} /><span class="picker-icon">${ext.icon ? `<img src="${esc(ext.icon)}" alt="" />` : icon('puzzle')}</span><span class="picker-text"><strong>${esc(ext.name)}</strong><span>v${esc(ext.version)}</span></span></label>`).join('') : `<div class="picker-empty">扩展库为空</div>`}</div>
      </div>
      <div class="form-section">
        <div class="form-section-title">${icon('code')}脚本</div>
        <div class="picker">${state.scripts.length ? state.scripts.map((script) => `<label class="picker-row"><input type="checkbox" data-ps-script value="${esc(script.id)}" ${model.scripts.includes(script.id) ? 'checked' : ''} /><span class="picker-icon">${icon('code')}</span><span class="picker-text"><strong>${esc(script.name)}</strong><span>${esc((script.matches || []).join(' · '))}</span></span></label>`).join('') : `<div class="picker-empty">脚本库为空</div>`}</div>
      </div>
      <div class="form-section">
        <div class="form-section-title">${icon('settings')}高级</div>
        <textarea class="textarea code" name="ps-args" style="min-height:80px" placeholder="每行一个 Chromium 启动参数">${esc(model.extraArgs || '')}</textarea>
      </div>
    </div>`;
  }

  function openPresetModal(preset = null) {
    const isEdit = !!preset;
    const model = preset ? clone(preset) : {
      id: uid('ps_'),
      name: '',
      description: '',
      windowMode: state.settings.defaultWindowMode || 'visible',
      memoryMode: 'auto',
      extensions: [],
      scripts: [],
      startupUrls: [],
      extraArgs: '',
      keepAlive: true,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    openModal({
      title: isEdit ? '编辑预设' : '新建预设',
      subtitle: '预设只保存配置，不会创建浏览器。新建浏览器时套用即可。',
      wide: true,
      body: presetFormBody(model),
      footer: `<button class="btn btn-ghost" data-modal-action="cancel">取消</button><button class="btn btn-primary" data-modal-action="save">保存预设</button>`,
      onMount(root) {
        $$('input[name="ps-window"]', root).forEach((input) => input.addEventListener('change', () => {
          $$('.radio-card', root).forEach((card) => card.classList.toggle('checked', !!$('input[name="ps-window"]', card)?.checked));
        }));
        ($('.modal', root) || root).addEventListener('click', async (event) => {
          const action = event.target.closest('[data-modal-action]')?.dataset.modalAction;
          if (action === 'cancel') return closeModal();
          if (action !== 'save') return;
          const name = $('[name="ps-name"]', root).value.trim();
          if (!name) return toast('请填写预设名称', 'error');
          const value = {
            ...model,
            name,
            description: $('[name="ps-description"]', root).value.trim(),
            windowMode: $('[name="ps-window"]:checked', root)?.value === 'hidden' ? 'hidden' : 'visible',
            memoryMode: $('[name="ps-memory"]', root).value,
            keepAlive: $('[name="ps-keepalive"]', root).checked,
            startupUrls: $('[name="ps-urls"]', root).value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
            extraArgs: $('[name="ps-args"]', root).value.trim(),
            extensions: $$('[data-ps-ext]:checked', root).map((item) => item.value),
            scripts: $$('[data-ps-script]:checked', root).map((item) => item.value),
            updatedAt: Date.now()
          };
          if (isEdit) {
            const index = state.presets.findIndex((item) => item.id === value.id);
            if (index >= 0) state.presets[index] = value;
          } else {
            value.createdAt = Date.now();
            state.presets.push(value);
          }
          await persist();
          closeModal();
          renderView();
          toast(isEdit ? '预设已更新' : '预设已创建');
        });
      }
    });
  }

  async function deletePreset(id) {
    const preset = presetById(id);
    if (!preset) return;
    const ok = await confirmDialog({
      title: '删除预设',
      message: `删除预设“${preset.name}”？已经创建的浏览器不受影响。`,
      confirmText: '删除',
      danger: true
    });
    if (!ok) return;
    state.presets = state.presets.filter((item) => item.id !== id);
    state.profiles.forEach((profile) => {
      if (profile.presetId === id) profile.presetId = '';
    });
    await persist();
    renderView();
    toast('预设已删除');
  }

  /* ------------------------------ extensions ------------------------------ */

  function renderExtensions() {
    setHeader('扩展库', '导入 CRX、ZIP 或已解压的扩展文件夹，新建浏览器时可按预设选择安装', `
      <button class="btn" data-act="import-folder">${icon('folder')}导入文件夹</button>
      <button class="btn btn-primary" data-act="import-crx">${icon('plus')}导入 CRX / ZIP</button>`);
    const cards = state.extensions.map(extensionCard).join('');
    $('#viewRoot').innerHTML = `
      <div class="banner">${icon('alert')}<div>扩展会解包后以目录形式加载到浏览器。想装什么扩展，把它的 .crx 文件导入到这里即可；新建浏览器时在“预装扩展”里勾选。</div></div>
      ${cards ? `<div class="grid">${cards}</div>` : `<div class="empty">
        <div class="empty-icon">${icon('puzzle')}</div>
        <h3>扩展库是空的</h3>
        <p>支持 .crx（自动解包）、.zip 和已解压文件夹。导入后不会自动装到所有浏览器，而是作为一个可选组件，由预设或单个浏览器决定是否加载。</p>
        <button class="btn btn-primary" data-act="import-crx">${icon('plus')}导入 CRX / ZIP</button>
        <button class="btn" data-act="import-folder">${icon('folder')}导入文件夹</button>
      </div>`}`;
  }

  function extensionCard(ext) {
    const usedByProfiles = state.profiles.filter((profile) => profile.extensions.includes(ext.id)).length;
    const usedByPresets = state.presets.filter((preset) => preset.extensions.includes(ext.id)).length;
    return `<article class="card" data-id="${esc(ext.id)}">
      <div class="card-head">
        <div class="ext-icon">${ext.icon ? `<img src="${esc(ext.icon)}" alt="" />` : icon('puzzle')}</div>
        <div class="card-title"><h3>${esc(ext.name)}</h3><p>v${esc(ext.version)} · Manifest V${esc(ext.manifestVersion)}</p></div>
      </div>
      <p class="preset-desc">${esc(ext.description || '没有描述')}</p>
      <div class="chips">
        <span class="chip">${formatBytes(ext.size)}</span>
        <span class="chip">${esc(ext.source || '扩展')}</span>
        <span class="chip blue">${usedByProfiles} 个浏览器</span>
        <span class="chip">${usedByPresets} 个预设</span>
        ${ext.manifestVersion === 2 ? '<span class="chip danger">MV2 可能无法加载</span>' : ''}
      </div>
      <div class="card-meta"><span>添加于 ${formatDate(ext.addedAt)}</span><span class="mono" title="${esc(ext.path)}">${esc(shortPath(ext.path))}</span></div>
      <div class="card-actions">
        <button class="btn btn-ghost" data-act="open-extension">${icon('folder')}打开目录</button>
        <div class="spacer"></div>
        <button class="icon-btn danger" data-act="delete-extension" title="删除扩展">${icon('trash')}</button>
      </div>
    </article>`;
  }

  function shortPath(value) {
    const text = String(value || '');
    if (text.length <= 34) return text;
    return `…${text.slice(-33)}`;
  }

  async function importExtensions(kind) {
    try {
      const result = kind === 'folder' ? await api.importExtensionFolder() : await api.importExtensionFiles();
      let added = 0;
      let duplicate = 0;
      for (const ext of result.extensions || []) {
        if (ext.duplicate || state.extensions.some((item) => item.id === ext.id)) {
          duplicate += 1;
          continue;
        }
        state.extensions.push(ext);
        added += 1;
      }
      if (added) {
        await persist();
        renderView();
        toast(`已导入 ${added} 个扩展${duplicate ? `，${duplicate} 个已存在` : ''}`);
      } else if (duplicate) {
        toast('这些扩展已经在扩展库里了', 'info');
      }
      if (result.errors?.length) {
        toast(`${result.errors.length} 个文件导入失败：${result.errors[0].message}`, 'error');
      }
      if (!added && !duplicate && !result.errors?.length) {
        toast('没有选择扩展', 'info');
      }
    } catch (error) {
      toast(`导入失败：${error.message}`, 'error');
    }
  }

  async function deleteExtension(id) {
    const ext = extensionById(id);
    if (!ext) return;
    const usedProfiles = state.profiles.filter((profile) => profile.extensions.includes(id)).length;
    const ok = await confirmDialog({
      title: '删除扩展',
      message: `删除扩展“${ext.name}”的本地文件？${usedProfiles ? `\n有 ${usedProfiles} 个浏览器正在引用它，删除后这些浏览器将不再加载该扩展。` : ''}\nCRX 原文件不会被删除，只删除 ChromeHub 内的解包副本。`,
      confirmText: '删除',
      danger: true
    });
    if (!ok) return;
    try {
      await api.deleteExtension(id);
      state.extensions = state.extensions.filter((item) => item.id !== id);
      state.profiles.forEach((profile) => {
        profile.extensions = profile.extensions.filter((extId) => extId !== id);
      });
      state.presets.forEach((preset) => {
        preset.extensions = preset.extensions.filter((extId) => extId !== id);
      });
      await persist();
      renderView();
      toast('扩展已删除');
    } catch (error) {
      toast(`删除失败：${error.message}`, 'error');
    }
  }

  /* ------------------------------ scripts ------------------------------ */

  function renderScripts() {
    setHeader('脚本库', '按 @match 自动注入页面；支持常用 GM_* API，无需安装油猴', `
      <button class="btn" data-act="import-script">${icon('download')}导入 .user.js</button>
      <button class="btn btn-primary" data-act="new-script">${icon('plus')}新建脚本</button>`);
    const cards = state.scripts.map(scriptCard).join('');
    $('#viewRoot').innerHTML = `
      <div class="banner">${icon('alert')}<div>脚本在页面加载时注入，并与页面一起常驻。后台运行时仍会执行；支持 GM_getValue、GM_setValue、GM_addStyle、GM_xmlhttpRequest、GM_notification 等常用接口。</div></div>
      ${cards ? `<div class="grid">${cards}</div>` : `<div class="empty">
        <div class="empty-icon">${icon('code')}</div>
        <h3>脚本库是空的</h3>
        <p>可以直接粘贴一段 JS，也可以导入现成的 .user.js。脚本按 @match 匹配网址，只会在命中的页面里运行。</p>
        <button class="btn btn-primary" data-act="new-script">${icon('plus')}新建脚本</button>
        <button class="btn" data-act="import-script">${icon('download')}导入 .user.js</button>
      </div>`}`;
  }

  function scriptCard(script) {
    const matches = script.matches || [];
    const shown = matches.slice(0, 3);
    return `<article class="card" data-id="${esc(script.id)}">
      <div class="card-head">
        <div class="avatar" style="background:linear-gradient(145deg,#8db9ff,#4c8dff);color:#04101f">${icon('code')}</div>
        <div class="card-title"><h3>${esc(script.name)}</h3><p>v${esc(script.version)} · ${esc(script.runAt)}</p></div>
        <label class="switch" title="${script.enabled === false ? '已停用' : '已启用'}">
          <input type="checkbox" data-act="toggle-script" ${script.enabled === false ? '' : 'checked'} />
          <span></span>
        </label>
      </div>
      <p class="preset-desc">${esc(script.description || '没有描述')}</p>
      <div class="script-matches">
        ${shown.map((match) => `<span class="chip blue">${esc(match)}</span>`).join('')}
        ${matches.length > shown.length ? `<span class="chip">+${matches.length - shown.length}</span>` : ''}
      </div>
      <div class="script-code">${esc((script.code || '').slice(0, 220))}</div>
      <div class="card-meta"><span>更新于 ${formatDate(script.updatedAt)}</span><span>${script.enabled === false ? '已停用' : '已启用'}</span></div>
      <div class="card-actions">
        <button class="btn btn-ghost" data-act="edit-script">${icon('edit')}编辑</button>
        <button class="btn btn-ghost" data-act="duplicate-script">${icon('copy')}复制</button>
        <div class="spacer"></div>
        <button class="icon-btn danger" data-act="delete-script" title="删除脚本">${icon('trash')}</button>
      </div>
    </article>`;
  }

  function openScriptModal(script = null) {
    const isEdit = !!script;
    const model = script ? clone(script) : {
      id: uid('u_'),
      name: '',
      version: '1.0.0',
      namespace: '',
      description: '',
      matches: ['*://*/*'],
      excludes: [],
      runAt: 'document-start',
      code: '',
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    openModal({
      title: isEdit ? '编辑脚本' : '新建脚本',
      subtitle: '脚本在页面加载前注入，适合采集、自动翻页和读取页面数据。',
      wide: true,
      body: `<div class="form-stack">
        <div class="field-row">
          <div class="field"><label>名称</label><input class="input" name="sc-name" value="${esc(model.name)}" placeholder="例如：采集列表数据" /></div>
          <div class="field"><label>版本</label><input class="input" name="sc-version" value="${esc(model.version)}" placeholder="1.0.0" /></div>
        </div>
        <div class="field"><label>说明（可选）</label><input class="input" name="sc-description" value="${esc(model.description)}" placeholder="脚本做什么" /></div>
        <div class="field"><label>匹配网址（每行一个 @match）</label><textarea class="textarea" name="sc-matches" style="min-height:70px" placeholder="*://example.com/*">${esc((model.matches || []).join('\n'))}</textarea><span class="field-hint">支持 * 通配符，例如 *://*.example.com/* 或 https://example.com/path/*。</span></div>
        <div class="field"><label>排除网址（可选）</label><textarea class="textarea" name="sc-excludes" style="min-height:56px">${esc((model.excludes || []).join('\n'))}</textarea></div>
        <div class="field-row">
          <div class="field"><label>运行时机</label><select class="select" name="sc-runat">
            ${[['document-start', 'document-start（页面加载前）'], ['document-end', 'document-end（DOM 可用后）'], ['document-idle', 'document-idle（空闲后）']].map(([value, label]) => `<option value="${value}" ${model.runAt === value ? 'selected' : ''}>${label}</option>`).join('')}
          </select></div>
          <div class="field"><label>状态</label><label class="check" style="min-height:38px"><input type="checkbox" name="sc-enabled" ${model.enabled === false ? '' : 'checked'} /><span><strong>启用脚本</strong><span>停用后不会注入任何页面</span></span></label></div>
        </div>
        <div class="field"><label>脚本代码</label><textarea class="textarea code" name="sc-code" spellcheck="false" placeholder="// 这里写 JS，例如：\nconsole.log('hello');">${esc(model.code || '')}</textarea><span class="field-hint">支持常用 GM API。若脚本来自 .user.js，元数据块可以保留，不影响执行。</span></div>
      </div>`,
      footer: `<button class="btn btn-danger ${isEdit ? '' : 'hidden'}" data-modal-action="delete">${icon('trash')}删除</button><div class="spacer"></div><button class="btn btn-ghost" data-modal-action="cancel">取消</button><button class="btn btn-primary" data-modal-action="save">保存脚本</button>`,
      onMount(root) {
        ($('.modal', root) || root).addEventListener('click', async (event) => {
          const action = event.target.closest('[data-modal-action]')?.dataset.modalAction;
          if (action === 'cancel') return closeModal();
          if (action === 'delete' && isEdit) {
            closeModal();
            await deleteScript(model.id);
            return;
          }
          if (action !== 'save') return;
          const name = $('[name="sc-name"]', root).value.trim();
          const code = $('[name="sc-code"]', root).value;
          if (!name) return toast('请填写脚本名称', 'error');
          if (!code.trim()) return toast('脚本代码不能为空', 'error');
          const matches = $('[name="sc-matches"]', root).value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
          const value = {
            ...model,
            name,
            version: $('[name="sc-version"]', root).value.trim() || '1.0.0',
            description: $('[name="sc-description"]', root).value.trim(),
            matches: matches.length ? matches : ['*://*/*'],
            excludes: $('[name="sc-excludes"]', root).value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
            runAt: $('[name="sc-runat"]', root).value,
            enabled: $('[name="sc-enabled"]', root).checked,
            code,
            updatedAt: Date.now()
          };
          if (isEdit) {
            const index = state.scripts.findIndex((item) => item.id === value.id);
            if (index >= 0) state.scripts[index] = value;
          } else {
            value.createdAt = Date.now();
            state.scripts.push(value);
          }
          await persist();
          closeModal();
          renderView();
          toast(isEdit ? '脚本已更新' : '脚本已创建');
        });
      }
    });
  }

  async function importScripts() {
    try {
      const scripts = await api.importScriptFile();
      if (!scripts.length) {
        toast('没有选择脚本', 'info');
        return;
      }
      for (const script of scripts) {
        state.scripts.push({
          ...script,
          id: uid('u_'),
          enabled: true,
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
      }
      await persist();
      renderView();
      toast(`已导入 ${scripts.length} 个脚本`);
    } catch (error) {
      toast(`导入失败：${error.message}`, 'error');
    }
  }

  async function deleteScript(id) {
    const script = scriptById(id);
    if (!script) return;
    const used = state.profiles.filter((profile) => profile.scripts.includes(id)).length;
    const ok = await confirmDialog({
      title: '删除脚本',
      message: `删除脚本“${script.name}”？${used ? `\n有 ${used} 个浏览器正在引用它，删除后这些浏览器将不再注入该脚本。` : ''}`,
      confirmText: '删除',
      danger: true
    });
    if (!ok) return;
    state.scripts = state.scripts.filter((item) => item.id !== id);
    state.profiles.forEach((profile) => {
      profile.scripts = profile.scripts.filter((scriptId) => scriptId !== id);
    });
    state.presets.forEach((preset) => {
      preset.scripts = preset.scripts.filter((scriptId) => scriptId !== id);
    });
    await persist();
    renderView();
    toast('脚本已删除');
  }

  function duplicateScript(id) {
    const script = scriptById(id);
    if (!script) return;
    const copy = {
      ...clone(script),
      id: uid('u_'),
      name: `${script.name} 副本`,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    state.scripts.push(copy);
    persist().then(() => {
      renderView();
      toast('已复制脚本');
    }).catch((error) => toast(`复制失败：${error.message}`, 'error'));
  }

  /* ------------------------------ settings ------------------------------ */

  function renderSettings() {
    setHeader('设置', '内存策略、浏览器内核与数据目录', '');
    const browser = info.browser || {};
    const settings = state.settings;
    $('#viewRoot').innerHTML = `<div class="settings-stack">
      <section class="settings-card">
        <h2>${icon('memory')}内存与常驻</h2>
        <p>页面不会被 Memory Saver 休眠或丢弃，脚本和扩展会随页面持续运行。这里优化的是进程数量、GPU 和 JS 堆上限，而不是关掉页面。</p>
        <div class="form-section-title">全局内存策略</div>
        <div class="memory-modes">
          ${['auto', 'balanced', 'saver', 'extreme'].map((key) => `<label class="mode-card ${settings.memoryMode === key ? 'checked' : ''}">
            <input type="radio" name="set-memory" value="${key}" ${settings.memoryMode === key ? 'checked' : ''} />
            <strong>${MEMORY_MODES[key].label}</strong>
            <span>${MEMORY_MODES[key].desc}</span>
          </label>`).join('')}
        </div>
        <div class="settings-grid" style="margin-top:16px">
          <div class="field"><label>单个页面 JS 堆上限</label>
            <select class="select" data-setting="jsHeapMb">
              ${[[0, '不限制'], [256, '256 MB'], [384, '384 MB'], [512, '512 MB'], [768, '768 MB'], [1024, '1024 MB']].map(([value, label]) => `<option value="${value}" ${Number(settings.jsHeapMb) === value ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
            <span class="field-hint">限制每个渲染进程的 V8 堆。采集中把大量数据囤在 JS 变量里可能触发内存不足，建议及时写入 IndexedDB 或发回本地。</span>
          </div>
          <div class="field"><label>新建浏览器默认运行方式</label>
            <select class="select" data-setting="defaultWindowMode">
              <option value="visible" ${settings.defaultWindowMode === 'visible' ? 'selected' : ''}>前台窗口</option>
              <option value="hidden" ${settings.defaultWindowMode === 'hidden' ? 'selected' : ''}>后台常驻（无窗口）</option>
            </select>
            <span class="field-hint">后台常驻仍会加载页面、扩展和脚本，只是不创建可见窗口，内存和桌面干扰更小。</span>
          </div>
        </div>
        <div class="settings-line" style="margin-top:6px"><span>后台定时器节流</span><strong>已关闭（脚本常驻）</strong></div>
        <div class="settings-line"><span>Memory Saver / 标签页丢弃</span><strong>已关闭</strong></div>
        <div class="settings-line"><span>页面被遮挡时降频</span><strong>已禁用（脚本持续运行）</strong></div>
      </section>

      <section class="settings-card">
        <h2>${icon('browser')}浏览器内核</h2>
        <p>内置 Chromium 独立于系统 Chrome，能稳定加载解包后的 CRX 扩展。首次使用需要下载约 215 MB。</p>
        <div class="settings-line"><span>状态</span><strong>${browser.exists ? `已安装 · Chromium ${esc(browser.browserVersion || '')}` : '未安装'}</strong></div>
        <div class="settings-line"><span>可执行文件</span><strong class="mono">${esc(browser.executable || '—')}</strong></div>
        <div class="settings-line"><span>缓存目录</span><strong class="mono">${esc(browser.cacheDir || '—')}</strong></div>
        ${installProgress ? `<div class="progress"><span id="installProgressFill" style="width:${Math.max(0, Math.min(100, installProgress.percent || 0))}%"></span></div><div class="field-hint" id="installProgressText" style="margin-top:7px">${esc(installProgress.message || '')}</div>` : ''}
        <div class="card-actions" style="margin-top:14px">
          <button class="btn ${browser.exists ? '' : 'btn-primary'}" data-act="install-browser" ${installing ? 'disabled' : ''}>${icon('download')}${browser.exists ? '重新安装 / 修复' : '下载并安装'}</button>
          <button class="btn btn-ghost" data-act="open-browser-cache">${icon('folder')}打开缓存目录</button>
          <div class="spacer"></div>
          <span class="field-hint">Chromium 启动参数由 ChromeHub 统一管理</span>
        </div>
      </section>

      <section class="settings-card">
        <h2>${icon('folder')}数据位置</h2>
        <p>每个浏览器的 Cookie、缓存、LocalStorage 和登录状态都在独立目录中，停止或重启不会清除。</p>
        <div class="field" style="margin-bottom:12px"><label>应用数据目录</label><div class="path-box"><span>${esc(info.paths.userData)}</span><span class="spacer"></span><button class="icon-btn" data-act="open-user-data" title="打开">${icon('external')}</button></div></div>
        <div class="settings-grid">
          <div class="field"><label>扩展解包目录</label><div class="path-box"><span>${esc(info.paths.extensions)}</span></div></div>
          <div class="field"><label>浏览器 Profile 目录</label><div class="path-box"><span>${esc(info.paths.profiles)}</span></div></div>
        </div>
      </section>

      <section class="settings-card">
        <h2>${icon('settings')}关于</h2>
        <div class="settings-line"><span>ChromeHub</span><strong>v${esc(info.version)}</strong></div>
        <div class="settings-line"><span>Electron</span><strong>${esc(info.electron)}</strong></div>
        <div class="settings-line"><span>内置 Chromium</span><strong>${esc(browser.browserVersion || '—')}</strong></div>
        <div class="settings-line"><span>工作方式</span><strong>独立 Profile · 解包扩展 · 页面常驻</strong></div>
      </section>
    </div>`;

    $$('input[name="set-memory"]', $('#viewRoot')).forEach((input) => input.addEventListener('change', async () => {
      state.settings.memoryMode = input.value;
      await persist();
      renderSettings();
      toast('内存策略已更新，下次启动浏览器生效');
    }));
    $$('[data-setting]', $('#viewRoot')).forEach((input) => input.addEventListener('change', async () => {
      state.settings[input.dataset.setting] = input.dataset.setting === 'jsHeapMb' ? Number(input.value) : input.value;
      await persist();
      renderSettings();
      toast('设置已保存');
    }));
  }

  async function installBrowser() {
    if (installing) return;
    installing = true;
    installProgress = { percent: 0, message: '准备安装...' };
    renderSettings();
    const unsubscribe = api.onBrowserInstallProgress((progress) => {
      installProgress = progress;
      const fill = $('#installProgressFill');
      const text = $('#installProgressText');
      if (fill) fill.style.width = `${Math.max(0, Math.min(100, progress.percent || 0))}%`;
      if (text) text.textContent = progress.message || '';
    });
    try {
      const status = await api.installBrowser(!!info.browser?.exists);
      info.browser = status;
      installProgress = null;
      toast('浏览器内核安装完成');
    } catch (error) {
      installProgress = null;
      toast(`安装失败：${error.message}`, 'error');
    } finally {
      installing = false;
      unsubscribe();
      renderSettings();
    }
  }

  /* ------------------------------ events ------------------------------ */

  function onViewClick(event) {
    const actionEl = event.target.closest('[data-act]');
    if (!actionEl) return;
    const action = actionEl.dataset.act;
    const card = actionEl.closest('[data-id]');
    const id = card?.dataset.id;

    switch (action) {
      case 'new-profile':
        openBrowserModal();
        break;
      case 'new-preset':
        openPresetModal();
        break;
      case 'refresh-profiles':
        api.getRuntimeStatus().then((status) => {
          runtimeStatus = status;
          return refreshMetrics();
        }).then(() => renderProfiles());
        break;
      case 'toggle-profile': {
        const status = statusFor(id);
        if (isActiveStatus(status.state)) stopProfile(id);
        else launchProfile(id);
        break;
      }
      case 'edit-profile': {
        const profile = profileById(id);
        if (profile) openBrowserModal({ profile });
        break;
      }
      case 'delete-profile':
        deleteProfile(id);
        break;
      case 'open-profile-data':
        api.openProfileData(id).catch((error) => toast(error.message, 'error'));
        break;
      case 'use-preset': {
        const preset = presetById(id);
        if (preset) openBrowserModal({ preset });
        break;
      }
      case 'edit-preset': {
        const preset = presetById(id);
        if (preset) openPresetModal(preset);
        break;
      }
      case 'delete-preset':
        deletePreset(id);
        break;
      case 'import-crx':
        importExtensions('files');
        break;
      case 'import-folder':
        importExtensions('folder');
        break;
      case 'open-extension':
        api.openExtension(id).catch((error) => toast(error.message, 'error'));
        break;
      case 'delete-extension':
        deleteExtension(id);
        break;
      case 'new-script':
        openScriptModal();
        break;
      case 'import-script':
        importScripts();
        break;
      case 'edit-script': {
        const script = scriptById(id);
        if (script) openScriptModal(script);
        break;
      }
      case 'duplicate-script':
        duplicateScript(id);
        break;
      case 'delete-script':
        deleteScript(id);
        break;
      case 'go-settings':
        switchView('settings');
        break;
      case 'install-browser':
        installBrowser();
        break;
      case 'open-browser-cache':
        api.openBrowserCache().catch((error) => toast(error.message, 'error'));
        break;
      case 'open-user-data':
        api.openUserData().catch((error) => toast(error.message, 'error'));
        break;
      default:
        break;
    }
  }

  function onViewChange(event) {
    const toggle = event.target.closest('[data-act="toggle-script"]');
    if (toggle) {
      const card = toggle.closest('[data-id]');
      const script = scriptById(card?.dataset.id);
      if (!script) return;
      script.enabled = toggle.checked;
      script.updatedAt = Date.now();
      persist().then(() => {
        renderView();
        toast(toggle.checked ? '脚本已启用' : '脚本已停用');
      }).catch((error) => toast(`保存失败：${error.message}`, 'error'));
    }
  }

  function bindEvents() {
    $('#nav').addEventListener('click', (event) => {
      const button = event.target.closest('[data-view]');
      if (button) switchView(button.dataset.view);
    });
    $('#viewRoot').addEventListener('click', onViewClick);
    $('#viewActions').addEventListener('click', onViewClick);
    $('#viewRoot').addEventListener('change', onViewChange);
    $('#stopAllBtn').addEventListener('click', async () => {
      if (runningProfiles().length === 0) return;
      const ok = await confirmDialog({
        title: '停止全部浏览器',
        message: '所有页面、扩展和脚本都会停止运行；Cookie 和登录状态会保留，下次启动继续使用。',
        confirmText: '全部停止',
        danger: true
      });
      if (!ok) return;
      await api.stopAllProfiles();
      await refreshMetrics();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !$('#dialogRoot').innerHTML && $('#modalRoot').innerHTML) closeModal();
    });
  }

  async function init() {
    if (!api) {
      document.body.innerHTML = '<div style="padding:40px;color:#e8eef8">请使用 Electron 启动 ChromeHub。</div>';
      return;
    }
    state = ensureState(await api.loadState());
    info = await api.getInfo();
    runtimeStatus = await api.getRuntimeStatus();

    const activeView = new URLSearchParams(location.search).get('view');
    if (activeView) currentView = activeView;

    $$('[data-icon]').forEach((el) => {
      el.innerHTML = icon(el.dataset.icon);
    });

    bindEvents();
    renderView();
    updateSidebar();
    refreshMetrics();
    scheduleMetrics();

    api.onRuntimeStatus((status) => {
      runtimeStatus = status;
      updateRuntimeUI();
      if (runningProfiles().length > 0) refreshMetrics();
    });

    api.onOpenProfile(() => {
      switchView('profiles');
      showMain();
    });
  }

  function showMain() {
    currentView = 'profiles';
    $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === 'profiles'));
    renderView();
  }

  init().catch((error) => {
    console.error(error);
    toast(`初始化失败：${error.message}`, 'error');
  });
})();

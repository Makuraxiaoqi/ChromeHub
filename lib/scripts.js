function stripMetadataBlock(text) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  const block = source.match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/i);
  if (!block) return { meta: {}, body: source };
  const meta = {};
  for (const line of block[1].split(/\r?\n/)) {
    const match = line.match(/^\s*\/\/\s*@([\w:-]+)\s*(.*)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (!value) continue;
    if (!meta[key]) meta[key] = [];
    meta[key].push(value);
  }
  return { meta, body: source };
}

function parseUserScript(text, fallbackName = '未命名脚本') {
  const { meta } = stripMetadataBlock(text);
  const first = (key) => (Array.isArray(meta[key]) ? meta[key][0] : '');
  const all = (key) => (Array.isArray(meta[key]) ? meta[key].slice() : []);
  const matches = [...all('match'), ...all('include')];
  return {
    name: first('name') || fallbackName,
    namespace: first('namespace'),
    version: first('version') || '1.0.0',
    description: first('description'),
    author: first('author'),
    icon: first('icon'),
    runAt: first('run-at') || 'document-start',
    matches: matches.length ? matches : ['*://*/*'],
    excludes: all('exclude'),
    grants: all('grant'),
    code: String(text || '')
  };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchPatternToRegex(pattern) {
  if (!pattern) return null;
  if (pattern === '<all_urls>') return /^(https?|wss?|ftp|file):\/\/.*$/i;
  if (pattern.startsWith('/') && pattern.endsWith('/') && pattern.length > 2) {
    try {
      return new RegExp(pattern.slice(1, -1));
    } catch {
      return null;
    }
  }
  if (!pattern.includes('://')) {
    if (!pattern.includes('*')) return null;
    return new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`, 'i');
  }
  const match = pattern.match(/^(\*|https?|wss?|ftp|file):\/\/([^/]*)(\/.*)$/i);
  if (!match) {
    return new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`, 'i');
  }
  const [, scheme, host, pathPart] = match;
  const schemeRe = scheme === '*' ? 'https?' : escapeRegex(scheme);
  let hostname = host;
  let port = '';
  const colon = host.lastIndexOf(':');
  if (colon > 0) {
    hostname = host.slice(0, colon);
    port = host.slice(colon + 1);
  }
  let hostRe;
  if (hostname === '*') hostRe = '[^/:]+';
  else if (hostname.startsWith('*.')) hostRe = `([^/]+\\.)?${escapeRegex(hostname.slice(2))}`;
  else hostRe = escapeRegex(hostname);
  if (port) hostRe += port === '*' ? '(:\\d+)?' : `:${escapeRegex(port)}`;
  const pathRe = escapeRegex(pathPart).replace(/\\\*/g, '.*');
  return new RegExp(`^${schemeRe}://${hostRe}${pathRe}$`, 'i');
}

function compilePatterns(patterns) {
  return (patterns || [])
    .map((pattern) => ({ pattern, regex: matchPatternToRegex(pattern) }))
    .filter((item) => !!item.regex);
}

function patternList(patterns, fallback = null) {
  const list = compilePatterns(patterns).map(({ regex }) => [regex.source, regex.flags]);
  if (!list.length && fallback) {
    const regex = matchPatternToRegex(fallback);
    if (regex) list.push([regex.source, regex.flags]);
  }
  return list;
}

function buildInjection(scripts) {
  const active = (scripts || []).filter((script) => script && script.enabled !== false && String(script.code || '').trim());
  if (!active.length) return '';

  const blocks = [];
  for (const script of active) {
    const id = JSON.stringify(String(script.id || script.name || Math.random()));
    const name = JSON.stringify(String(script.name || '脚本'));
    const info = JSON.stringify({
      script: { name: script.name || '', version: script.version || '', namespace: script.namespace || '', description: script.description || '', matches: script.matches || [] },
      scriptHandler: 'ChromeHub',
      version: '1.0.0'
    });
    const matches = JSON.stringify(patternList(script.matches && script.matches.length ? script.matches : ['*://*/*'], '*://*/*'));
    const excludes = JSON.stringify(patternList(script.excludes || []));
    const runAt = JSON.stringify(script.runAt || 'document-start');
    const prefix = JSON.stringify(`__chromehub_gm_${script.id || 'script'}_`);

    blocks.push(`
  (function () {
    var __id = ${id};
    var __matches = ${matches};
    var __excludes = ${excludes};
    var __runAt = ${runAt};
    var __name = ${name};
    var __prefix = ${prefix};
    var __store = window.__chromehub_mem || (window.__chromehub_mem = {});
    var __loaded = window.__chromehub_loaded || (window.__chromehub_loaded = {});
    if (__loaded[__id]) return;

    function __matchesAny(list) {
      for (var i = 0; i < list.length; i++) {
        try {
          if (new RegExp(list[i][0], list[i][1]).test(location.href)) return true;
        } catch (e) {}
      }
      return false;
    }

    if (!__matchesAny(__matches) || __matchesAny(__excludes)) return;

    function __gmGet(key, fallback) {
      try {
        var raw = localStorage.getItem(__prefix + key);
        if (raw === null) return Object.prototype.hasOwnProperty.call(__store, __prefix + key) ? __store[__prefix + key] : fallback;
        return JSON.parse(raw);
      } catch (e) {
        return Object.prototype.hasOwnProperty.call(__store, __prefix + key) ? __store[__prefix + key] : fallback;
      }
    }
    function __gmSet(key, value) {
      __store[__prefix + key] = value;
      try { localStorage.setItem(__prefix + key, JSON.stringify(value)); } catch (e) {}
    }
    function __gmDelete(key) {
      delete __store[__prefix + key];
      try { localStorage.removeItem(__prefix + key); } catch (e) {}
    }
    function __gmList() {
      var keys = [];
      try {
        for (var i = 0; i < localStorage.length; i++) {
          var key = localStorage.key(i);
          if (key && key.indexOf(__prefix) === 0) keys.push(key.slice(__prefix.length));
        }
      } catch (e) {}
      Object.keys(__store).forEach(function (key) {
        if (key.indexOf(__prefix) === 0) {
          var short = key.slice(__prefix.length);
          if (keys.indexOf(short) < 0) keys.push(short);
        }
      });
      return keys;
    }
    function __gmAddStyle(css) {
      var style = document.createElement('style');
      style.textContent = String(css || '');
      var parent = document.head || document.documentElement;
      if (parent) parent.appendChild(style);
      else document.addEventListener('DOMContentLoaded', function () { (document.head || document.documentElement).appendChild(style); }, { once: true });
      return style;
    }
    function __gmAddElement(tag, attrs, text) {
      var el = document.createElement(tag);
      if (typeof attrs === 'string') attrs = { class: attrs };
      var parent = document.head || document.documentElement;
      if (attrs) Object.keys(attrs).forEach(function (key) {
        if (key === 'parent') return;
        el.setAttribute(key, attrs[key]);
      });
      if (text) el.textContent = text;
      if (attrs && attrs.parent) parent = attrs.parent;
      if (parent) parent.appendChild(el);
      return el;
    }
    function __gmXhr(details) {
      var controller = new AbortController();
      var timer = null;
      if (details.timeout) timer = setTimeout(function () { controller.abort(); }, details.timeout);
      var headers = details.headers || {};
      var init = { method: details.method || 'GET', headers: headers, credentials: 'include', signal: controller.signal };
      if (details.data !== undefined && init.method !== 'GET') init.body = details.data;
      fetch(details.url, init).then(function (res) {
        return res.text().then(function (text) {
          var response = text;
          if (details.responseType === 'json') { try { response = JSON.parse(text); } catch (e) {} }
          if (details.onload) details.onload({ status: res.status, statusText: res.statusText, responseText: text, response: response, finalUrl: res.url, responseHeaders: Array.from(res.headers.entries()).map(function (p) { return p[0] + ': ' + p[1]; }).join('\\r\\n') });
        });
      }).catch(function (error) {
        if (error && error.name === 'AbortError') { if (details.ontimeout) details.ontimeout(error); }
        else if (details.onerror) details.onerror(error);
      }).finally(function () { if (timer) clearTimeout(timer); });
      return { abort: function () { controller.abort(); } };
    }
    function __gmNotify(title, options) {
      try { new Notification(String(title || ''), options || {}); } catch (e) {}
    }
    function __gmClipboard(text) {
      try { navigator.clipboard.writeText(String(text || '')); } catch (e) {}
    }
    var __GM = {
      info: ${info},
      getValue: __gmGet, setValue: __gmSet, deleteValue: __gmDelete, listValues: __gmList,
      addStyle: __gmAddStyle, addElement: __gmAddElement, xmlHttpRequest: __gmXhr,
      notification: __gmNotify, setClipboard: __gmClipboard,
      openInTab: function (url, options) { return window.open(url, (options && options.active === false) ? '_blank' : '_blank') || { close: function () {} }; },
      registerMenuCommand: function () { return 0; },
      unregisterMenuCommand: function () {}
    };

    function __whenReady(fn) {
      if (document.documentElement) {
        fn();
        return;
      }
      var called = false;
      var observer = new MutationObserver(function () {
        if (!document.documentElement || called) return;
        called = true;
        observer.disconnect();
        fn();
      });
      observer.observe(document, { childList: true, subtree: true });
      document.addEventListener('DOMContentLoaded', function () {
        if (called) return;
        called = true;
        observer.disconnect();
        fn();
      }, { once: true });
    }

    function __run() {
      if (__loaded[__id]) return;
      __loaded[__id] = true;
      try {
        (function (GM_info, GM_getValue, GM_setValue, GM_deleteValue, GM_listValues, GM_addStyle, GM_addElement, GM_xmlhttpRequest, GM_notification, GM_setClipboard, GM_openInTab, GM_registerMenuCommand, GM_unregisterMenuCommand, GM, unsafeWindow) {
${script.code}
        }).call(window, __GM.info, __gmGet, __gmSet, __gmDelete, __gmList, __gmAddStyle, __gmAddElement, __gmXhr, __gmNotify, __gmClipboard, __GM.openInTab, __GM.registerMenuCommand, __GM.unregisterMenuCommand, __GM, window);
      } catch (error) {
        console.error('[ChromeHub][' + __name + ']', error);
      }
    }

    if (__runAt === 'document-start') {
      __whenReady(__run);
    } else if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', __run, { once: true });
    } else {
      __run();
    }
  })();`);
  }

  return `/* ChromeHub injected userscripts */\n${blocks.join('\n')}\n`;
}

module.exports = {
  parseUserScript,
  stripMetadataBlock,
  matchPatternToRegex,
  compilePatterns,
  buildInjection
};

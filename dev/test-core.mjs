import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');
const { BrowserRuntime } = require('../lib/runtime');
const { importExtensionFromPath } = require('../lib/extensions');
const { parseUserScript } = require('../lib/scripts');
const { chromiumDownloadTarget } = require('../lib/chromium');

const root = path.resolve(import.meta.dirname, '..');
const tmp = path.join(root, 'dev', 'tmp-core');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });

const fail = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fail.push(name);
};

const winTarget = chromiumDownloadTarget('win32', 'x64');
const linuxTarget = chromiumDownloadTarget('linux', 'x64');
check('Windows 内核下载布局', winTarget.zipName === 'chrome-win64.zip' && winTarget.executable === 'chrome.exe');
check(
  'Linux 内核下载布局',
  linuxTarget.ctfPlatform === 'linux64' && linuxTarget.zipName === 'chrome-linux64.zip' && linuxTarget.executable === 'chrome'
);

// ---------- local site ----------
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><title>fixture</title></head><body><h1>fixture</h1>
  <script>document.documentElement.dataset.pageScript = 'page';</script></body></html>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/`;

// ---------- CRX3 fixture ----------
const zip = new AdmZip();
for (const name of ['manifest.json', 'content.js', 'bg.js']) {
  zip.addLocalFile(path.join(root, 'dev', 'fixtures', 'ext-test', name));
}
const zipBuffer = zip.toBuffer();
const dummyHeader = Buffer.from('chromehub-test-crx3', 'utf8');
const crx = Buffer.alloc(12 + dummyHeader.length + zipBuffer.length);
crx.write('Cr24', 0, 'ascii');
crx.writeUInt32LE(3, 4);
crx.writeUInt32LE(dummyHeader.length, 8);
dummyHeader.copy(crx, 12);
zipBuffer.copy(crx, 12 + dummyHeader.length);
const crxPath = path.join(tmp, 'fixture.crx');
fs.writeFileSync(crxPath, crx);

const ext = await importExtensionFromPath(crxPath, path.join(tmp, 'extensions'));
check('CRX3 导入', ext && ext.name === 'ChromeHub Test Ext' && ext.version === '1.2.3', ext?.name);
check('CRX 解包目录含 manifest', fs.existsSync(path.join(ext.path, 'manifest.json')));

// folder import
const extFolder = await importExtensionFromPath(path.join(root, 'dev', 'fixtures', 'ext-test'), path.join(tmp, 'extensions'));
check('文件夹导入', extFolder.name === 'ChromeHub Test Ext');

// ---------- userscript ----------
const scriptText = fs.readFileSync(path.join(root, 'dev', 'fixtures', 'test.user.js'), 'utf8');
const script = parseUserScript(scriptText, 'test.user.js');
script.id = 's_test';
check('用户脚本解析', script.name === 'ChromeHub Test Script' && script.matches.length === 2, script.matches.join(','));

// ---------- runtime ----------
const state = {
  settings: { memoryMode: 'balanced', jsHeapMb: 512, defaultWindowMode: 'hidden' },
  extensions: [ext],
  scripts: [script],
  presets: [],
  profiles: [{
    id: 'p_test',
    name: '测试浏览器',
    note: '',
    group: '',
    presetId: '',
    windowMode: 'hidden',
    memoryMode: 'inherit',
    extensions: [ext.id],
    scripts: [script.id],
    startupUrls: [url],
    extraArgs: '',
    keepAlive: true,
    createdAt: Date.now()
  }]
};

const runtime = new BrowserRuntime({
  getState: () => state,
  userDataDir: path.join(tmp, 'userdata'),
  onEvent: (event) => {
    if (event.type === 'status') {
      for (const st of event.status) {
        // console.log('status', st.profileId, st.state, st.pages, st.error || '');
      }
    }
  }
});

try {
  const st = await runtime.launch('p_test');
  check('启动（后台常驻）', st.state === 'running', JSON.stringify(st));
  const context = runtime.sessions.get('p_test').context;
  const page = context.pages().find((p) => p.url().startsWith('http')) || context.pages()[0];
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1200);

  const info = await page.evaluate(() => ({
    url: location.href,
    page: document.documentElement.dataset.pageScript,
    ext: document.documentElement.dataset.extTest,
    script: document.documentElement.dataset.scriptTest,
    gm: document.documentElement.dataset.gmValue,
    styleVar: getComputedStyle(document.body).getPropertyValue('--chromehub-test').trim(),
    ls: localStorage.getItem('__chromehub_gm_s_test_greeting')
  }));
  console.log('page info:', info);
  check('页面导航', info.url.startsWith(url));
  check('扩展内容脚本加载', info.ext === 'ok');
  check('用户脚本注入', info.script === 'ok');
  check('GM 存储读写', info.gm === 'hello-from-gm' && !!info.ls);
  check('GM_addStyle', info.styleVar === '1');

  // cookie persistence (non-session)
  await context.addCookies([{ name: 'ch_key', value: 'persist-me', domain: '127.0.0.1', path: '/', expires: Math.floor(Date.now() / 1000) + 3600 }]);
  const before = await context.cookies('http://127.0.0.1/');
  check('写入 Cookie', before.some((c) => c.name === 'ch_key'));

  const metrics = await runtime.metrics('p_test');
  check('内存指标', metrics && metrics.pages >= 1 && metrics.heapBytes > 0, `${metrics?.pages} 页 / ${(metrics?.heapBytes / 1048576).toFixed(1)} MB`);

  await runtime.stop('p_test');
  check('停止', runtime.status().find((s) => s.profileId === 'p_test')?.state === 'stopped');

  // relaunch for cookie check
  await runtime.launch('p_test');
  const context2 = runtime.sessions.get('p_test').context;
  const cookies = await context2.cookies('http://127.0.0.1/');
  check('Cookie 重启保留', cookies.some((c) => c.name === 'ch_key' && c.value === 'persist-me'));

  const page2 = context2.pages().find((p) => p.url().startsWith('http')) || context2.pages()[0];
  await page2.waitForTimeout(800);
  const info2 = await page2.evaluate(() => ({
    script: document.documentElement.dataset.scriptTest,
    gm: document.documentElement.dataset.gmValue
  }));
  check('重启后脚本继续注入', info2.script === 'ok' && info2.gm === 'hello-from-gm');

  // keepalive: close last page, expect recreation
  await page2.close();
  await runtime.sessions.get('p_test').context.pages().forEach((p) => p.close());
  await new Promise((r) => setTimeout(r, 2600));
  const pagesAfter = runtime.sessions.get('p_test').context.pages().filter((p) => !p.isClosed());
  check('页面保活自动重开', pagesAfter.length >= 1, `${pagesAfter.length} 页`);
  if (pagesAfter.length) {
    await pagesAfter[0].waitForTimeout(900);
    const info3 = await pagesAfter[0].evaluate(() => ({
      url: location.href,
      script: document.documentElement.dataset.scriptTest
    })).catch(() => ({}));
    check('重开页恢复启动地址与脚本', info3.url?.startsWith(url) && info3.script === 'ok', JSON.stringify(info3));
  }

  await runtime.stopAll();
  check('停止全部', runtime.sessions.size === 0);

  // ---------- multiple profiles: cookie isolation ----------
  state.profiles.push({
    ...state.profiles[0],
    id: 'p_two',
    name: '测试浏览器 2',
    windowMode: 'hidden',
    startupUrls: [url]
  });
  await Promise.all([runtime.launch('p_test'), runtime.launch('p_two')]);
  const ctxA = runtime.sessions.get('p_test').context;
  const ctxB = runtime.sessions.get('p_two').context;
  const expires = Math.floor(Date.now() / 1000) + 3600;
  await ctxA.addCookies([{ name: 'who', value: 'A', domain: '127.0.0.1', path: '/', expires }]);
  await ctxB.addCookies([{ name: 'who', value: 'B', domain: '127.0.0.1', path: '/', expires }]);
  const cookiesA = await ctxA.cookies('http://127.0.0.1/');
  const cookiesB = await ctxB.cookies('http://127.0.0.1/');
  check('多开同时运行', runtime.sessions.size === 2);
  check('Profile 目录隔离', runtime.profileDir('p_test') !== runtime.profileDir('p_two'));
  check('Cookie 互不串号', cookiesA.find((c) => c.name === 'who')?.value === 'A'
    && cookiesB.find((c) => c.name === 'who')?.value === 'B'
    && !cookiesB.some((c) => c.name === 'ch_key'), `A=${cookiesA.find((c) => c.name === 'who')?.value} B=${cookiesB.find((c) => c.name === 'who')?.value}`);
  const allMetrics = await runtime.metricsAll();
  check('多开指标汇总', Object.keys(allMetrics).length === 2, JSON.stringify(Object.fromEntries(Object.entries(allMetrics).map(([k, v]) => [k, v.pages]))));
  await runtime.stopAll();
  check('多开全部停止', runtime.sessions.size === 0);
} catch (error) {
  console.error('RUNTIME ERROR', error);
  fail.push('runtime');
} finally {
  server.close();
}

console.log(fail.length ? `\n${fail.length} FAILED: ${fail.join(', ')}` : '\nALL PASS');
process.exit(fail.length ? 1 : 0);

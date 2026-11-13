import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { importExtensionFromPath } = require('../lib/extensions');
const { parseUserScript } = require('../lib/scripts');

const root = path.resolve(import.meta.dirname, '..');
const ud = path.join(root, 'dev', 'tmp-pack-ud');
fs.rmSync(ud, { recursive: true, force: true });
fs.mkdirSync(ud, { recursive: true });

const server = http.createServer((q, s) => { s.writeHead(200, {'content-type':'text/html; charset=utf-8'}); s.end('<html><body>packaged</body></html>'); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const ext = importExtensionFromPath(path.join(root, 'dev', 'fixtures', 'ext-test'), path.join(ud, 'extensions'));
const script = parseUserScript(fs.readFileSync(path.join(root, 'dev', 'fixtures', 'test.user.js'), 'utf8'), 'x');
script.id = 's_pack';
const state = {
  version: 1,
  settings: { memoryMode: 'auto', jsHeapMb: 512, defaultWindowMode: 'hidden', confirmOnClose: true },
  presets: [], extensions: [ext], scripts: [script],
  profiles: [{ id: 'p_pack', name: '打包测试', note: '', group: '', presetId: '', windowMode: 'hidden', memoryMode: 'inherit', extensions: [ext.id], scripts: [script.id], startupUrls: [url], extraArgs: '', keepAlive: true, createdAt: Date.now(), lastLaunchedAt: 0 }]
};

const app = await electron.launch({
  executablePath: path.join(root, 'dist', 'ChromeHub-win32-x64', 'ChromeHub.exe'),
  args: [`--user-data-dir=${ud}`],
  cwd: path.join(root, 'dist', 'ChromeHub-win32-x64')
});
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', e => { errors.push(e.message); console.log('[pageerror]', e.message); });
await page.waitForTimeout(1800);
console.log('packaged info browser:', await page.evaluate(async () => (await window.api.getInfo()).browser.browserVersion));
await page.evaluate(async (s) => { await window.api.saveState(s); }, state);
const st = await page.evaluate(async () => window.api.launchProfile('p_pack'));
console.log('launch:', st);
await page.waitForTimeout(4000);
console.log('status:', await page.evaluate(() => window.api.getRuntimeStatus()));
console.log('metrics:', await page.evaluate(() => window.api.getMetrics()));
await page.screenshot({ path: path.join(root, 'dev', 'shots', '07-packaged.png') });
await page.evaluate(() => window.api.stopAllProfiles());
await page.waitForTimeout(1200);
console.log('errors:', errors);
await app.close();
server.close();

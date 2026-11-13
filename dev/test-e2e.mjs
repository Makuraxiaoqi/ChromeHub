import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { importExtensionFromPath } = require('../lib/extensions');
const { parseUserScript } = require('../lib/scripts');

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'dev', 'shots');
fs.mkdirSync(shots, { recursive: true });
const userData = path.join(root, 'dev', 'tmp-e2e-userdata');
fs.rmSync(userData, { recursive: true, force: true });
fs.mkdirSync(userData, { recursive: true });

// local site
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><head><title>e2e</title></head><body><h1>e2e site</h1></body></html>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const siteUrl = `http://127.0.0.1:${server.address().port}/`;

// fixtures imported into app data
const ext = await importExtensionFromPath(path.join(root, 'dev', 'fixtures', 'ext-test'), path.join(userData, 'extensions'));
const script = parseUserScript(fs.readFileSync(path.join(root, 'dev', 'fixtures', 'test.user.js'), 'utf8'), 'test.user.js');
script.id = 's_e2e';
script.enabled = true;

const state = {
  version: 1,
  settings: { memoryMode: 'auto', jsHeapMb: 512, defaultWindowMode: 'hidden', confirmOnClose: true },
  presets: [],
  extensions: [ext],
  scripts: [script],
  profiles: [{
    id: 'p_e2e',
    name: '测试浏览器',
    note: '端到端测试',
    group: '测试',
    presetId: '',
    windowMode: 'hidden',
    memoryMode: 'inherit',
    extensions: [ext.id],
    scripts: [script.id],
    startupUrls: [siteUrl],
    extraArgs: '',
    keepAlive: true,
    createdAt: Date.now(),
    lastLaunchedAt: 0
  }]
};
fs.writeFileSync(path.join(userData, 'state.json'), JSON.stringify(state, null, 2), 'utf8');

const fail = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fail.push(name);
};

const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: root });
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (err) => {
  errors.push(err.message);
  console.log('[pageerror]', err.stack || err.message);
});
page.on('console', (msg) => {
  if (msg.type() === 'error') console.log('[renderer:error]', msg.text());
});
const shot = async (name) => {
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
};

await page.waitForTimeout(1600);
const card = page.locator('.browser-card[data-id="p_e2e"]');
check('UI 读取预置配置', await card.count() === 1);
check('卡片显示扩展/脚本数量', (await card.innerText()).includes('1 个扩展') && (await card.innerText()).includes('1 个脚本'));

// launch
await card.locator('[data-act="toggle-profile"]').click();
await page.waitForTimeout(2500);
let status = await page.evaluate(() => window.api.getRuntimeStatus());
let item = status.find((s) => s.profileId === 'p_e2e');
check('UI 启动浏览器', item?.state === 'running', JSON.stringify(item));
check('运行页数', item?.pages >= 1, `${item?.pages}`);

await page.waitForTimeout(4000);
const cardText = await card.innerText();
check('侧栏统计运行中', (await page.locator('#navRunningBadge').innerText()) === '1');
check('卡片显示常驻页面', /页面\s*1/.test(cardText), cardText.replace(/\n/g, ' | '));
await shot('04-e2e-running');

// stop
await card.locator('[data-act="toggle-profile"]').click();
await page.waitForTimeout(1800);
status = await page.evaluate(() => window.api.getRuntimeStatus());
item = status.find((s) => s.profileId === 'p_e2e');
check('UI 停止浏览器', item?.state === 'stopped', JSON.stringify(item));

// create profile through UI
await page.locator('#viewActions button', { hasText: '新建浏览器' }).click();
await page.waitForTimeout(500);
await page.locator('#browserForm [name="pf-name"]').fill('UI 新建浏览器');
await page.locator('#browserForm [name="pf-group"]').fill('采集');
await page.locator('#browserForm [data-ext-pick]').check();
await page.locator('#browserForm [data-script-pick]').check();
await page.locator('#browserForm input[name="pf-window"][value="hidden"]').check({ force: true });
await page.locator('#browserForm [name="pf-urls"]').fill(siteUrl);
await page.locator('#modalRoot [data-modal-action="save"]').click();
await page.waitForTimeout(900);
const newCard = page.locator('.browser-card').filter({ hasText: 'UI 新建浏览器' });
check('UI 新建浏览器保存', await newCard.count() === 1);
check('新建时预选扩展与脚本', (await newCard.innerText()).includes('1 个扩展') && (await newCard.innerText()).includes('1 个脚本'));

// preset: create + apply + save & launch
await page.locator('.nav-item[data-view="presets"]').click();
await page.waitForTimeout(400);
await page.locator('#viewActions button', { hasText: '新建预设' }).click();
await page.waitForTimeout(500);
await page.locator('#presetForm [name="ps-name"]').fill('采集预设');
await page.locator('#presetForm [name="ps-description"]').fill('带扩展和脚本');
await page.locator('#presetForm [data-ps-ext]').check();
await page.locator('#presetForm [data-ps-script]').check();
await page.locator('#presetForm input[name="ps-window"][value="hidden"]').check({ force: true });
await page.locator('#presetForm [name="ps-urls"]').fill(siteUrl);
await page.locator('#modalRoot [data-modal-action="save"]').click();
await page.waitForTimeout(800);
const presetCard = page.locator('.preset-card').filter({ hasText: '采集预设' });
check('UI 新建预设', await presetCard.count() === 1);
await presetCard.locator('[data-act="use-preset"]').click();
await page.waitForTimeout(600);
check('套用预设回填名称', (await page.locator('#browserForm [name="pf-name"]').inputValue()) === '采集预设 浏览器');
check('套用预设回填扩展', await page.locator('#browserForm [data-ext-pick]').isChecked());
check('套用预设回填脚本', await page.locator('#browserForm [data-script-pick]').isChecked());
check('套用预设回填运行方式', await page.locator('#browserForm input[name="pf-window"][value="hidden"]').isChecked());
await page.locator('#browserForm [name="pf-name"]').fill('预设启动浏览器');
await page.locator('#modalRoot [data-modal-action="save-launch"]').click();
await page.waitForTimeout(3200);
const presetState = await page.evaluate(() => window.api.loadState());
const presetProfile = presetState.profiles.find((p) => p.name === '预设启动浏览器');
check('保存并启动创建配置', !!presetProfile && presetProfile.extensions.length === 1 && presetProfile.scripts.length === 1);
status = await page.evaluate(() => window.api.getRuntimeStatus());
check('保存并启动直接运行', status.find((s) => s.profileId === presetProfile?.id)?.state === 'running');
if (presetProfile) await page.evaluate((id) => window.api.stopProfile(id), presetProfile.id);
await page.waitForTimeout(900);
await shot('04b-e2e-preset');

// other views
await page.locator('.nav-item[data-view="extensions"]').click();
await page.waitForTimeout(500);
check('扩展库显示导入的扩展', (await page.locator('#viewRoot').innerText()).includes('ChromeHub Test Ext'));
await shot('05-e2e-extensions');
await page.locator('.nav-item[data-view="scripts"]').click();
await page.waitForTimeout(500);
check('脚本库显示导入的脚本', (await page.locator('#viewRoot').innerText()).includes('ChromeHub Test Script'));
await page.locator('.nav-item[data-view="settings"]').click();
await page.waitForTimeout(500);
check('设置页显示内核版本', (await page.locator('#viewRoot').innerText()).includes('158.0.8127.18'));
await shot('06-e2e-settings');

await page.waitForTimeout(600);
const saved = JSON.parse(fs.readFileSync(path.join(userData, 'state.json'), 'utf8'));
check('状态持久化到 state.json', saved.profiles.some((p) => p.name === 'UI 新建浏览器' && p.extensions.length === 1 && p.scripts.length === 1));
check('运行界面无渲染错误', errors.length === 0, errors.join('; '));

await app.close();
server.close();
console.log(fail.length ? `\n${fail.length} FAILED: ${fail.join(', ')}` : '\nALL PASS');
process.exit(fail.length ? 1 : 0);

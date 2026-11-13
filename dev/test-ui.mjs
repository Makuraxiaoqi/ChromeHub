import { _electron as electron } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'dev', 'shots');
fs.mkdirSync(shots, { recursive: true });

// isolate app data
const userData = path.join(root, 'dev', 'tmp-userdata');
fs.rmSync(userData, { recursive: true, force: true });
fs.mkdirSync(userData, { recursive: true });

const errors = [];
const app = await electron.launch({
  args: ['.', `--user-data-dir=${userData}`],
  cwd: root,
  env: { ...process.env, MV_TEST: '1' }
});
const page = await app.firstWindow();
page.on('console', (msg) => {
  if (msg.type() === 'error') console.log('[renderer:error]', msg.text());
  else console.log('[renderer]', msg.text());
});
page.on('pageerror', (err) => {
  errors.push(err.message);
  console.log('[pageerror]', err.stack || err.message);
});

const shot = async (name) => {
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
  console.log('shot:', name);
};

await page.waitForTimeout(1500);
console.log('title:', await page.title());
console.log('views:', await page.locator('.nav-item').count());
await shot('01-profiles');

for (const view of ['presets', 'extensions', 'scripts', 'settings']) {
  await page.locator(`.nav-item[data-view="${view}"]`).click();
  await page.waitForTimeout(400);
  await shot(`02-${view}`);
}

await page.locator('.nav-item[data-view="profiles"]').click();
await page.waitForTimeout(300);
await page.locator('#viewActions button', { hasText: '新建浏览器' }).click();
await page.waitForTimeout(600);
await shot('03-browser-modal');

console.log('errors:', errors.length, errors);
await app.close();

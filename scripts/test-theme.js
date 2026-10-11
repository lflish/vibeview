// Run with Node and Playwright/Chromium installed. All data stays in a temp directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeview-theme-'));
  let server, browser;
  let logs = '';
  try {
    const socket = net.createServer().listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    const config = path.join(temp, 'config.json');
    fs.writeFileSync(config, JSON.stringify({
      server: { port, base_url: base }, storage: { retention_days: 0 },
      admin: { user: 'test', password: 'theme-test', session_secret: 'isolated-theme-test' },
    }));
    server = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DVIEW_CONFIG_PATH: config, DVIEW_PREVIEW_PROXY: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', data => { logs += data; });
    server.stderr.on('data', data => { logs += data; });
    for (let n = 0; n < 60; n++) {
      try { if ((await fetch(`${base}/healthz`)).ok) break; } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    for (const [asset, mime] of [['theme.js', 'javascript'], ['theme.css', 'text/css']]) {
      const response = await fetch(`${base}/admin/${asset}`);
      assert.equal(response.status, 200);
      assert.ok(response.headers.get('content-type').includes(mime));
    }
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ colorScheme: 'dark' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const theme = async (target, expected) => {
      await target.waitForFunction(value => document.documentElement.dataset.theme === value, expected);
      assert.equal(await target.evaluate(() => getComputedStyle(document.body).backgroundColor),
        expected === 'light' ? 'rgb(246, 248, 251)' : 'rgb(26, 26, 26)');
    };
    await page.goto(`${base}/admin/login`);
    await theme(page, 'light'); // OS dark must not override the default.
    await page.getByLabel('主题', { exact: true }).selectOption('dark');
    await page.reload();
    await theme(page, 'dark');
    await page.locator('#user').fill('test');
    await page.locator('#password').fill('theme-test');
    await page.locator('button[type=submit]').click();
    await page.waitForURL(`${base}/admin`);
    await theme(page, 'dark');
    await page.getByLabel('主题', { exact: true }).selectOption('light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await theme(page, 'light');
    await page.getByLabel('主题', { exact: true }).selectOption('system');
    await theme(page, 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await theme(page, 'light');
    await page.reload();
    assert.equal(await page.locator('#theme-select').inputValue(), 'system');

    const second = await context.newPage();
    await second.goto(`${base}/admin/login`);
    await second.getByLabel('主题', { exact: true }).selectOption('dark');
    await theme(page, 'dark'); // Preferences propagate across open tabs.
    await second.evaluate(() => localStorage.clear());
    await theme(page, 'light');
    await second.evaluate(() => localStorage.setItem('vibeview-theme', 'invalid'));
    await second.reload();
    await theme(second, 'light');

    await page.setViewportSize({ width: 375, height: 812 });
    const picker = await page.locator('#theme-select').boundingBox();
    assert.ok(picker.x >= 0 && picker.x + picker.width <= 375);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

    const restricted = await browser.newContext();
    await restricted.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new DOMException('Blocked', 'SecurityError'); };
      Storage.prototype.setItem = () => { throw new DOMException('Blocked', 'SecurityError'); };
    });
    const blocked = await restricted.newPage();
    blocked.on('pageerror', error => errors.push(error.message));
    await blocked.goto(`${base}/admin/login`);
    await theme(blocked, 'light');
    await blocked.getByLabel('主题', { exact: true }).selectOption('dark');
    await theme(blocked, 'dark');
    assert.deepEqual(errors, []);
    console.log('theme browser: defaults, persistence, login/admin, system changes, tab sync, mobile, blocked storage passed');
  } catch (error) {
    console.error(logs);
    throw error;
  } finally {
    if (browser) await browser.close();
    if (server && server.exitCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

// Optional browser regression check: requires Playwright and its Chromium browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { chromium } = require('playwright');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeview-ui-'));
  let server;
  let browser;
  let logs = '';
  try {
    const socket = net.createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    fs.mkdirSync(path.join(root, 'data/meta'), { recursive: true });
    for (let n = 0; n < 21; n++) {
      const id = String(n).padStart(16, '0');
      const dir = path.join(root, 'data/html', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'page.html'), '<title>UI fixture</title>');
      fs.writeFileSync(path.join(root, 'data/meta', `${id}.json`), JSON.stringify({
        id, type: 'html', filename: `page-${n}.html`, description: `页面简介 ${n}`,
        size: 25, source: 'ui-test', createdAt: new Date(2026, 0, n + 1).toISOString(),
      }));
    }
    const configPath = path.join(root, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      server: { port, base_url: base }, storage: { retention_days: 0 },
      admin: { user: 'test', password: 'ui-test-password', session_secret: 'temporary-ui-test' },
      tokens: [{ name: 'ui-test', token: 'temporary-ui-token' }],
    }));
    server = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'), env: { ...process.env, DVIEW_CONFIG_PATH: configPath, DVIEW_PREVIEW_PROXY: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', (data) => { logs += data; });
    server.stderr.on('data', (data) => { logs += data; });
    for (let attempt = 0; attempt < 50; attempt++) {
      try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}/admin/login`);
    await page.locator('input[name=user]').fill('test');
    await page.locator('input[name=password]').fill('ui-test-password');
    await page.locator('button[type=submit]').click();
    await page.waitForSelector('#rows tr');
    assert.equal(await page.locator('#rows tr').count(), 20);
    assert.equal(await page.locator('#rows .description').first().textContent(), '页面简介 20');
    assert.match(await page.locator('#rows .age').first().textContent(), /已持续/);
    await page.locator('#select-all').check();
    assert.equal(await page.locator('#selected-count').textContent(), '已选 20 项');
    await page.locator('#next').click();
    await page.waitForFunction(() => document.querySelector('#page-num').textContent === '2 / 2');
    assert.equal(await page.locator('#rows tr').count(), 1);
    assert.equal(await page.locator('#btn-bulk-delete').isDisabled(), true);
    await page.locator('#q').fill('no matching resource');
    await page.waitForSelector('#empty-filter', { state: 'visible' });
    assert.equal(await page.locator('#table-wrap').isVisible(), false);
    assert.equal(await page.locator('#pager').isVisible(), false);
    await page.locator('#q-clear').click();
    await page.waitForSelector('#rows tr');
    await page.locator('.row-check').nth(0).check();
    await page.locator('.row-check').nth(1).check();
    await page.locator('#btn-bulk-delete').click();
    await page.locator('#del-cancel').click();
    assert.equal(await page.locator('#rows tr').count(), 20);
    await page.locator('#btn-bulk-delete').click();
    await page.locator('#del-ok').click();
    await page.waitForFunction(() => document.querySelector('#stats').textContent === '共 19 项');
    assert.equal(await page.locator('.row-check:checked').count(), 0);
    // An older failed request must not overwrite a successful newer search.
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let observed;
    const started = new Promise((resolve) => { observed = resolve; });
    await page.route('**/admin/api/list?**', async (route) => {
      if (new URL(route.request().url()).searchParams.get('q') === 'slow') {
        observed();
        await gate;
        await route.abort('failed');
      } else await route.continue();
    });
    await page.locator('#q').fill('slow');
    await started;
    await page.locator('#q').fill('页面简介');
    await page.waitForFunction(() => document.querySelector('#stats').textContent.includes('匹配 19'));
    release();
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#error').isVisible(), false);
    assert.equal(await page.locator('#table-wrap').isVisible(), true);
    assert.deepEqual(errors, []);
    console.log('admin browser: pagination, descriptions, age, empty state, selection, bulk delete, stale request passed');
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
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

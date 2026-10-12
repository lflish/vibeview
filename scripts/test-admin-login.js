const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { createAdminLoginProtection } = require('../lib/admin-login');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeview-admin-login-'));
let server, browser;
async function stop() {
  if (server && server.exitCode === null) { const done = once(server, 'exit'); server.kill(); await done; }
}
async function run() {
  let time = 1000;
  const options = { loginAttemptsFile: path.join(temp, 'unit.json'), loginMaxAttempts: 3, loginGlobalMaxAttempts: 6, loginRetryWindowMinutes: 1 };
  const a = { ip: '192.0.2.1' }, b = { ip: '192.0.2.2' };
  let protection = createAdminLoginProtection(options, () => time);
  for (let n = 0; n < 3; n++) { assert.equal(protection.check(a).allowed, true); protection.failed(a); }
  assert.equal(protection.check({ ...a, body: { user: 'another-name' }, headers: { 'x-real-ip': '192.0.2.99' } }).allowed, false);
  protection = createAdminLoginProtection(options, () => time);
  assert.equal(protection.check(a).allowed, false, 'restart preserves IP cooldown');
  assert.equal(protection.check(b).allowed, true, 'other clients are independent below global cap');
  for (let n = 0; n < 3; n++) protection.failed(b);
  assert.equal(protection.check({ ip: '192.0.2.3' }).allowed, false, 'global cap covers rotating IPs');
  time += 60001;
  assert.equal(protection.check(a).allowed, true, 'cooldown restores login');
  protection.failed(a); protection.succeeded(a);
  assert.equal(protection.check(a).allowed, true);
  const saved = JSON.parse(fs.readFileSync(options.loginAttemptsFile, 'utf8'));
  assert.equal(saved.find(([key]) => key === 'global')[1].count, 1, 'success cannot erase distributed failures');
  assert.ok(!JSON.stringify(saved).includes(a.ip));
  assert.equal(fs.statSync(options.loginAttemptsFile).mode & 0o777, 0o600);
  console.log('admin login unit: per-client/global limits, persistence, cooldown, success, private state passed');

  const socket = net.createServer().listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`, configPath = path.join(temp, 'config.json');
  const cfg = { server: { port, base_url: base, trust_proxy: false }, storage: { retention_days: 0 },
    tokens: [{ name: 'private-source-name', token: 'private-upload-token' }],
    admin: { user: 'test', password: 'isolated-password', session_secret: 'isolated-admin-test', login_max_attempts: 3, login_global_max_attempts: 6 } };
  async function start() {
    fs.writeFileSync(configPath, JSON.stringify(cfg));
    let logs = '';
    server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DVIEW_CONFIG_PATH: configPath, DVIEW_PREVIEW_PROXY: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', d => logs += d); server.stderr.on('data', d => logs += d);
    for (let n = 0; n < 100; n++) {
      if (server.exitCode !== null) throw Error(logs);
      try { if ((await fetch(base + '/healthz')).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error('Admin login test service not ready: ' + logs);
  }
  const request = (url, options = {}) => fetch(base + url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(10000) });
  const login = (user = 'test', password = 'wrong', headers = {}) => request('/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams({ user, password }),
  });
  await start();
  const home = await request('/'); assert.equal(home.status, 200); const homeHtml = await home.text();
  assert.ok(homeHtml.includes('可分享的预览')); assert.ok(!homeHtml.includes('private-source-name')); assert.ok(!homeHtml.includes('private-upload-token'));
  assert.equal((await login('test', 'isolated-password', { origin: 'https://untrusted.invalid' })).status, 403);
  for (let n = 0; n < 3; n++) {
    const failed = await login('changing-user-' + n, 'wrong', { 'x-forwarded-for': `192.0.2.${n}`, 'x-real-ip': `198.51.100.${n}` });
    assert.equal(failed.status, 302); assert.equal(failed.headers.get('location'), '/admin/login?error=1');
  }
  let blocked = await login('test', 'isolated-password'); assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0); assert.equal(blocked.headers.get('cache-control'), 'no-store');
  assert.match(await blocked.text(), /data-login-retry-after="[1-9]\d*"/);
  assert.equal(blocked.headers.get('set-cookie'), null);
  assert.equal((await request('/admin/api/list')).status, 401);
  if (process.argv.includes('--browser')) {
    const { chromium } = require('playwright'); browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 1000 }); await page.goto(base);
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(246, 248, 251)');
      await page.getByRole('button', { name: '30 天', exact: true }).click(); assert.equal(await page.locator('#preview-total').textContent(), '164');
      await page.getByRole('button', { name: '7 天', exact: true }).click(); assert.equal(await page.locator('#preview-total').textContent(), '48');
      await page.getByRole('tab', { name: 'curl', exact: true }).click(); assert.match(await page.locator('#upload-command').textContent(), /curl -fsS/);
      await page.getByRole('tab', { name: 'CLI', exact: true }).click();
      await page.getByRole('button', { name: '复制命令', exact: true }).click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await page.locator('#upload-command').textContent());
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.equal(await page.locator('a[href="/admin"]').count(), 3);
      await page.screenshot({ path: `/tmp/vibeview-home-${width}.png`, fullPage: true });
    }
    await page.goto(base + '/admin/login'); await page.locator('#user').fill('test'); await page.locator('#password').fill('isolated-password');
    await page.clock.install();
    const rejection = page.waitForResponse(r => r.url() === base + '/admin/login' && r.request().method() === 'POST');
    await page.locator('#submit').click(); assert.equal((await rejection).status(), 429);
    await page.waitForFunction(() => document.getElementById('submit').disabled && document.getElementById('err').textContent.includes('登录尝试次数过多'));
    await page.clock.fastForward(601000);
    assert.equal(await page.locator('#submit').isDisabled(), false);
    assert.deepEqual(errors, []); await browser.close(); browser = null;
    console.log('home/login browser: responsive layout, chart, CLI/curl, clipboard, cooldown countdown passed');
  }
  await stop(); await start();
  assert.equal((await login('test', 'isolated-password')).status, 429, 'restart does not clear login lock');
  await stop(); cfg.server.trust_proxy = 'loopback'; cfg.admin.login_attempts_file = './data/proxy-login.json'; await start();
  for (let n = 0; n < 3; n++) assert.equal((await login('changing-' + n, 'wrong', { 'x-forwarded-for': `203.0.113.${n}, 198.51.100.10` })).status, 302);
  assert.equal((await login('test', 'isolated-password', { 'x-forwarded-for': '203.0.113.99, 198.51.100.10' })).status, 429, 'spoofed leftmost XFF cannot bypass trusted proxy');
  for (const ip of ['198.51.100.11', '198.51.100.12', '198.51.100.13']) assert.equal((await login('test', 'wrong', { 'x-forwarded-for': ip })).status, 302);
  assert.equal((await login('test', 'isolated-password', { 'x-forwarded-for': '198.51.100.14' })).status, 429, 'global cap bounds rotating IPs');
  await stop(); await start(); assert.equal((await login('test', 'isolated-password', { 'x-forwarded-for': '198.51.100.14' })).status, 429);
  const stateFile = path.join(temp, 'data/proxy-login.json');
  const state = fs.readFileSync(stateFile, 'utf8'); assert.ok(!state.includes('isolated-password')); assert.ok(!state.includes('198.51.100'));
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  // Simulate an expired window in this isolated fixture instead of waiting ten minutes.
  await stop(); fs.writeFileSync(stateFile, JSON.stringify(JSON.parse(state).map(([key, entry]) => [key, { ...entry, until: Date.now() - 1 }]))); await start();
  const valid = await login('test', 'isolated-password', { 'x-forwarded-for': '198.51.100.14' }); assert.equal(valid.status, 302);
  assert.equal(valid.headers.get('location'), '/admin'); const cookie = valid.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/admin/api/list', { headers: { cookie } })).status, 200);
  console.log('admin login integration: direct/proxy IP spoofing, user rotation, global cap, restart, 429, session and expiry passed');
}

run().finally(async () => {
  if (browser) await browser.close(); await stop(); fs.rmSync(temp, { recursive: true, force: true });
}).catch(error => { console.error(error); process.exitCode = 1; });

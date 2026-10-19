const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const root = path.join(__dirname, '..');
const children = [];
const directories = [];
const servers = [];
async function port() {
  const s = net.createServer().listen(0, '127.0.0.1'); await once(s, 'listening');
  const n = s.address().port; await new Promise(resolve => s.close(resolve)); return n;
}
async function start(file, env, url) {
  const child = spawn(process.execPath, [file], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child); let logs = '';
  child.stdout.on('data', d => { logs += d; }); child.stderr.on('data', d => { logs += d; });
  for (let n = 0; n < 100; n++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(url + '/healthz')).ok) return; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Service not ready: ' + logs);
}
const request = (url, options = {}) => fetch(url, { redirect: 'manual', ...options, signal: AbortSignal.timeout(10000) });
async function scenario(proxy) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeview-access-')); directories.push(temp);
  const mainPort = await port(), renderPort = await port();
  const base = `http://127.0.0.1:${mainPort}`, render = `http://127.0.0.1:${renderPort}`;
  let browserBase = base;
  if (!proxy && process.argv.includes('--browser')) {
    // Exercise the production topology: HTTPS termination in front of HTTP
    // Express. This certificate and TLS bypass are only for the local fixture.
    const key = path.join(temp, 'tls.key'), cert = path.join(temp, 'tls.crt');
    await execFile('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-keyout', key, '-out', cert]);
    const frontend = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
      const upstream = http.request(base + req.url, { method: req.method, headers: { ...req.headers, 'x-forwarded-proto': 'https' } }, response => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      });
      upstream.on('error', () => { res.writeHead(502); res.end(); });
      req.pipe(upstream);
    });
    servers.push(frontend); frontend.listen(0, '127.0.0.1'); await once(frontend, 'listening');
    browserBase = `https://127.0.0.1:${frontend.address().port}`;
  }
  const data = path.join(temp, 'data'); fs.mkdirSync(path.join(data, 'meta'), { recursive: true });
  const legacy = 'Legacy0000000000';
  fs.mkdirSync(path.join(data, 'html', legacy), { recursive: true });
  fs.writeFileSync(path.join(data, 'html', legacy, 'page.html'), 'LEGACY SECRET');
  fs.writeFileSync(path.join(data, 'meta', legacy + '.json'), JSON.stringify({ id: legacy, type: 'html', filename: 'page.html', source: 'owner', createdAt: new Date().toISOString() }));
  const cfg = path.join(temp, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ server: { port: mainPort, base_url: browserBase }, storage: { retention_days: 0 },
    tokens: [{ name: 'owner', token: 'owner-token' }, { name: 'other', token: 'other-token' }],
    admin: { user: 'test', password: 'test-password', session_secret: 'test-secret' },
    preview: { proxy_to_render: proxy, render_url: render, gateway_token: 'private-test-gateway' } }));
  if (proxy) await start('render-server.js', { RENDER_PORT: String(renderPort), RENDER_DATA_ROOT: data, RENDER_GATEWAY_TOKEN: 'private-test-gateway' }, render);
  await start('server.js', { DVIEW_CONFIG_PATH: cfg, DVIEW_PREVIEW_PROXY: String(proxy), DVIEW_RENDER_GATEWAY_TOKEN: 'private-test-gateway' }, base);
  const upload = async (type = 'text/html', name = 'private.html', body = '<title>SENSITIVE TITLE</title><h1>SECRET PAYLOAD</h1>', extra = {}) => {
    const form = new FormData(); form.append('file', new Blob([body], { type }), name);
    for (const [k, v] of Object.entries(extra)) form.append(k, v);
    const response = await request(base + '/upload', { method: 'POST', headers: { Authorization: 'Bearer owner-token' }, body: form });
    assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /no-store/);
    return response.json();
  };
  const item = await upload(); const url = base + '/v/' + item.id;
  assert.match(item.accessCode, /^[A-Za-z2-9]{12}$/);
  assert.equal(item.access.required, true);
  assert.ok(Math.abs(Date.parse(item.access.expiresAt) - Date.now() - 7 * 86400000) < 10000);
  const metaPath = path.join(data, 'meta', item.id + '.json');
  assert.ok(!fs.readFileSync(metaPath, 'utf8').includes(item.accessCode));
  const unlock = async (code, target = url, headers = {}) => request(target + '/unlock', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams({ code }) });
  let response = await request(url); assert.equal(response.status, 401);
  assert.equal(response.headers.get('referrer-policy'), 'same-origin');
  assert.ok(!(await response.text()).includes('SENSITIVE TITLE'));
  assert.match(response.headers.get('cache-control'), /no-store/);
  for (const [mime, name] of [['image/png', 'private.png'], ['video/mp4', 'private.mp4']]) {
    const media = await upload(mime, name, 'MEDIA PAYLOAD');
    const mediaUrl = base + '/v/' + media.id;
    assert.equal((await request(mediaUrl + '/raw')).status, 403);
    const permission = await unlock(media.accessCode, mediaUrl);
    const mediaCookie = permission.headers.get('set-cookie').split(';')[0];
    assert.equal((await request(mediaUrl, { headers: { cookie: mediaCookie } })).status, 200);
    const range = await request(mediaUrl + '/raw', { headers: { cookie: mediaCookie, Range: 'bytes=0-4' } });
    assert.equal(range.status, 206); assert.match(range.headers.get('cache-control'), /no-store/);
  }
  for (const [suffix, opts] of [['/raw', {}], ['/raw', { headers: { Range: 'bytes=0-5' } }], ['', { method: 'HEAD' }], ['/', {}]]) {
    response = await request(url + suffix, opts); assert.ok([401, 403].includes(response.status));
  }
  assert.equal((await request(base + '/v/' + legacy)).status, 401);
  assert.equal((await unlock('wrong')).status, 403);
  assert.equal((await unlock(item.accessCode, url, { origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await unlock(item.accessCode, url, { origin: 'null' })).status, 403);
  response = await unlock(item.accessCode); assert.equal(response.status, 303);
  const grant = response.headers.get('set-cookie').split(';')[0];
  assert.match(response.headers.get('set-cookie'), /HttpOnly/); assert.match(response.headers.get('set-cookie'), /SameSite=Strict/);
  response = await request(url, { headers: { cookie: grant } }); assert.equal(response.status, 200);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.ok((await response.text()).includes('SECRET PAYLOAD'));
  assert.match(response.headers.get('content-security-policy'), /sandbox allow-scripts/);
  assert.ok(!response.headers.get('content-security-policy').includes('allow-same-origin'));
  response = await request(url + '/raw', { headers: { cookie: grant, Range: 'bytes=0-5' } }); assert.equal(response.status, 206);
  assert.match(response.headers.get('cache-control'), /no-store/);
  const another = await upload(); assert.equal((await request(base + '/v/' + another.id, { headers: { cookie: grant } })).status, 401);
  assert.equal((await request(url, { headers: { cookie: grant + 'tampered' } })).status, 401);
  if (proxy) {
    assert.equal((await request(render + '/v/' + item.id)).status, 403);
    assert.equal((await request(render + '/v/' + item.id + '/raw', { headers: { 'x-preview-gateway': 'wrong' } })).status, 403);
    assert.equal((await request(url, { headers: { 'x-preview-gateway': 'private-test-gateway' } })).status, 401);
  }
  const login = await request(base + '/admin/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ user: 'test', password: 'test-password' }) });
  assert.equal(login.headers.get('location'), '/admin'); const admin = login.headers.get('set-cookie').split(';')[0];
  const patch = (payload, id = item.id, headers = { cookie: admin }, endpoint = '/admin/api/item/') => request(base + endpoint + id + '/access', { method: 'PATCH', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) });
  assert.equal((await patch({ mode: 'public' }, item.id, {})).status, 401);
  assert.equal((await patch({ mode: 'public' }, item.id, { cookie: admin, origin: 'null' })).status, 403);
  assert.equal((await patch({ mode: 'public' }, item.id, { Authorization: 'Bearer other-token' }, '/api/me/items/')).status, 403);
  assert.equal((await patch({ mode: 'code', expiresAt: 'invalid' })).status, 400);
  response = await patch({ mode: 'code', expiresAt: null, reset: true }); assert.equal(response.status, 200); const reset = await response.json();
  assert.notEqual(reset.accessCode, item.accessCode);
  // Admins can read the current code back; it is sealed at rest and never listed.
  const reveal = (id = item.id, headers = { cookie: admin }) => request(base + '/admin/api/item/' + id + '/access-code', { headers });
  assert.equal((await reveal(item.id, {})).status, 401);
  assert.equal((await reveal(item.id, { Authorization: 'Bearer owner-token' })).status, 401);
  response = await reveal(); assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal((await response.json()).accessCode, reset.accessCode);
  assert.ok(!fs.readFileSync(metaPath, 'utf8').includes(reset.accessCode));
  assert.equal((await request(url, { headers: { cookie: grant } })).status, 401);
  assert.equal((await unlock(item.accessCode)).status, 403);
  response = await unlock(reset.accessCode); assert.equal(response.status, 303); const newGrant = response.headers.get('set-cookie').split(';')[0];
  // Change validity without changing the code, and revoke existing grants.
  response = await patch({ mode: 'code', expiresAt: new Date(Date.now() + 60000).toISOString() });
  assert.equal((await response.json()).accessCode, undefined);
  assert.equal((await (await reveal()).json()).accessCode, reset.accessCode, 'validity change keeps a readable code');
  assert.equal((await request(url, { headers: { cookie: newGrant } })).status, 401);
  response = await unlock(reset.accessCode); assert.equal(response.status, 303); const expiringGrant = response.headers.get('set-cookie').split(';')[0];
  // Simulate the passage of time without resetting the access version.
  const expiredMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); expiredMeta.access.expiresAt = new Date(Date.now() - 1000).toISOString(); fs.writeFileSync(metaPath, JSON.stringify(expiredMeta));
  assert.equal((await request(url, { headers: { cookie: expiringGrant } })).status, 401);
  assert.equal((await unlock(reset.accessCode)).status, 403);
  assert.ok(fs.existsSync(path.join(data, 'html', item.id, 'private.html')));
  response = await request(base + '/admin/api/list?pageSize=100', { headers: { cookie: admin } }); const list = await response.json();
  assert.equal(list.items.find(i => i.id === item.id).access.expired, true);
  assert.ok(!JSON.stringify(list).includes(reset.accessCode)); assert.ok(!JSON.stringify(list).includes(expiredMeta.access.hash));
  assert.equal((await patch({ mode: 'public' })).status, 200);
  assert.equal((await request(url)).status, 200); assert.equal((await request(url + '/raw')).status, 200);
  assert.equal((await reveal(legacy)).status, 409, 'legacy resources have no readable code');
  response = await patch({ mode: 'code', expiresAt: null }, legacy); assert.equal(response.status, 200); const legacyCode = (await response.json()).accessCode;
  assert.equal((await (await reveal(legacy)).json()).accessCode, legacyCode);
  const legacyPath = path.join(data, 'meta', legacy + '.json'); const sealedMeta = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
  fs.writeFileSync(legacyPath, JSON.stringify({ ...sealedMeta, access: { ...sealedMeta.access, salt: 'f'.repeat(32) } }));
  assert.equal((await reveal(legacy)).status, 409, 'sealed code is bound to its salt');
  fs.writeFileSync(legacyPath, JSON.stringify(sealedMeta));
  assert.equal((await unlock(legacyCode, base + '/v/' + legacy)).status, 303);
  const publicItem = await upload('text/html', 'public.html', 'PUBLIC', { access_mode: 'public' });
  assert.equal(publicItem.accessCode, undefined);
  const publicPage = await request(base + '/v/' + publicItem.id);
  assert.equal(publicPage.status, 200);
  assert.match(publicPage.headers.get('content-security-policy') || '', /sandbox allow-scripts/, 'public HTML is sandboxed too');
  assert.equal((await reveal(publicItem.id)).status, 409);
  const badForm = new FormData(); badForm.append('file', new Blob(['bad']), 'bad.html'); badForm.append('access_days', 'NaN');
  assert.equal((await request(base + '/upload', { method: 'POST', headers: { Authorization: 'Bearer owner-token' }, body: badForm })).status, 400);
  const rateItem = await upload();
  for (let n = 0; n < 10; n++) assert.equal((await unlock('invalid', base + '/v/' + rateItem.id, { 'x-forwarded-for': `192.0.2.${n}` })).status, 403);
  const limited = await unlock(rateItem.accessCode, base + '/v/' + rateItem.id);
  assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('retry-after')) > 0);
  const cliFile = path.join(temp, 'cli.html'); fs.writeFileSync(cliFile, 'CLI');
  const cli = await execFile('bash', ['bin/dview', 'upload', cliFile, '--json', '--access-days', '1'], { cwd: root, env: { ...process.env, DVIEW_URL: base, DVIEW_TOKEN: 'owner-token' } });
  const cliResult = JSON.parse(cli.stdout); assert.ok(cliResult.accessCode); assert.ok(Math.abs(Date.parse(cliResult.access.expiresAt) - Date.now() - 86400000) < 10000);
  const skill = await execFile('bash', ['skill/dview-upload/upload.sh', cliFile, '--json'], { cwd: root, env: { ...process.env, DVIEW_URL: base, DVIEW_TOKEN: 'owner-token' } });
  const skillResult = JSON.parse(skill.stdout); assert.ok(skillResult.url); assert.ok(skillResult.accessCode); assert.ok(skillResult.access.expiresAt);
  if (!proxy && process.argv.includes('--browser')) await browserChecks(base, browserBase, admin);
  console.log(`access integration (${proxy ? 'sidecar proxy' : 'local'}): defaults, hash privacy, raw/HEAD/Range, grants, reset, expiry, ownership, legacy, public, admin code read-back, rate limit, CLI passed`);
}
async function browserChecks(base, browserBase, admin) {
  const { chromium } = require('playwright'); const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true }); const [name, ...value] = admin.split('=');
    await context.addCookies([{ name, value: value.join('='), url: browserBase, httpOnly: true }]);
    const fixtureForm = new FormData();
    fixtureForm.append('file', new Blob(['<title>SENSITIVE TITLE</title><h1>SECRET PAYLOAD</h1>'], { type: 'text/html' }), 'browser-private.html');
    const fixtureResponse = await request(base + '/upload', { method: 'POST', headers: { Authorization: 'Bearer owner-token' }, body: fixtureForm });
    assert.equal(fixtureResponse.status, 200);
    const fixture = await fixtureResponse.json();
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(browserBase + '/admin'); await page.waitForSelector('#rows tr');
    const row = page.locator(`#rows tr[data-id="${fixture.id}"]`);
    await row.locator('.access-badge').click(); await page.locator('#access-reset').click();
    // The dialog first shows the current code; wait for the reset one.
    await page.waitForFunction(() => document.querySelector('#access-code-label').textContent.startsWith('新访问码')
      && document.querySelector('#access-code').value.length === 12);
    const code = await page.locator('#access-code').inputValue();
    const id = fixture.id;
    const visitor = await browser.newContext({ ignoreHTTPSErrors: true }); const preview = await visitor.newPage();
    const previewUrl = browserBase + '/v/' + id;
    await preview.goto(previewUrl);
    // Reject null/external origins even with the right code.
    for (const origin of ['null', 'https://untrusted.invalid']) {
      const denied = await visitor.request.post(previewUrl + '/unlock', {
        headers: { Origin: origin }, form: { code }, maxRedirects: 0,
      });
      assert.equal(denied.status(), 403);
    }
    // Invalid-code responses must also leave a usable form for retrying.
    await preview.getByLabel('访问码', { exact: true }).fill('wrong');
    const failure = preview.waitForResponse(r => r.url() === previewUrl + '/unlock');
    await preview.locator('button').click(); assert.equal((await failure).status(), 403);
    await preview.getByRole('alert').waitFor();
    await preview.getByLabel('访问码', { exact: true }).fill(code);
    const submitted = preview.waitForRequest(r => r.url() === previewUrl + '/unlock');
    const unlocked = preview.waitForResponse(r => r.url() === previewUrl + '/unlock');
    await preview.locator('button').click();
    assert.equal((await submitted).headers().origin, browserBase);
    assert.equal((await unlocked).status(), 303);
    await preview.waitForURL(previewUrl);
    assert.equal(await preview.title(), 'SENSITIVE TITLE');
    assert.match(await preview.locator('body').innerText(), /SECRET PAYLOAD/);
    const grantCookie = (await visitor.cookies(previewUrl)).find(c => c.name === 'dview_access');
    assert.ok(grantCookie.secure); assert.ok(grantCookie.httpOnly); assert.equal(grantCookie.sameSite, 'Strict');
    await page.locator('#access-ttl').selectOption('1');
    await page.locator('#access-save').click();
    await page.waitForFunction(() => document.querySelector('#toasts').textContent.includes('有效期已更新'));
    const ownerList = await request(base + '/api/me/items', { headers: { Authorization: 'Bearer owner-token' } });
    const updated = (await ownerList.json()).items.find(i => i.id === id);
    assert.ok(Math.abs(Date.parse(updated.access.expiresAt) - Date.now() - 86400000) < 10000);
    await page.locator('#access-mode').selectOption('public'); await page.locator('#access-save').click();
    await page.waitForFunction(() => document.querySelector('#toasts').textContent.includes('已设为公开'));
    assert.equal((await request(base + '/v/' + id)).status, 200);
    await page.locator('#access-close').click(); assert.equal(await page.locator('#access-code').inputValue(), '');
    // Protected HTML cannot read management APIs even in an administrator's browser.
    const attackFile = '<script>window.probe=fetch("/admin/api/list",{credentials:"include"}).then(r=>r.text()).then(()=>"readable").catch(()=>"blocked");</script>';
    const form = new FormData(); form.append('file', new Blob([attackFile], { type: 'text/html' }), 'sandbox.html');
    const upload = await request(base + '/upload', { method: 'POST', headers: { Authorization: 'Bearer owner-token' }, body: form }); const item = await upload.json();
    const unlock = await request(base + '/v/' + item.id + '/unlock', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: item.accessCode }) });
    const parts = unlock.headers.get('set-cookie').split(';')[0].split('=');
    await context.addCookies([{ name: parts[0], value: parts.slice(1).join('='), url: browserBase + '/v/' + item.id, httpOnly: true }]);
    await page.goto(browserBase + '/v/' + item.id);
    assert.equal(await page.evaluate(() => window.probe), 'blocked');
    // Public HTML gets the same isolation; it has no access code to protect it otherwise.
    const publicForm = new FormData(); publicForm.append('file', new Blob([attackFile], { type: 'text/html' }), 'public-sandbox.html'); publicForm.append('access_mode', 'public');
    const publicUpload = await (await request(base + '/upload', { method: 'POST', headers: { Authorization: 'Bearer owner-token' }, body: publicForm })).json();
    await page.goto(browserBase + '/v/' + publicUpload.id);
    assert.equal(await page.evaluate(() => window.probe), 'blocked', 'public HTML cannot read admin APIs');
    assert.deepEqual(errors, []);
    console.log('access browser: HTTPS reverse proxy, form origin/retry/redirect, secure grant, admin controls, opaque HTML isolation (protected and public) passed');
  } finally { await browser.close(); }
}
async function missingGateway() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeview-no-gateway-')); directories.push(temp);
  const mainPort = await port(), renderPort = await port();
  const base = `http://127.0.0.1:${mainPort}`, render = `http://127.0.0.1:${renderPort}`;
  const config = path.join(temp, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ server: { port: mainPort, base_url: base },
    tokens: [{ name: 'owner', token: 'owner-token' }], storage: { retention_days: 0 },
    preview: { proxy_to_render: true, render_url: render } }));
  await start('render-server.js', { RENDER_PORT: String(renderPort), RENDER_DATA_ROOT: path.join(temp, 'data'), RENDER_GATEWAY_TOKEN: '' }, render);
  await start('server.js', { DVIEW_CONFIG_PATH: config, DVIEW_PREVIEW_PROXY: 'true', DVIEW_RENDER_GATEWAY_TOKEN: '' }, base);
  const form = new FormData(); form.append('file', new Blob(['SECRET']), 'private.html');
  const response = await request(base + '/upload', { method: 'POST', headers: { Authorization: 'Bearer owner-token' }, body: form });
  const item = await response.json();
  const unlock = await request(base + '/v/' + item.id + '/unlock', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: item.accessCode }) });
  const cookie = unlock.headers.get('set-cookie').split(';')[0];
  assert.equal((await request(base + '/v/' + item.id, { headers: { cookie } })).status, 503);
  assert.equal((await request(render + '/v/' + item.id, { headers: { 'x-preview-gateway': 'arbitrary' } })).status, 403);
  console.log('access integration: missing gateway credential denies protected content');
}
(async () => { try { await scenario(false); await scenario(true); await missingGateway(); } finally {
  for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  for (const child of children) if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  for (const dir of directories) fs.rmSync(dir, { recursive: true, force: true });
} })().catch(e => { console.error(e); process.exitCode = 1; });

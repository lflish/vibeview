// 多页面站点（zip 上传）：解压安全、访问保护、路径凭证、sidecar 代理和浏览器实测。
// 用法：node scripts/test-site.js [--browser]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const zlib = require('node:zlib');
const { once } = require('node:events');
const { spawn, execFile: execFileCb } = require('node:child_process');
const { promisify } = require('node:util');

const execFile = promisify(execFileCb);
const root = path.resolve(__dirname, '..');
const children = [];
const directories = [];
const port = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const request = (url, options = {}) => fetch(url, { redirect: 'manual', ...options, signal: AbortSignal.timeout(10000) });
// fetch 会丢掉 Sec-* 请求头；模拟浏览器页面跳转时用原始 http 请求
const navigate = (url) => new Promise((resolve, reject) => {
  require('node:http').get(url, { headers: { 'sec-fetch-mode': 'navigate' } }, (res) => { res.resume(); resolve(res); }).on('error', reject);
});

async function start(file, env, url) {
  const child = spawn(process.execPath, [file], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child); let logs = '';
  child.stdout.on('data', (d) => { logs += d; }); child.stderr.on('data', (d) => { logs += d; });
  for (let n = 0; n < 100; n++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(url + '/healthz')).ok) return; } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Service not ready: ' + logs);
}

// 最小 zip 写入器：可以造出正常包和各种恶意包（越界路径、符号链接、谎报大小）。
function zip(entries) {
  const locals = []; const centrals = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const data = Buffer.from(e.data ?? '');
    const deflate = e.deflate === true;
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const crc = zlib.crc32(data);
    const size = e.declaredSize ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(deflate ? 8 : 0, 8); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(deflate ? 8 : 0, 10); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, body); centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// 典型的打包产物：模块脚本 + fetch + 子页面 + 子目录，整体放在 dist/ 下（应自动去掉这一层）。
const SITE = [
  { name: 'dist/index.html', data: '<!doctype html><title>Site Home</title><meta name="description" content="Multi page demo"><link rel="stylesheet" href="style.css"><script type="module" crossorigin src="assets/app.js"></script><h1>HOME PAGE</h1><a id="about" href="about.html">About</a> <a href="docs/">Docs</a><output id="out"></output>' },
  { name: 'dist/about.html', data: '<!doctype html><title>About</title><link rel="stylesheet" href="style.css"><h1 id="h">ABOUT PAGE</h1><a href="./">Home</a>' },
  { name: 'dist/docs/index.html', data: '<!doctype html><title>Docs</title><h1>DOCS PAGE</h1>' },
  { name: 'dist/style.css', data: 'h1{color:rgb(37, 99, 235)}' },
  { name: 'dist/assets/app.js', data: "const r = await fetch('data.json'); document.getElementById('out').textContent = 'module:' + (await r.json()).value;\ntry { const a = await fetch('/admin/api/list'); document.body.dataset.admin = String(a.status); } catch { document.body.dataset.admin = 'blocked'; }" },
  { name: 'dist/data.json', data: '{"value":"DATA OK"}' },
  { name: 'dist/404.html', data: 'CUSTOM 404' },
  { name: 'dist/.DS_Store', data: 'junk' },
  { name: '__MACOSX/dist/._index.html', data: 'junk' },
  { name: 'dist/assets/', data: '' },
];

async function scenario(proxy, browser) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeview-site-')); directories.push(temp);
  const mainPort = await port(), renderPort = await port();
  const base = `http://127.0.0.1:${mainPort}`, render = `http://127.0.0.1:${renderPort}`;
  const data = path.join(temp, 'data'); fs.mkdirSync(data);
  const cfg = path.join(temp, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ server: { port: mainPort, base_url: base },
    storage: { retention_days: 0, site_max_files: 20, site_max_unpacked_mb: 1 },
    tokens: [{ name: 'owner', token: 'owner-token' }],
    admin: { user: 'test', password: 'test-password', session_secret: 'test-secret' },
    preview: { proxy_to_render: proxy, render_url: render, gateway_token: 'private-test-gateway' } }));
  if (proxy) await start('render-server.js', { RENDER_PORT: String(renderPort), RENDER_DATA_ROOT: data, RENDER_GATEWAY_TOKEN: 'private-test-gateway' }, render);
  await start('server.js', { DVIEW_CONFIG_PATH: cfg, DVIEW_PREVIEW_PROXY: String(proxy), DVIEW_RENDER_GATEWAY_TOKEN: 'private-test-gateway' }, base);

  const send = async (buffer, name = 'site.zip', extra = {}) => {
    const form = new FormData(); form.append('file', new Blob([buffer], { type: 'application/zip' }), name);
    for (const [k, v] of Object.entries(extra)) form.append(k, v);
    const response = await request(base + '/upload', { method: 'POST', headers: { Authorization: 'Bearer owner-token' }, body: form });
    return { status: response.status, body: await response.json() };
  };
  const sitesDir = path.join(data, 'sites');
  const leftovers = () => fs.readdirSync(sitesDir).filter((name) => name !== '.incoming').concat(fs.readdirSync(path.join(sitesDir, '.incoming')));

  // ---- 恶意或不合规的包：都被拒绝，且不留任何文件 ----
  const index = { name: 'index.html', data: 'ok' };
  const bad = [
    ['path traversal', [index, { name: '../escape.html', data: 'x' }], /invalid/],
    ['absolute path', [index, { name: '/etc/x.html', data: 'x' }], /absolute|invalid/],
    ['symbolic link', [index, { name: 'link.html', data: '/etc/passwd', mode: 0o120777 }], /symbolic/],
    ['reserved ~ segment', [index, { name: '~x/a.js', data: 'x' }], /invalid path/],
    ['unsupported type', [index, { name: 'tool.exe', data: 'MZ' }], /unsupported file type/],
    ['missing index', [{ name: 'about.html', data: 'x' }], /index\.html/],
    ['too many files', [index, ...Array.from({ length: 20 }, (_, i) => ({ name: `p${i}.html`, data: 'x' }))], /too many files/],
    ['too large unpacked', [index, { name: 'big.txt', data: 'a'.repeat(1.5 * 1024 * 1024), deflate: true }], /too large/],
    ['lying entry size', [index, { name: 'bomb.txt', data: 'a'.repeat(1.5 * 1024 * 1024), deflate: true, declaredSize: 10 }], /invalid zip entry|too large/],
    ['too many entries', [index, ...Array.from({ length: 1041 }, (_, i) => ({ name: `d${i}/`, data: '' }))], /too many entries/],
    ['duplicate path', [index, { name: 'A.html', data: 'x' }, { name: 'a.html', data: 'y' }], /duplicate/],
  ];
  for (const [label, entries, error] of bad) {
    const result = await send(zip(entries));
    assert.equal(result.status, 400, label);
    assert.match(result.body.error, error, label);
  }
  assert.equal((await send(Buffer.from('not a zip'))).status, 400, 'corrupt zip');
  assert.deepEqual(leftovers(), [], 'rejected uploads leave nothing behind');
  assert.ok(!fs.existsSync(path.join(temp, 'escape.html')) && !fs.existsSync(path.join(data, 'escape.html')));

  // ---- 正常上传 ----
  const upload = await send(zip(SITE), 'my-dist.zip', { category: 'prototype' });
  assert.equal(upload.status, 200, JSON.stringify(upload.body));
  const item = upload.body;
  assert.equal(item.type, 'site'); assert.equal(item.fileCount, 7); assert.ok(item.url.endsWith(`/v/${item.id}/`));
  assert.equal(item.description, 'Multi page demo'); assert.equal(item.category, 'prototype');
  assert.match(item.accessCode, /^[A-Za-z2-9]{12}$/);
  const siteDir = path.join(sitesDir, item.id);
  assert.ok(fs.existsSync(path.join(siteDir, 'index.html')), 'dist/ prefix stripped');
  assert.ok(!fs.existsSync(path.join(siteDir, '.DS_Store')) && !fs.existsSync(path.join(siteDir, '__MACOSX')), 'junk skipped');
  assert.deepEqual(fs.readdirSync(path.join(sitesDir, '.incoming')), [], 'zip removed after unpacking');
  const meta = JSON.parse(fs.readFileSync(path.join(data, 'meta', item.id + '.json'), 'utf8'));
  assert.equal(meta.archiveName, 'my-dist.zip'); assert.equal(meta.filename, 'index.html');
  assert.equal(meta.size, SITE.filter((e) => e.name.startsWith('dist/') && !e.name.endsWith('/') && !e.name.includes('.DS')).reduce((n, e) => n + Buffer.byteLength(e.data), 0));

  const url = base + '/v/' + item.id;
  // 未验证：入口和子页面都显示验证页，子页面记住要回到哪里
  let response = await request(url); assert.equal(response.status, 401);
  let body = await response.text(); assert.ok(!body.includes('HOME PAGE')); assert.ok(!body.includes('name="next"'));
  response = await request(url + '/about.html'); assert.equal(response.status, 401);
  body = await response.text(); assert.ok(!body.includes('ABOUT PAGE')); assert.match(body, /name="next" value="\/about\.html"/);
  assert.equal((await request(url + '/style.css')).status, 401);
  assert.equal((await request(url + '/~' + 'abc.def/style.css')).status, 403, 'forged token');
  assert.equal((await navigate(url + '/~abc.def/about.html')).headers.location, `/v/${item.id}/about.html`, 'stale token page goes back to verification');
  if (proxy) assert.equal((await request(render + '/v/' + item.id + '/style.css')).status, 403, 'sidecar requires the gateway');

  // 验证后回到子页面，再跳到带凭证的地址
  const unlock = (code, next) => request(url + '/unlock', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, ...(next ? { next } : {}) }) });
  for (const next of ['//evil.example/x', '/../meta/x.json', 'https://evil.example/', '/a\nb']) {
    const r = await unlock(item.accessCode, next); assert.equal(r.status, 303); assert.equal(r.headers.get('location'), `/v/${item.id}`, `unsafe next ${JSON.stringify(next)}`);
  }
  response = await unlock(item.accessCode, '/about.html');
  assert.equal(response.status, 303); assert.equal(response.headers.get('location'), `/v/${item.id}/about.html`);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  response = await request(url + '/about.html', { headers: { cookie } });
  assert.equal(response.status, 302);
  const tokenPath = response.headers.get('location');
  assert.match(tokenPath, new RegExp(`^/v/${item.id}/~[0-9a-z]+\\.[A-Za-z0-9_-]{22}/about\\.html$`));
  const tokenBase = base + tokenPath.replace(/about\.html$/, '');
  response = await request(url, { headers: { cookie } });
  assert.equal(response.status, 302); assert.match(response.headers.get('location'), /\/~[^/]+\/$/, 'entry redirects to token root');

  // 带凭证：不需要 cookie；沙箱、跨源读取、禁止缓存
  response = await request(tokenBase + 'about.html'); assert.equal(response.status, 200);
  assert.ok((await response.text()).includes('ABOUT PAGE'));
  assert.match(response.headers.get('content-security-policy'), /sandbox allow-scripts/);
  assert.ok(!response.headers.get('content-security-policy').includes('allow-same-origin'));
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  response = await request(tokenBase); assert.equal(response.status, 200); assert.ok((await response.text()).includes('HOME PAGE'));
  response = await request(tokenBase + 'style.css'); assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/css/);
  response = await request(tokenBase + 'assets/app.js'); assert.match(response.headers.get('content-type'), /javascript/);
  response = await request(tokenBase + 'docs'); assert.equal(response.status, 302); assert.equal(response.headers.get('location'), 'docs/');
  response = await request(tokenBase + 'docs/'); assert.ok((await response.text()).includes('DOCS PAGE'));
  response = await request(tokenBase + 'missing.js'); assert.equal(response.status, 404); assert.equal(await response.text(), 'CUSTOM 404');
  for (const probe of ['..%2f..%2fmeta%2f' + item.id + '.json', '%2e%2e/%2e%2e/meta/' + item.id + '.json', '.DS_Store', 'assets/..%2f..%2f..%2fconfig.json']) {
    response = await request(tokenBase + probe); assert.equal(response.status, 404, probe);
    assert.ok(!(await response.text()).includes('"hash"'), probe);
  }
  assert.equal((await request(tokenBase + 'about.html', { method: 'POST' })).status, 403);
  response = await request(tokenBase + 'data.json', { method: 'OPTIONS', headers: { origin: 'null', 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-test' } });
  assert.equal(response.status, 204); assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal((await request(tokenBase.replace(/\.[A-Za-z0-9_-]{22}\//, '.' + 'A'.repeat(22) + '/') + 'style.css')).status, 403, 'tampered signature');

  // 另一个站点的凭证不能用在这里
  const other = (await send(zip([{ name: 'index.html', data: 'OTHER' }]))).body;
  const otherCookie = (await request(base + '/v/' + other.id + '/unlock', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: other.accessCode }) })).headers.get('set-cookie').split(';')[0];
  const otherToken = (await request(base + '/v/' + other.id, { headers: { cookie: otherCookie } })).headers.get('location').split('/')[3];
  assert.equal((await request(`${url}/${otherToken}/style.css`)).status, 403, 'token bound to its site');

  // 管理端：类型、文件数、zip 名；重置访问码后旧凭证失效；改为公开后直接访问
  const login = await request(base + '/admin/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ user: 'test', password: 'test-password' }) });
  const admin = login.headers.get('set-cookie').split(';')[0];
  const list = await (await request(base + '/admin/api/list?pageSize=50&type=site', { headers: { cookie: admin } })).json();
  const row = list.items.find((i) => i.id === item.id);
  assert.equal(row.type, 'site'); assert.equal(row.fileCount, 7); assert.equal(row.filename, 'my-dist.zip');
  assert.ok(list.items.every((i) => i.type === 'site'));
  const patch = (payload) => request(base + '/admin/api/item/' + item.id + '/access', { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: admin }, body: JSON.stringify(payload) });
  assert.equal((await patch({ mode: 'code', expiresAt: null, reset: true })).status, 200);
  assert.equal((await request(tokenBase + 'style.css')).status, 403, 'reset revokes path tokens');
  assert.equal((await patch({ mode: 'public' })).status, 200);
  response = await request(url); assert.equal(response.status, 302); assert.equal(response.headers.get('location'), `/v/${item.id}/`);
  response = await request(url + '/'); assert.equal(response.status, 200); assert.ok((await response.text()).includes('HOME PAGE'));
  assert.match(response.headers.get('content-security-policy'), /sandbox allow-scripts/, 'public sites are sandboxed');
  response = await request(url + '/about.html'); assert.ok((await response.text()).includes('ABOUT PAGE'));
  assert.equal((await request(tokenBase + 'style.css')).status, 200, 'stale token paths still work once public');

  // CLI：上传目录（自动打包）和直接上传 zip
  const dir = path.join(temp, 'cli-site'); fs.mkdirSync(path.join(dir, 'css'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<title>CLI Site</title><link rel="stylesheet" href="css/a.css">CLI HOME');
  fs.writeFileSync(path.join(dir, 'css', 'a.css'), 'body{}');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
  const env = { ...process.env, DVIEW_URL: base, DVIEW_TOKEN: 'owner-token' };
  const cli = JSON.parse((await execFile('bash', ['bin/dview', 'upload', dir, '--json', '--public'], { cwd: root, env })).stdout);
  assert.equal(cli.type, 'site'); assert.equal(cli.fileCount, 2, 'dotfiles are not uploaded');
  assert.ok((await (await request(cli.url)).text()).includes('CLI HOME'));
  assert.ok(!fs.existsSync(path.join(sitesDir, cli.id, '.env')));
  const viaSkill = JSON.parse((await execFile('bash', ['skill/dview-upload/upload.sh', dir, '--json'], { cwd: root, env })).stdout);
  assert.equal(viaSkill.type, 'site'); assert.equal(viaSkill.fileCount, 2); assert.ok(viaSkill.accessCode);
  const zipFile = path.join(temp, 'direct.zip'); fs.writeFileSync(zipFile, zip([{ name: 'index.html', data: 'ZIP HOME' }]));
  const direct = JSON.parse((await execFile('bash', ['bin/dview', 'upload', zipFile, '--json'], { cwd: root, env })).stdout);
  assert.equal(direct.type, 'site'); assert.ok(direct.accessCode);
  await assert.rejects(execFile('bash', ['bin/dview', 'upload', path.join(dir, 'css'), '--json'], { cwd: root, env }), /index\.html/, 'CLI checks for index.html');

  if (browser) await browserChecks(base, (await send(zip(SITE))).body);

  // 删除站点会删掉整个目录
  response = await request(base + '/api/me/items/' + item.id, { method: 'DELETE', headers: { Authorization: 'Bearer owner-token' } });
  assert.equal(response.status, 200); assert.ok(!fs.existsSync(siteDir));
  console.log(`site integration (${proxy ? 'sidecar proxy' : 'local'}): unsafe zips rejected, unpacking, access, path tokens, sandbox, admin, public, CLI, delete passed`);
}

async function browserChecks(base, item) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext()).newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + '/v/' + item.id);
    await page.fill('#code', item.accessCode);
    await Promise.all([page.waitForURL(/\/~[^/]+\/$/), page.click('button')]);
    // 沙箱里的模块脚本和 fetch 能正常加载
    await page.waitForFunction(() => document.getElementById('out').textContent === 'module:DATA OK');
    await page.waitForFunction(() => document.body.dataset.admin);
    assert.notEqual(await page.evaluate(() => document.body.dataset.admin), '200', 'site cannot read admin APIs');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('h1')).color), 'rgb(37, 99, 235)');
    await Promise.all([page.waitForURL(/about\.html$/), page.click('#about')]);
    assert.equal(await page.textContent('#h'), 'ABOUT PAGE');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('h1')).color), 'rgb(37, 99, 235)');
    // 直接打开受保护子页面：验证后回到该子页面
    const fresh = await (await browser.newContext()).newPage();
    await fresh.goto(base + '/v/' + item.id + '/about.html');
    await fresh.fill('#code', item.accessCode);
    await Promise.all([fresh.waitForURL(/\/~[^/]+\/about\.html$/), fresh.click('button')]);
    assert.equal(await fresh.textContent('#h'), 'ABOUT PAGE');
    assert.deepEqual(errors, []);
    console.log('site browser: challenge, module scripts and fetch in sandbox, styles, sub-page navigation, deep-link return, admin isolation passed');
  } finally { await browser.close(); }
}

(async () => {
  const browser = process.argv.includes('--browser');
  try { await scenario(false, browser); if (!browser) await scenario(true, false); } finally {
    for (const child of children) if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    for (const dir of directories) fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });

// 资源版本化：更新同一链接、历史版本地址、访问码、旧数据兼容、版本上限、配额、站点与图片版本、CLI 映射。
// 用法：node scripts/test-versions.js
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

// 只存储（不压缩）的最小 zip
function zip(entries) {
  const locals = []; const centrals = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name); const data = Buffer.from(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(zlib.crc32(data), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(zlib.crc32(data), 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, data); centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const cd = Buffer.concat(centrals); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

async function scenario(proxy) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeview-versions-')); directories.push(temp);
  const mainPort = await port(), renderPort = await port();
  const base = `http://127.0.0.1:${mainPort}`, render = `http://127.0.0.1:${renderPort}`;
  const data = path.join(temp, 'data'); fs.mkdirSync(data);
  const cfg = path.join(temp, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ server: { port: mainPort, base_url: base },
    storage: { retention_days: 0 },
    versions: { max_per_resource: 3 },
    tokens: [{ name: 'owner', token: 'owner-token' }, { name: 'other', token: 'other-token' }, { name: 'small', token: 'small-token', max_files: 1 }],
    admin: { user: 'test', password: 'test-password', session_secret: 'test-secret' },
    preview: { proxy_to_render: proxy, render_url: render, gateway_token: 'private-test-gateway' } }));
  if (proxy) await start('render-server.js', { RENDER_PORT: String(renderPort), RENDER_DATA_ROOT: data, RENDER_GATEWAY_TOKEN: 'private-test-gateway' }, render);
  await start('server.js', { DVIEW_CONFIG_PATH: cfg, DVIEW_PREVIEW_PROXY: String(proxy), DVIEW_RENDER_GATEWAY_TOKEN: 'private-test-gateway' }, base);

  const send = async (content, { name = 'page.html', type = 'text/html', token = 'owner-token', ...extra } = {}) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(extra)) form.append(k, v);
    form.append('file', new Blob([content], { type }), name);
    const response = await request(base + '/upload', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    return { status: response.status, body: await response.json() };
  };
  const api = async (method, url, token = 'owner-token') => {
    const response = await request(base + url, { method, headers: { Authorization: `Bearer ${token}` } });
    return { status: response.status, body: await response.json() };
  };
  const readMeta = (id) => JSON.parse(fs.readFileSync(path.join(data, 'meta', id + '.json'), 'utf8'));
  const unlock = async (id, code, next) => {
    const response = await request(`${base}/v/${id}/unlock`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, ...(next ? { next } : {}) }) });
    return { response, cookie: (response.headers.get('set-cookie') || '').split(';')[0] };
  };
  const text = async (url, cookie) => {
    const response = await request(url, cookie ? { headers: { cookie } } : {});
    return { status: response.status, body: await response.text(), response };
  };

  // ---- HTML：更新同一链接，访问码不变 ----
  const first = await send('<title>Login v1</title>LOGIN V1', { category: 'prototype', tags: 'prd' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const { id, accessCode } = first.body;
  assert.equal(first.body.version, 1); assert.equal(first.body.updated, false);
  let meta = readMeta(id);
  assert.equal(meta.current, 1); assert.equal(meta.versions.length, 1); assert.equal(meta.versions[0].n, 1);

  const second = await send('<title>Login v2</title>LOGIN V2', { id, message: '补充错误提示', git_commit: 'ABCDEF1234', git_dirty: '1' });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.id, id); assert.equal(second.body.version, 2); assert.equal(second.body.updated, true);
  assert.equal(second.body.url, first.body.url, 'same link');
  assert.equal(second.body.versionUrl, `${base}/v/${id}/@2`);
  assert.equal(second.body.accessCode, undefined, 'access code is not reset');
  assert.equal(second.body.category, 'prototype'); assert.deepEqual(second.body.tags, ['prd'], 'labels kept');
  assert.equal(second.body.description, 'Login v2', 'title-derived description follows the new version');
  meta = readMeta(id);
  assert.equal(meta.current, 2); assert.ok(meta.updatedAt);
  assert.deepEqual(meta.versions[1].git, { commit: 'abcdef1234', dirty: true }); assert.equal(meta.versions[1].message, '补充错误提示');
  assert.equal(meta.size, Buffer.byteLength('<title>Login v1</title>LOGIN V1') + Buffer.byteLength('<title>Login v2</title>LOGIN V2'), 'size counts all versions');
  assert.ok(fs.existsSync(path.join(data, 'html', id, '.versions', '2', 'page.html')));
  assert.deepEqual(fs.readdirSync(path.join(data, 'html')).sort(), [id], 'staging directory moved, nothing left behind');

  // 未验证：历史版本也要访问码，验证后回到该版本
  let page = await text(`${base}/v/${id}/@1`);
  assert.equal(page.status, 401); assert.ok(!page.body.includes('LOGIN V1')); assert.match(page.body, /name="next" value="\/@1"/);
  assert.equal((await text(`${base}/v/${id}/@1/raw`)).status, 403);
  const { response: unlocked, cookie } = await unlock(id, accessCode, '/@1');
  assert.equal(unlocked.status, 303); assert.equal(unlocked.headers.get('location'), `/v/${id}/@1`);
  assert.ok((await text(`${base}/v/${id}`, cookie)).body.includes('LOGIN V2'), 'link shows latest');
  page = await text(`${base}/v/${id}/@1`, cookie);
  assert.equal(page.status, 200); assert.ok(page.body.includes('LOGIN V1'));
  assert.match(page.response.headers.get('content-security-policy'), /sandbox allow-scripts/, 'old HTML versions are sandboxed');
  assert.ok((await text(`${base}/v/${id}/@2`, cookie)).body.includes('LOGIN V2'));
  assert.ok((await text(`${base}/v/${id}/@1/raw`, cookie)).body.includes('LOGIN V1'));
  assert.equal((await text(`${base}/v/${id}/@9`, cookie)).status, 404);
  assert.equal((await text(`${base}/v/${id}/@0`, cookie)).status, 404);
  if (proxy) assert.equal((await text(`${render}/v/${id}/@1`)).status, 403, 'sidecar requires the gateway for versions');

  // ---- 权限与类型 ----
  let result = await send('NOPE', { id, token: 'other-token' });
  assert.equal(result.status, 403);
  result = await send(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { id, name: 'a.png', type: 'image/png' });
  assert.equal(result.status, 400); assert.match(result.body.error, /type mismatch/);
  assert.equal((await send('X', { id: 'AAAAAAAAAAAAAAAA' })).status, 404);
  assert.equal((await send('X', { id: '../etc' })).status, 400);
  assert.deepEqual(fs.readdirSync(path.join(data, 'html')).sort(), [id], 'rejected updates leave nothing behind');
  assert.ok(!fs.existsSync(path.join(data, 'images')) || fs.readdirSync(path.join(data, 'images')).length === 0);
  assert.equal(readMeta(id).current, 2);

  // ---- 版本列表与删除 ----
  let list = await api('GET', `/api/me/items/${id}/versions`);
  assert.equal(list.status, 200); assert.equal(list.body.current, 2);
  assert.deepEqual(list.body.versions.map((v) => [v.n, v.current]), [[1, false], [2, true]]);
  assert.equal(list.body.versions[0].url, `${base}/v/${id}/@1`); assert.equal(list.body.versions[1].url, `${base}/v/${id}`);
  assert.equal((await api('GET', `/api/me/items/${id}/versions`, 'other-token')).status, 403);
  assert.equal((await api('DELETE', `/api/me/items/${id}/versions/2`)).status, 400, 'current version kept');
  assert.equal((await api('DELETE', `/api/me/items/${id}/versions/1`)).status, 400, 'first version kept');
  await send('<title>Login v3</title>LOGIN V3', { id });
  result = await api('DELETE', `/api/me/items/${id}/versions/2`);
  assert.equal(result.status, 200); assert.deepEqual(result.body.versions.map((v) => v.n), [1, 3]);
  assert.ok(!fs.existsSync(path.join(data, 'html', id, '.versions', '2')));
  assert.equal(readMeta(id).size, Buffer.byteLength('<title>Login v1</title>LOGIN V1') + Buffer.byteLength('<title>Login v3</title>LOGIN V3'));
  assert.equal((await text(`${base}/v/${id}/@2`, cookie)).status, 404);

  // ---- 版本上限（测试配置为 3）：删最早的，保留第 1 版 ----
  for (const n of [4, 5]) assert.equal((await send(`LOGIN V${n}`, { id })).body.version, n);
  meta = readMeta(id);
  assert.deepEqual(meta.versions.map((v) => v.n), [1, 4, 5]);
  assert.ok(!fs.existsSync(path.join(data, 'html', id, '.versions', '3')), 'pruned version removed from disk');
  assert.ok(fs.existsSync(path.join(data, 'html', id, 'page.html')), 'first version kept');

  // ---- 旧资源（没有 versions 字段）：照常打开，第一次更新变成 v2 ----
  const legacy = (await send('<title>Old</title>OLD PAGE', { access_mode: 'public' })).body;
  const legacyMeta = readMeta(legacy.id);
  delete legacyMeta.versions; delete legacyMeta.current;
  fs.writeFileSync(path.join(data, 'meta', legacy.id + '.json'), JSON.stringify(legacyMeta));
  assert.ok((await text(`${base}/v/${legacy.id}`)).body.includes('OLD PAGE'));
  assert.ok((await text(`${base}/v/${legacy.id}/@1`)).body.includes('OLD PAGE'));
  result = await send('<title>New</title>NEW PAGE', { id: legacy.id });
  assert.equal(result.body.version, 2);
  assert.ok((await text(`${base}/v/${legacy.id}`)).body.includes('NEW PAGE'));
  assert.ok((await text(`${base}/v/${legacy.id}/@1`)).body.includes('OLD PAGE'));
  assert.deepEqual(readMeta(legacy.id).versions.map((v) => v.n), [1, 2]);

  // ---- 配额：更新不占文件数 ----
  const small = await send('S1', { token: 'small-token' });
  assert.equal(small.status, 200);
  assert.equal((await send('S2', { token: 'small-token' })).status, 429, 'new resource over max_files');
  assert.equal((await send('S1b', { token: 'small-token', id: small.body.id })).status, 200, 'update allowed at max_files');

  // ---- 图片：历史版本的包裹页引用对应版本的原始文件，且不放进沙箱 ----
  const image = (await send(Buffer.from('PNG-ONE'), { name: 'shot.png', type: 'image/png' })).body;
  await send(Buffer.from('PNG-TWO'), { name: 'shot2.png', type: 'image/png', id: image.id });
  const imageCookie = (await unlock(image.id, image.accessCode)).cookie;
  page = await text(`${base}/v/${image.id}/@1`, imageCookie);
  assert.equal(page.status, 200); assert.ok(page.body.includes(`src="/v/${image.id}/@1/raw"`));
  assert.ok(!/sandbox/.test(page.response.headers.get('content-security-policy') || ''), 'image wrapper is not sandboxed');
  assert.equal((await text(`${base}/v/${image.id}/@1/raw`, imageCookie)).body, 'PNG-ONE');
  assert.equal((await text(`${base}/v/${image.id}/raw`, imageCookie)).body, 'PNG-TWO');
  assert.ok((await text(`${base}/v/${image.id}`, imageCookie)).body.includes(`src="/v/${image.id}/raw"`));

  // ---- 站点：历史版本走同一套路径凭证，相对链接留在该版本里 ----
  const siteV1 = zip([{ name: 'index.html', data: '<title>Site</title>HOME V1<a href="about.html">a</a>' }, { name: 'about.html', data: 'ABOUT V1' }]);
  const siteV2 = zip([{ name: 'index.html', data: '<title>Site</title>HOME V2' }, { name: 'about.html', data: 'ABOUT V2' }]);
  const site = (await send(siteV1, { name: 'site.zip', type: 'application/zip' })).body;
  result = await send(siteV2, { name: 'site.zip', type: 'application/zip', id: site.id });
  assert.equal(result.status, 200); assert.equal(result.body.versionUrl, `${base}/v/${site.id}/@2/`);
  assert.equal(result.body.url, `${base}/v/${site.id}/`);
  assert.ok(fs.existsSync(path.join(data, 'sites', site.id, '.versions', '2', 'about.html')));
  const siteCookie = (await unlock(site.id, site.accessCode)).cookie;
  let response = await request(`${base}/v/${site.id}/@1/about.html`, { headers: { cookie: siteCookie } });
  assert.equal(response.status, 302);
  const tokenPath = response.headers.get('location');
  assert.match(tokenPath, new RegExp(`^/v/${site.id}/~[^/]+/@1/about\\.html$`));
  assert.equal((await text(base + tokenPath)).body, 'ABOUT V1');
  const tokenRoot = tokenPath.replace(/@1\/about\.html$/, '');
  assert.equal((await text(`${base}${tokenRoot}about.html`)).body, 'ABOUT V2', 'current version under the same token');
  response = await request(`${base}${tokenRoot}@1`);
  assert.equal(response.status, 302); assert.equal(response.headers.get('location'), '@1/');
  assert.ok((await text(`${base}${tokenRoot}@1/`)).body.includes('HOME V1'));
  assert.equal((await text(`${base}${tokenRoot}@1/.versions/2/about.html`)).status, 404, 'version store is not reachable');
  assert.equal((await text(`${base}${tokenRoot}.versions/2/about.html`)).status, 404);
  assert.equal((await text(`${base}/v/${site.id}/@1/`)).status, 401, 'site versions need the access code');
  result = await send(zip([{ name: 'index.html', data: 'x' }, { name: '@1/index.html', data: 'y' }]), { name: 'bad.zip', type: 'application/zip' });
  assert.equal(result.status, 400); assert.match(result.body.error, /reserved/);
  assert.equal((await send(Buffer.from('X'), { name: 'a.html', id: site.id })).status, 400, 'site cannot become html');

  // ---- 管理端：列表带版本信息，可查看版本 ----
  const login = await request(base + '/admin/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ user: 'test', password: 'test-password' }) });
  const admin = login.headers.get('set-cookie').split(';')[0];
  const rows = await (await request(base + '/admin/api/list?pageSize=50', { headers: { cookie: admin } })).json();
  const row = rows.items.find((item) => item.id === id);
  assert.equal(row.version, 5); assert.equal(row.versionCount, 3); assert.equal(row.filename, 'page.html');
  response = await request(`${base}/admin/api/item/${id}/versions`, { headers: { cookie: admin } });
  assert.equal(response.status, 200); assert.equal((await response.json()).versions.length, 3);
  response = await request(`${base}/admin/api/item/${id}/versions/4`, { method: 'DELETE', headers: { cookie: admin, origin: 'https://evil.example' } });
  assert.equal(response.status, 403, 'admin version delete checks origin');

  // ---- 删除资源时所有版本一起删除 ----
  assert.equal((await api('DELETE', `/api/me/items/${id}`)).status, 200);
  assert.ok(!fs.existsSync(path.join(data, 'html', id)));

  if (!proxy) await cli(base, temp);
  console.log(`versions (${proxy ? 'render proxy' : 'direct'}): update in place, history URLs, access, legacy, pruning, quota, image/site versions, admin passed`);
}

// CLI：在 git 仓库里第一次上传写入 .dview.json，再次上传更新原链接
async function cli(base, temp) {
  const repo = path.join(temp, 'repo'); fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  const git = (...args) => execFile('git', ['-C', repo, ...args]);
  await git('init', '-q'); await git('config', 'user.email', 't@example.com'); await git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'tmp/\n');
  fs.writeFileSync(path.join(repo, 'docs', 'prd.html'), '<title>PRD</title>PRD V1');
  await git('add', '.'); await git('commit', '-qm', 'init');
  const env = { ...process.env, DVIEW_URL: base, DVIEW_TOKEN: 'owner-token' };
  const dview = (...args) => execFile('bash', [path.join(root, 'bin/dview'), ...args], { cwd: repo, env });

  const created = JSON.parse((await dview('upload', 'docs/prd.html', '--json')).stdout);
  assert.equal(created.version, 1);
  const mapping = JSON.parse(fs.readFileSync(path.join(repo, '.dview.json'), 'utf8'));
  assert.deepEqual(mapping, { items: { 'docs/prd.html': created.id } });

  fs.writeFileSync(path.join(repo, 'docs', 'prd.html'), '<title>PRD</title>PRD V2');
  const run = await dview('upload', 'docs/prd.html', '-m', '细化登录流程');
  assert.equal(run.stdout.trim(), created.url, 'prints the same link');
  assert.match(run.stderr, /第 2 版/);
  const meta = JSON.parse(fs.readFileSync(path.join(temp, 'data', 'meta', created.id + '.json'), 'utf8'));
  assert.equal(meta.versions[1].message, '细化登录流程');
  assert.match(meta.versions[1].git.commit, /^[0-9a-f]{12}$/); assert.equal(meta.versions[1].git.dirty, true);

  const versions = (await dview('versions', created.id)).stdout;
  assert.match(versions, /v2 \*/); assert.match(versions, /细化登录流程/); assert.match(versions, new RegExp(`/v/${created.id}/@1`));

  // 从子目录上传也能找到映射
  const fromSub = JSON.parse((await execFile('bash', [path.join(root, 'bin/dview'), 'upload', 'prd.html', '--json'], { cwd: path.join(repo, 'docs'), env })).stdout);
  assert.equal(fromSub.id, created.id); assert.equal(fromSub.version, 3);

  // --new 新建并改写映射；被 .gitignore 忽略的文件不记录
  const fresh = JSON.parse((await dview('upload', 'docs/prd.html', '--new', '--json')).stdout);
  assert.notEqual(fresh.id, created.id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, '.dview.json'), 'utf8')).items['docs/prd.html'], fresh.id);
  fs.mkdirSync(path.join(repo, 'tmp')); fs.writeFileSync(path.join(repo, 'tmp', 'scratch.html'), 'S');
  await dview('upload', 'tmp/scratch.html', '--json');
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, '.dview.json'), 'utf8')).items['tmp/scratch.html'], undefined);

  // 映射的资源被删除：报错并提示，不自动新建
  await execFile('bash', [path.join(root, 'bin/dview'), 'delete', fresh.id], { cwd: repo, env });
  await assert.rejects(dview('upload', 'docs/prd.html'), /--new/);

  // 仓库外的文件：不写映射
  const outside = path.join(temp, 'outside.html'); fs.writeFileSync(outside, 'OUT');
  await dview('upload', outside, '--json');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(repo, '.dview.json'), 'utf8')).items), ['docs/prd.html']);
  console.log('versions CLI: .dview.json mapping, update with message and git commit, versions list, --new, ignored and outside files passed');
}

(async () => {
  try { await scenario(false); await scenario(true); } finally {
    for (const child of children) if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    for (const dir of directories) fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });

// 安全回归：预览沙箱、服务端 MIME 白名单、上传限制、token 比对、管理端同源校验、session secret 启动检查、优雅退出
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { once } = require('node:events');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const children = [];
const directories = [];

async function freePort() {
  const s = net.createServer().listen(0, '127.0.0.1');
  await once(s, 'listening');
  const n = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return n;
}

function spawnNode(file, env) {
  const child = spawn(process.execPath, [file], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.logs = '';
  child.stdout.on('data', (d) => { child.logs += d; });
  child.stderr.on('data', (d) => { child.logs += d; });
  return child;
}

async function start(file, env, url) {
  const child = spawnNode(file, env);
  for (let n = 0; n < 100; n++) {
    if (child.exitCode !== null) throw new Error(child.logs);
    try { if ((await fetch(url + '/healthz')).ok) return child; } catch { /* not ready */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Service not ready: ' + child.logs);
}

const request = (url, options = {}) => fetch(url, { redirect: 'manual', ...options, signal: AbortSignal.timeout(10000) });

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  directories.push(dir);
  return dir;
}

async function scenario(proxy) {
  const temp = tempDir('vibeview-security-');
  const mainPort = await freePort();
  const renderPort = await freePort();
  const base = `http://127.0.0.1:${mainPort}`;
  const render = `http://127.0.0.1:${renderPort}`;
  const data = path.join(temp, 'data');
  fs.mkdirSync(path.join(data, 'meta'), { recursive: true });
  const cfg = path.join(temp, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({
    server: { port: mainPort, base_url: base },
    storage: { retention_days: 0 },
    tokens: [{ name: 'owner', token: 'owner-token' }, { name: 'other', token: 'other-token-longer' }, { name: '50%off', token: 'percent-token' }],
    admin: { user: 'test', password: 'security-password', session_secret: 'security-isolated-secret' },
    preview: { proxy_to_render: proxy, render_url: render, gateway_token: 'security-gateway' },
  }));
  if (proxy) {
    await start('render-server.js', { RENDER_PORT: String(renderPort), RENDER_DATA_ROOT: data, RENDER_GATEWAY_TOKEN: 'security-gateway' }, render);
  }
  await start('server.js', { DVIEW_CONFIG_PATH: cfg, DVIEW_PREVIEW_PROXY: String(proxy), DVIEW_RENDER_GATEWAY_TOKEN: 'security-gateway' }, base);

  const upload = async (name, type, body, extra = { access_mode: 'public' }, token = 'owner-token') => {
    const form = new FormData();
    form.append('file', new Blob([body], { type }), name);
    for (const [k, v] of Object.entries(extra)) form.append(k, v);
    const response = await request(base + '/upload', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    return { status: response.status, body: await response.json() };
  };
  const label = proxy ? 'proxy' : 'direct';

  // #1 公开 HTML 也运行在沙箱（不透明源）中
  const html = await upload('page.html', 'text/html', '<h1>public</h1>');
  assert.equal(html.status, 200);
  let response = await request(`${base}/v/${html.body.id}`);
  assert.equal(response.status, 200);
  let csp = response.headers.get('content-security-policy') || '';
  assert.match(csp, /sandbox allow-scripts/, `${label}: public HTML must be sandboxed`);
  assert.ok(!csp.includes('allow-same-origin'), `${label}: sandbox must not allow same origin`);
  assert.match(await response.text(), /public/);

  // #1 公开 SVG：raw 沙箱化，包裹页使用严格 CSP 但不沙箱（需加载同源 raw）
  const svg = await upload('icon.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.equal(svg.status, 200);
  response = await request(`${base}/v/${svg.body.id}/raw`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy') || '', /sandbox allow-scripts/, `${label}: raw SVG must be sandboxed`);
  assert.equal(response.headers.get('content-type'), 'image/svg+xml');
  response = await request(`${base}/v/${svg.body.id}`);
  csp = response.headers.get('content-security-policy') || '';
  assert.ok(!csp.includes('sandbox'), `${label}: image wrapper must stay same-origin`);

  // #1 受保护 HTML 仍禁止被嵌入，且不会被 sidecar 的 CSP 覆盖
  const protectedHtml = await upload('secret.html', 'text/html', '<h1>secret</h1>', {});
  const unlock = await request(`${base}/v/${protectedHtml.body.id}/unlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: protectedHtml.body.accessCode }),
  });
  assert.equal(unlock.status, 303);
  const grant = unlock.headers.get('set-cookie').split(';')[0];
  response = await request(`${base}/v/${protectedHtml.body.id}`, { headers: { cookie: grant } });
  assert.equal(response.status, 200);
  csp = response.headers.get('content-security-policy') || '';
  assert.match(csp, /sandbox allow-scripts/);
  assert.match(csp, /frame-ancestors 'none'/, `${label}: protected CSP must come from the host`);

  // #2 MIME 由扩展名决定，客户端伪造的 MIME 不再生效
  const spoofed = await upload('clip.webm', 'application/xhtml+xml', 'not really video');
  assert.equal(spoofed.status, 200);
  response = await request(`${base}/v/${spoofed.body.id}/raw`);
  assert.equal(response.headers.get('content-type'), 'video/webm');
  const pngAsHtml = await upload('dot.png', 'text/html', 'png-bytes');
  assert.equal(pngAsHtml.status, 200);
  const noExtHtml = await upload('chart', 'text/html', '<h1>no ext</h1>');
  assert.equal(noExtHtml.status, 200);
  const items = (await (await request(`${base}/api/me/items`, { headers: { Authorization: 'Bearer owner-token' } })).json()).items;
  assert.equal(items.find((i) => i.id === pngAsHtml.body.id).type, 'image');
  assert.equal(items.find((i) => i.id === noExtHtml.body.id).type, 'html');
  const metaMime = JSON.parse(fs.readFileSync(path.join(data, 'meta', `${spoofed.body.id}.json`), 'utf8')).mime;
  assert.equal(metaMime, 'video/webm');
  for (const [name, type] of [['photo.tiff', 'image/tiff'], ['raw', 'image/tiff'], ['clip.mov', 'video/quicktime'], ['note.txt', 'text/html']]) {
    const rejected = await upload(name, type, 'x');
    assert.equal(rejected.status, 400, `${label}: ${name} (${type}) must be rejected`);
  }
  // 不支持的类型给出明确错误；只接受一个文件
  const unsupported = await upload('note.txt', 'text/plain', 'x');
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.body.error, 'unsupported file type');
  const twoFiles = new FormData();
  twoFiles.append('file', new Blob(['<h1>a</h1>'], { type: 'text/html' }), 'a.html');
  twoFiles.append('file', new Blob(['<h1>b</h1>'], { type: 'text/html' }), 'b.html');
  response = await request(base + '/upload', { method: 'POST', headers: { Authorization: 'Bearer owner-token' }, body: twoFiles });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /only one file/);

  // 历史数据：扩展名不在白名单的 raw 以二进制下发
  const legacy = 'Legacy0000000001';
  fs.mkdirSync(path.join(data, 'images', legacy), { recursive: true });
  fs.writeFileSync(path.join(data, 'images', legacy, 'old.xhtml'), '<html/>');
  fs.writeFileSync(path.join(data, 'meta', `${legacy}.json`), JSON.stringify({
    id: legacy, type: 'image', filename: 'old.xhtml', mime: 'application/xhtml+xml', source: 'owner',
    createdAt: new Date().toISOString(), access: { mode: 'public' },
  }));
  response = await request(`${base}/v/${legacy}/raw`);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');

  // #5 token 校验：不同长度 / 前缀相同的 token 都被拒绝，正确 token 正常
  for (const token of ['owner-toke', 'owner-token-', 'other-token', '']) {
    const r = await request(`${base}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(r.status, 401, `token ${JSON.stringify(token)} must be rejected`);
  }
  assert.equal((await request(`${base}/api/me`, { headers: { Authorization: 'Bearer other-token-longer' } })).status, 200);

  // #4 管理端写操作拒绝跨源请求
  const login = await request(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: new URLSearchParams({ user: 'test', password: 'security-password' }),
  });
  assert.equal(login.status, 302);
  assert.equal(login.headers.get('location'), '/admin');
  const sessionCookie = login.headers.get('set-cookie').split(';')[0];
  const evil = { cookie: sessionCookie, origin: 'https://evil.example', 'content-type': 'application/json' };
  const same = { cookie: sessionCookie, origin: base, 'content-type': 'application/json' };
  const crossSite = [
    ['DELETE', `/admin/api/item/${html.body.id}`],
    ['DELETE', '/admin/api/items', JSON.stringify({ ids: [html.body.id] })],
    ['POST', '/admin/api/accounts/other/disable'],
    ['POST', '/admin/api/accounts/other/enable'],
    ['POST', '/admin/logout'],
  ];
  for (const [method, url, body] of crossSite) {
    const r = await request(base + url, { method, headers: evil, body });
    assert.equal(r.status, 403, `${label}: cross-origin ${method} ${url} must be rejected`);
  }
  // 沙箱页发出的请求 Origin 为 "null"，同样拒绝
  assert.equal((await request(`${base}/admin/api/item/${html.body.id}`, { method: 'DELETE', headers: { ...evil, origin: 'null' } })).status, 403);
  assert.ok(fs.existsSync(path.join(data, 'meta', `${html.body.id}.json`)), 'resource must survive rejected deletes');
  // 同源请求正常
  response = await request(`${base}/admin/api/accounts/other/disable`, { method: 'POST', headers: same });
  assert.equal(response.status, 200);
  response = await request(`${base}/admin/api/accounts/other/enable`, { method: 'POST', headers: same });
  assert.equal(response.status, 200);
  // 名称含 % 的账户：路径参数只解码一次
  response = await request(`${base}/admin/api/accounts/${encodeURIComponent('50%off')}/disable`, { method: 'POST', headers: same });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, name: '50%off', disabled: true });
  assert.equal((await request(`${base}/api/me`, { headers: { Authorization: 'Bearer percent-token' } })).status, 401);
  response = await request(`${base}/admin/api/accounts/${encodeURIComponent('50%off')}/enable`, { method: 'POST', headers: same });
  assert.equal(response.status, 200);
  assert.equal((await request(`${base}/api/me`, { headers: { Authorization: 'Bearer percent-token' } })).status, 200);
  response = await request(`${base}/admin/api/item/${html.body.id}`, { method: 'DELETE', headers: same });
  assert.deepEqual(await response.json(), { ok: true });
  // https 才设置 secure：本地 http 下管理 cookie 不带 Secure，避免登录失效
  assert.ok(!/;\s*secure/i.test(login.headers.get('set-cookie')));

  console.log(`security ${label}: preview sandbox, MIME whitelist, upload limits, token check, admin same-origin, account names passed`);
}

async function sessionSecretCheck() {
  const temp = tempDir('vibeview-secret-');
  for (const [secret, shouldStart] of [[undefined, false], ['change-me', false], ['replace-with-a-random-session-secret', false], ['a-real-random-secret', true]]) {
    const mainPort = await freePort();
    const cfg = path.join(temp, `config-${mainPort}.json`);
    const admin = { user: 'test', password: 'secret-check-password' };
    if (secret !== undefined) admin.session_secret = secret;
    fs.writeFileSync(cfg, JSON.stringify({
      server: { port: mainPort, base_url: `http://127.0.0.1:${mainPort}` },
      storage: { retention_days: 0, meta_dir: path.join(temp, `data-${mainPort}`, 'meta') },
      tokens: [{ name: 'owner', token: 'owner-token' }],
      admin,
    }));
    if (shouldStart) {
      const child = await start('server.js', { DVIEW_CONFIG_PATH: cfg }, `http://127.0.0.1:${mainPort}`);
      child.kill('SIGTERM');
      const [code, signal] = await once(child, 'exit');
      assert.equal(code, 0, `SIGTERM should exit cleanly (signal=${signal})`);
      assert.match(child.logs, /SIGTERM/);
    } else {
      const child = spawnNode('server.js', { DVIEW_CONFIG_PATH: cfg });
      const [code] = await once(child, 'exit');
      assert.equal(code, 1, `session_secret=${secret} must refuse to start`);
      assert.match(child.logs, /session_secret/);
    }
  }
  // 未启用管理端（无密码）时不强制 secret
  const mainPort = await freePort();
  const cfg = path.join(temp, 'config-no-admin.json');
  fs.writeFileSync(cfg, JSON.stringify({
    server: { port: mainPort, base_url: `http://127.0.0.1:${mainPort}` },
    storage: { retention_days: 0, meta_dir: path.join(temp, 'data-no-admin', 'meta') },
    tokens: [{ name: 'owner', token: 'owner-token' }],
  }));
  const child = await start('server.js', { DVIEW_CONFIG_PATH: cfg }, `http://127.0.0.1:${mainPort}`);
  child.kill();
  await once(child, 'exit');
  console.log('security: placeholder session_secret refuses startup when admin is enabled; SIGTERM exits cleanly');
}

(async () => {
  try {
    await scenario(false);
    await scenario(true);
    await sessionSecretCheck();
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
    }
    for (const dir of directories) fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

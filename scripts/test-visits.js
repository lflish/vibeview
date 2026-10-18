// 预览访问统计：计数模块单元测试 + 真实服务的端到端验证（计数口径、筛选排序、重启后保留）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { createVisits, isBot } = require('../lib/visits');

const root = path.join(__dirname, '..');
const temps = [];
const tempDir = (prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); temps.push(dir); return dir; };

function unit() {
  const dir = tempDir('vibeview-visits-unit-');
  let clock = Date.parse('2026-03-10T04:00:00Z');
  const dateOf = (value) => new Date(value).toISOString().slice(0, 10);
  const visits = createVisits({ file: path.join(dir, 'visits.sqlite'), dateOf, now: () => clock, logger: { warn() {} } });
  const a = { id: 'AAAAAAAAAAAAAAAA', type: 'html', source: 'alice', project: 'vibeview', filename: 'a.html' };
  const b = { id: 'BBBBBBBBBBBBBBBB', type: 'image', source: 'bob', project: '', filename: 'b.png' };
  visits.record(a, 'views'); visits.record(a, 'views'); visits.record(a, 'challenges'); visits.record(a, 'unlock_fail');
  clock += 86400000;
  visits.record(a, 'views'); visits.record(b, 'bots'); visits.record(b, 'expired_hits');
  visits.record(a, 'nonsense');
  const totals = visits.totalsFor([a.id, b.id]);
  assert.equal(totals.get(a.id).views, 3);
  assert.equal(totals.get(a.id).firstViewedAt, '2026-03-10T04:00:00.000Z');
  assert.equal(totals.get(a.id).lastViewedAt, '2026-03-11T04:00:00.000Z');
  assert.equal(totals.has(b.id), false, 'bots do not count as views');

  const all = visits.summary({ from: '2026-03-10', to: '2026-03-11' }, [a, b]);
  assert.deepEqual(all.daily, [{ date: '2026-03-10', views: 2 }, { date: '2026-03-11', views: 1 }]);
  assert.equal(all.totals.views, 3); assert.equal(all.totals.bots, 1); assert.equal(all.totals.challenges, 1);
  assert.equal(all.totals.unlock_fail, 1); assert.equal(all.totals.expired_hits, 1);
  assert.equal(all.neverViewed, 1); assert.equal(all.viewedInRange, 1);
  // 统计开始前上传、之后未打开的资源单独计数；开始时间为首次打开统计库的时间（这里是第一次读取时）
  const legacy = { id: 'CCCCCCCCCCCCCCCC', type: 'html', createdAt: '2026-01-01T00:00:00.000Z' };
  const fresh = { id: 'DDDDDDDDDDDDDDDD', type: 'html', createdAt: '2026-03-11T05:00:00.000Z' };
  const mixed = visits.summary({ from: '2026-03-10', to: '2026-03-11' }, [a, legacy, fresh]);
  assert.equal(mixed.neverViewed, 2); assert.equal(mixed.neverViewedBeforeStart, 1);
  assert.equal(visits.startedAt(), '2026-03-11T04:00:00.000Z', 'recording starts when the database is first opened');
  assert.deepEqual(all.projects, [{ project: 'vibeview', views: 3 }]);
  assert.equal(all.top[0].id, a.id); assert.equal(all.top[0].filename, 'a.html');

  // 已删除的资源隐藏文件名，历史计数保留
  const afterDelete = visits.summary({ from: '2026-03-10', to: '2026-03-11' }, [b]);
  assert.equal(afterDelete.totals.views, 3); assert.equal(afterDelete.top[0].retained, false); assert.equal(afterDelete.top[0].filename, null);

  // 维度筛选：项目 / 未设置项目 / 来源
  assert.equal(visits.summary({ from: '2026-03-10', to: '2026-03-11', project: 'vibeview' }, [a]).totals.views, 3);
  assert.equal(visits.summary({ from: '2026-03-10', to: '2026-03-11', project: '-' }, [b]).totals.views, 0);
  assert.equal(visits.summary({ from: '2026-03-10', to: '2026-03-11', project: '-' }, [b]).totals.bots, 1);
  assert.equal(visits.summary({ from: '2026-03-10', to: '2026-03-11', source: 'bob' }, [b]).totals.views, 0);

  // 标签修改后按当前项目统计
  visits.syncResource({ ...a, project: 'renamed' });
  assert.deepEqual(visits.summary({ from: '2026-03-10', to: '2026-03-11' }, [a, b]).projects, [{ project: 'renamed', views: 3 }]);

  assert.throws(() => visits.summary({ from: '2026-03-12', to: '2026-03-11' }, []), /Invalid date range/);
  assert.throws(() => visits.summary({ from: '2026-03-10', to: '2026-03-20' }, []), /no future/);
  visits.stop();

  // 重新打开后数据仍在
  const reopened = createVisits({ file: path.join(dir, 'visits.sqlite'), dateOf, now: () => clock, logger: { warn() {} } });
  assert.equal(reopened.totalsFor([a.id]).get(a.id).views, 3);
  reopened.stop();

  assert.equal(isBot('Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)'), true);
  assert.equal(isBot('curl/8.5.0'), true);
  assert.equal(isBot(''), true);
  assert.equal(isBot('Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 MicroMessenger/8.0.47'), false);
  assert.equal(isBot('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Lark/7.1.0 Chrome/120 Safari/537.36'), false);
  console.log('visits unit: ok');
}

async function freePort() {
  const s = net.createServer().listen(0, '127.0.0.1'); await once(s, 'listening');
  const p = s.address().port; await new Promise((resolve) => s.close(resolve)); return p;
}

async function startServer(cfg, base) {
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, DVIEW_CONFIG_PATH: cfg, DVIEW_PREVIEW_PROXY: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d; }); child.stderr.on('data', (d) => { logs += d; });
  for (let n = 0; n < 100; n++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(base + '/healthz')).ok) return child; } catch { /* not ready */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill('SIGKILL');
  throw new Error('server not ready: ' + logs);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await once(child, 'exit');
}

async function integration() {
  const dir = tempDir('vibeview-visits-int-');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const cfg = path.join(dir, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({
    server: { port, base_url: base }, storage: { retention_days: 0 },
    tokens: [{ name: 'owner', token: 'owner-token' }],
    admin: { user: 'admin', password: 'admin-pass', session_secret: 'test-secret' },
    access: { code_secret: 'code-secret' },
  }));
  const browser = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36' };
  let server = await startServer(cfg, base);
  try {
    const upload = async (name, extra = {}) => {
      const form = new FormData();
      form.append('file', new Blob(['<title>' + name + '</title>ok'], { type: 'text/html' }), name + '.html');
      for (const [k, v] of Object.entries(extra)) form.append(k, v);
      const r = await fetch(base + '/upload', { method: 'POST', headers: { authorization: 'Bearer owner-token' }, body: form });
      assert.equal(r.status, 200); return r.json();
    };
    const pub = await upload('public', { access_mode: 'public', project: 'alpha' });
    const locked = await upload('locked', { project: 'beta' });
    const idle = await upload('idle', { access_mode: 'public' });

    const get = (url, headers = browser) => fetch(url, { headers, redirect: 'manual' });
    // 公开资源：浏览器打开 2 次、爬虫 1 次、原文件不计数
    assert.equal((await get(pub.url)).status, 200);
    assert.equal((await get(pub.url)).status, 200);
    assert.equal((await get(pub.url, { 'user-agent': 'Slackbot-LinkExpanding 1.0' })).status, 200);
    assert.equal((await get(pub.url + '/raw')).status, 200);

    // 受保护资源：验证页 → 输错 → 输对 → 打开
    assert.equal((await get(locked.url)).status, 401);
    const unlock = (code) => fetch(locked.url + '/unlock', { method: 'POST', redirect: 'manual', headers: { ...browser, 'content-type': 'application/x-www-form-urlencoded' }, body: 'code=' + encodeURIComponent(code) });
    assert.equal((await unlock('wrong-code-123')).status, 403);
    const ok = await unlock(locked.accessCode);
    assert.equal(ok.status, 303);
    const grant = ok.headers.get('set-cookie').split(';')[0];
    assert.equal((await get(locked.url, { ...browser, cookie: grant })).status, 200);

    // 管理员登录后的打开单独计数
    const login = await fetch(base + '/admin/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'user=admin&password=admin-pass' });
    assert.equal(login.status, 302);
    const admin = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await get(pub.url, { ...browser, cookie: admin })).status, 200);

    const api = async (pathname) => { const r = await fetch(base + pathname, { headers: { cookie: admin } }); assert.equal(r.status, 200, pathname); return r.json(); };
    const list = await api('/admin/api/list?pageSize=50');
    assert.equal(list.visitsAvailable, true);
    const byId = Object.fromEntries(list.items.map((item) => [item.id, item]));
    assert.equal(byId[pub.id].visits.views, 2, 'bot, admin and /raw are excluded');
    assert.equal(byId[locked.id].visits.views, 1);
    assert.equal(byId[idle.id].visits.views, 0);
    assert.ok(byId[pub.id].visits.lastViewedAt);

    assert.deepEqual((await api('/admin/api/list?visit=never')).items.map((i) => i.id), [idle.id]);
    assert.deepEqual((await api('/admin/api/list?visit=recent7')).items.map((i) => i.id).sort(), [pub.id, locked.id].sort());
    assert.deepEqual((await api('/admin/api/list?sort=views&order=desc')).items.map((i) => i.id), [pub.id, locked.id, idle.id]);
    assert.deepEqual((await api('/admin/api/list?project=-')).items.map((i) => i.id), [idle.id]);

    const stats = await api('/admin/api/statistics/visits');
    assert.equal(stats.available, true);
    assert.equal(stats.totals.views, 3); assert.equal(stats.totals.bots, 1); assert.equal(stats.totals.admin_views, 1);
    assert.equal(stats.totals.challenges, 1); assert.equal(stats.totals.unlock_fail, 1); assert.equal(stats.totals.unlock_ok, 1);
    assert.equal(stats.neverViewed, 1); assert.equal(stats.current, 3);
    assert.deepEqual(stats.accessStatus, { public: 2, active: 1, expiringSoon: 0, expired: 0, unconfigured: 0 });
    assert.equal(stats.neverViewedBeforeStart, 0); assert.ok(list.visitsSince);
    assert.deepEqual(stats.projects.map((p) => p.project), ['alpha', 'beta']);
    const beta = await api('/admin/api/statistics/visits?project=beta');
    assert.equal(beta.totals.views, 1); assert.equal(beta.current, 1);
    assert.equal((await fetch(base + '/admin/api/statistics/visits?from=2020-01-01&to=2099-01-01', { headers: { cookie: admin } })).status, 400);
    assert.equal((await fetch(base + '/admin/api/statistics/visits')).status, 401);

    const uploads = await api('/admin/api/statistics');
    assert.deepEqual(uploads.availableProjects, ['', 'alpha', 'beta']);
    assert.equal((await api('/admin/api/statistics?project=alpha')).summary.uploads.count, 1);
    assert.equal((await api('/admin/api/statistics?project=-')).summary.uploads.count, 1);

    // 上传者自己的列表也能看到打开次数
    const mine = await (await fetch(base + '/api/me/items', { headers: { authorization: 'Bearer owner-token' } })).json();
    assert.equal(mine.items.find((i) => i.id === pub.id).visits.views, 2);

    // 退出登录同时清掉会话 cookie，之后的预览按访客计数
    const logout = await fetch(base + '/admin/logout', { method: 'POST', redirect: 'manual', headers: { cookie: admin } });
    assert.match(logout.headers.get('set-cookie') || '', /connect\.sid=;.*Expires=Thu, 01 Jan 1970/i);

    // 内存中的计数在正常退出时写盘
    assert.equal((await get(idle.url)).status, 200);
    await stopServer(server);
    server = await startServer(cfg, base);
    const login2 = await fetch(base + '/admin/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'user=admin&password=admin-pass' });
    const admin2 = login2.headers.get('set-cookie').split(';')[0];
    const after = await (await fetch(base + '/admin/api/list?visit=never', { headers: { cookie: admin2 } })).json();
    assert.deepEqual(after.items, [], 'view recorded right before shutdown survives restart');
    console.log('visits integration: ok');
  } finally {
    await stopServer(server);
  }
}

(async () => {
  try {
    unit();
    await integration();
  } finally {
    for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exit(1); });

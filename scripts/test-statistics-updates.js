// 统计区分新建和更新：真实 HTTP 上传路径（docs/changes/2026-11-09-stats-create-vs-update）。
// 独立的服务实例和临时目录，不影响 test-statistics-integration.js 里写死的数字。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const zlib = require('node:zlib');
const { once } = require('node:events');
const { spawn } = require('node:child_process');

const repo = path.join(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeview-stats-updates-'));
let server, base, cookie;

// 最小 zip（只存储，不压缩），够造一个站点。
function zip(entries) {
  const locals = [], centrals = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name), data = Buffer.from(e.data), crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, data); centrals.push(central, name); offset += local.length + name.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

async function stop() { if (server && server.exitCode === null) { const exited = once(server, 'exit'); server.kill(); await exited; } }
async function run() {
  const listener = net.createServer().listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); base = 'http://127.0.0.1:' + port;
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    server: { port, base_url: base, trust_proxy: false }, storage: { retention_days: 0 }, statistics: { timezone: 'Asia/Shanghai' },
    admin: { user: 'test', password: 'updates-test-password', session_secret: 'updates-isolated-secret' },
    tokens: [{ name: 'alice', token: 'PRIVATE-ALICE-TOKEN' }, { name: 'bob', token: 'PRIVATE-BOB-TOKEN' }, { name: 'tiny', token: 'PRIVATE-TINY-TOKEN', max_storage_mb: 0.001 }],
  }));
  async function start() {
    let logs = ''; server = spawn(process.execPath, ['server.js'], { cwd: repo, env: { ...process.env, DVIEW_CONFIG_PATH: configPath, DVIEW_PREVIEW_PROXY: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', d => logs += d); server.stderr.on('data', d => logs += d);
    for (let i = 0; i < 100; i++) { if (server.exitCode !== null) throw Error(logs); try { if ((await fetch(base + '/healthz')).ok) return; } catch {} await new Promise(resolve => setTimeout(resolve, 50)); }
    throw Error(logs);
  }
  const request = (route, options = {}) => fetch(base + route, { ...options, redirect: 'manual', signal: AbortSignal.timeout(10000) });
  const auth = (route, options = {}) => request(route, { ...options, headers: { cookie, ...options.headers } });
  const bearer = token => ({ authorization: 'Bearer ' + token });
  async function login() {
    const r = await request('/admin/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ user: 'test', password: 'updates-test-password' }) });
    assert.equal(r.status, 302); cookie = r.headers.get('set-cookie').split(';')[0];
  }
  async function summary() { const r = await auth('/admin/api/statistics'); assert.equal(r.status, 200); return r.json(); }
  async function send({ body, name = 'PRIVATE-PAGE.html', type = 'text/html', id, token = 'PRIVATE-ALICE-TOKEN', description }) {
    const form = new FormData(); form.set('file', new Blob([body], { type }), name);
    if (id) form.set('id', id); if (description) form.set('description', description);
    const r = await request('/upload', { method: 'POST', headers: bearer(token), body: form });
    return { status: r.status, body: await r.json() };
  }
  async function create(body = '<title>PRIVATE-TITLE</title>v1', options = {}) { const r = await send({ body, ...options }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; }
  async function update(id, body, options = {}) { const r = await send({ body, id, ...options }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; }
  const counts = s => [s.summary.uploads.created.count, s.summary.uploads.updated.count];

  await start(); await login();
  let s = await summary(); assert.deepEqual(counts(s), [0, 0]);

  // R1.1 --id 更新记一次；体积是新版本的大小
  const page = await create('<title>PRIVATE-TITLE</title>v1', { description: 'PRIVATE-DESCRIPTION' });
  const v2Body = '<title>PRIVATE-TITLE</title>version two, longer';
  const v2 = await update(page.id, v2Body); assert.equal(v2.updated, true);
  s = await summary();
  assert.deepEqual(counts(s), [1, 1]); assert.deepEqual([s.summary.today.created.count, s.summary.today.updated.count], [1, 1]);
  assert.equal(s.summary.uploads.updated.bytes, Buffer.byteLength(v2Body));
  assert.equal(s.summary.uploads.count, s.summary.uploads.created.count + s.summary.uploads.updated.count, 'R4.1 count is the total');
  assert.ok(s.activities.some(a => a.id === page.id && a.uploadKind === 'update' && a.version === 2), 'R3.4 activity names the version');

  // R1.2 站点更新：类型为站点，体积是新版本解压后的大小
  const site1 = zip([{ name: 'index.html', data: '<title>Site</title>one' }]);
  const site = await create(site1, { name: 'site.zip', type: 'application/zip' });
  const siteV2Files = [{ name: 'index.html', data: '<title>Site</title>two' }, { name: 'about.html', data: 'about page' }];
  await update(site.id, zip(siteV2Files), { name: 'site.zip', type: 'application/zip' });
  s = await summary();
  const siteRow = s.types.find(t => t.type === 'site');
  assert.deepEqual([siteRow.created.count, siteRow.updated.count], [1, 1]);
  assert.equal(siteRow.updated.bytes, siteV2Files.reduce((n, f) => n + Buffer.byteLength(f.data), 0));

  // R1.4 被拒的更新不计
  const before = counts(await summary());
  assert.equal((await send({ body: 'png?', name: 'x.png', type: 'image/png', id: page.id })).status, 400, 'type mismatch');
  assert.equal((await send({ body: '<title>x</title>', id: page.id, token: 'PRIVATE-BOB-TOKEN' })).status, 403, 'other account');
  const small = await create('<title>t</title>tiny', { token: 'PRIVATE-TINY-TOKEN' });
  assert.equal((await send({ body: 'x'.repeat(4096), id: small.id, token: 'PRIVATE-TINY-TOKEN' })).status, 429, 'storage quota');
  assert.deepEqual(counts(await summary()), [before[0] + 1, before[1]], 'only the tiny create counted');

  // R1.5 不是新版本的操作不计
  await update(page.id, '<title>PRIVATE-TITLE</title>v3'); // 现在 v1、v2、v3
  const beforeEdits = counts(await summary());
  assert.equal((await request('/api/me/items/' + page.id + '/access', { method: 'PATCH', headers: { ...bearer('PRIVATE-ALICE-TOKEN'), 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'public' }) })).status, 200);
  assert.equal((await request('/api/me/items/' + page.id + '/meta', { method: 'PATCH', headers: { ...bearer('PRIVATE-ALICE-TOKEN'), 'content-type': 'application/json' }, body: JSON.stringify({ category: 'doc', description: 'PRIVATE-DESCRIPTION-2' }) })).status, 200);
  assert.equal((await request('/api/me/items/' + page.id + '/versions/2', { method: 'DELETE', headers: bearer('PRIVATE-ALICE-TOKEN') })).status, 200);
  assert.deepEqual(counts(await summary()), beforeEdits, 'access, labels and version deletion are not updates');
  await update(page.id, '<title>PRIVATE-TITLE</title>v4'); // 删掉 v2 后的新版本是 v4
  s = await summary(); assert.equal(s.summary.uploads.updated.count, beforeEdits[1] + 1);
  assert.ok(s.activities.some(a => a.id === page.id && a.version === 4));

  // 并发两次更新同一资源：各记一次
  const busy = await create();
  const beforeBusy = (await summary()).summary.uploads.updated.count;
  await Promise.all([update(busy.id, 'concurrent one'), update(busy.id, 'concurrent two')]);
  assert.equal((await summary()).summary.uploads.updated.count, beforeBusy + 2);

  // R1.6 删除后历史保留；已删除的行文件名为空
  const doomed = await create(); await update(doomed.id, 'second'); await update(doomed.id, 'third');
  const beforeDelete = (await summary()).summary.uploads;
  assert.equal((await request('/api/me/items/' + doomed.id, { method: 'DELETE', headers: bearer('PRIVATE-ALICE-TOKEN') })).status, 200);
  s = await summary();
  assert.equal(s.summary.uploads.count, beforeDelete.count); assert.equal(s.summary.uploads.updated.count, beforeDelete.updated.count);
  const day = await (await auth('/admin/api/statistics/day?date=' + s.today + '&pageSize=100')).json();
  const doomedRows = day.items.filter(r => r.id === doomed.id);
  assert.deepEqual(doomedRows.map(r => r.uploadKind + r.version).sort(), ['create1', 'update2', 'update3']);
  assert.ok(doomedRows.every(r => r.filename === null && r.retained === false));
  assert.equal(day.count, day.created.count + day.updated.count);
  assert.ok(day.items.some(r => r.retained && r.filename), 'R5.1 retained resources still show their filename');

  // R5.1 接口里没有简介、token、访问码和哈希
  const serialized = JSON.stringify(s) + JSON.stringify(day);
  for (const secret of ['PRIVATE-ALICE-TOKEN', 'PRIVATE-BOB-TOKEN', 'PRIVATE-TINY-TOKEN', 'PRIVATE-DESCRIPTION', 'updates-test-password', 'accessCode', 'hash']) assert.ok(!serialized.includes(secret), secret);
  // 日志里没有文件名、简介、token
  const journal = path.join(root, 'data', 'statistics');
  for (const dir of ['uploads', 'updates', 'pending-update', 'deletions']) for (const file of fs.readdirSync(path.join(journal, dir))) {
    const text = fs.readFileSync(path.join(journal, dir, file), 'utf8');
    assert.ok(!text.includes('PRIVATE') && !text.includes('filename') && !text.includes('access'), dir + '/' + file);
  }

  // ---- 浏览器：统计页区分新建和更新（R3.1–R3.8）----
  if (process.argv.includes('--browser')) {
    const { chromium } = require('playwright');
    const evidenceDir = process.env.DEVFLOW_EVIDENCE_DIR;
    const evidence = async (page, name) => { if (evidenceDir) await page.screenshot({ path: path.join(evidenceDir, name + '.png'), fullPage: true }); };
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); const page = await context.newPage();
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.goto(base + '/admin/login'); await page.locator('#user').fill('test'); await page.locator('#password').fill('updates-test-password'); await page.locator('#submit').click(); await page.waitForSelector('#rows tr');
      const loaded = () => page.waitForFunction(() => !document.getElementById('stats-content').hidden && !document.getElementById('day-list').textContent.includes('正在加载'));
      await page.goto(base + '/admin/statistics'); await loaded();
      const api = await summary(), today = api.summary.today;

      // R3.1 卡片显示合计和拆分
      assert.equal((await page.locator('#today-value').textContent()).trim(), today.count + '个');
      assert.equal((await page.locator('#today-split').textContent()).replace(/\s+/g, ''), '新建' + today.created.count + '更新' + today.updated.count);
      assert.equal((await page.locator('#period-split').textContent()).replace(/\s+/g, ''), '新建' + api.summary.uploads.created.count + '更新' + api.summary.uploads.updated.count);
      await evidence(page, 'R3.1');

      // R3.2 趋势柱分两段：每天一个可交互元素；聚焦显示拆分；切到体积仍分两段
      assert.equal(await page.locator('#trend-chart rect.bar').count(), api.daily.length);
      assert.equal(await page.locator(`#trend-chart [data-part="update"][data-date="${api.today}"]`).count(), 1);
      assert.equal(await page.locator(`#trend-chart [data-part="create"][data-date="${api.today}"]`).count(), 1);
      await page.locator(`#trend-chart rect.bar[data-date="${api.today}"]`).focus();
      assert.match(await page.locator('#chart-hover').textContent(), new RegExp('新建 ' + today.created.count + ' · 更新 ' + today.updated.count));
      await page.getByRole('button', { name: '上传体积', exact: true }).click();
      assert.equal(await page.locator(`#trend-chart [data-part="update"][data-date="${api.today}"]`).count(), 1, 'bytes metric is split too');
      await page.getByRole('button', { name: '文件数', exact: true }).click();
      await evidence(page, 'R3.2');

      // R3.3 月历和当日明细
      const cell = page.locator(`#calendar-grid button[data-day="${api.today}"]`);
      assert.match(await cell.locator('.day-count').textContent(), new RegExp('^' + today.count));
      assert.match(await cell.getAttribute('aria-label'), new RegExp('新建 ' + today.created.count + ' 更新 ' + today.updated.count));
      assert.equal(await cell.locator('.mix i.update').count(), 1);
      assert.match(await page.locator('#day-list').textContent(), /更新 · v\d/);
      assert.match(await page.locator('#day-retained').textContent(), /条仍保留/, 'review d1: records, not resources');
      await page.getByRole('button', { name: '查看当日记录 →', exact: true }).click(); await page.waitForSelector('#dialog-body tbody tr');
      assert.deepEqual(await page.locator('#dialog-body thead th').allTextContents(), ['文件', '动作', '类型', '来源', '上传时间', '状态']);
      const actions = await page.locator('#dialog-body tbody tr td:nth-child(2)').allTextContents();
      assert.ok(actions.every(a => a === '新建' || /^更新 · v\d+$/.test(a)), actions.join(','));
      assert.match(await page.locator('#dialog-body').textContent(), /条仍保留/);
      await evidence(page, 'R3.3'); await page.keyboard.press('Escape');

      // R3.4 最近活动
      const activity = await page.locator('#activity-list').textContent();
      assert.match(activity, /更新 v\d/); assert.ok(api.activities.slice(0, 4).every(a => activity.includes(a.kind === 'delete' ? '删除' : a.uploadKind === 'update' ? '更新 v' + a.version : '新建')));
      await page.getByRole('button', { name: '删除', exact: true }).click(); assert.match(await page.locator('#activity-list').textContent(), /账户删除/);
      await page.getByRole('button', { name: '全部', exact: true }).click();
      await evidence(page, 'R3.4');

      // R3.5 类型分布和排行
      const html = api.types.find(t => t.type === 'html');
      assert.match(await page.locator('#type-legend').textContent(), new RegExp('新建 ' + html.created.count + ' · 更新 ' + html.updated.count));
      const alice = api.sources.find(r => r.source === 'alice');
      assert.match(await page.locator('#source-ranking').textContent(), new RegExp('新建 ' + alice.created.count + ' · 更新 ' + alice.updated.count));
      assert.match(await page.locator('#project-ranking').textContent(), /新建 \d+ · 更新 \d+/);
      await evidence(page, 'R3.5');

      // R3.6 / R3.7 筛到没有更新的来源：各处显示更新 0，布局正常
      await page.locator('#source').selectOption('tiny'); await page.waitForFunction(() => document.getElementById('source').value === 'tiny' && !document.getElementById('stats-content').hidden);
      await loaded();
      assert.equal((await page.locator('#today-split').textContent()).replace(/\s+/g, ''), '新建1更新0');
      assert.equal(await page.locator('#trend-chart [data-part="update"]').count(), 0);
      for (const width of [1440, 768, 390]) { await page.setViewportSize({ width, height: 900 }); await page.waitForTimeout(80); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal scroll at ' + width); }
      await evidence(page, 'R3.7');
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.getByRole('button', { name: '重置', exact: true }).click(); await loaded();

      // R3.8 统计口径说明
      await page.locator('#definitions').click(); await page.waitForSelector('#dialog-body .definition');
      const definitions = await page.locator('#dialog-body').textContent();
      assert.match(definitions, /更新/); assert.match(definitions, /删除历史版本，都不算更新/); assert.match(definitions, /上传 = 新建 \+ 更新/);
      await evidence(page, 'R3.8'); await page.keyboard.press('Escape');

      // 深色主题下同样可读
      // 深色主题下“更新”标签跟随主题（d2 / N3）：背景要暗，浅色主题下要亮
      // 文字和背景的对比度不低于 4.5（WCAG AA）
      const tagColors = () => page.locator('#day-list .kind-tag.update').first().evaluate(el => {
        const luminance = c => { const m = c.match(/[\d.]+/g).map(Number); const rgb = c.startsWith('color(srgb') ? m.slice(0, 3) : m.slice(0, 3).map(v => v / 255);
          const lin = v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]); };
        const style = getComputedStyle(el), bg = luminance(style.backgroundColor), fg = luminance(style.color);
        return { bg, contrast: (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05) };
      });
      let tag = await tagColors(); assert.ok(tag.bg > 0.8, 'light theme update tag is light'); assert.ok(tag.contrast >= 4.5, 'light contrast ' + tag.contrast.toFixed(2));
      await page.locator('#theme-select').selectOption('dark'); await page.waitForTimeout(80);
      tag = await tagColors(); assert.ok(tag.bg < 0.35, 'dark theme update tag is dark'); assert.ok(tag.contrast >= 4.5, 'dark contrast ' + tag.contrast.toFixed(2));
      await evidence(page, 'R3-dark'); await page.locator('#theme-select').selectOption('light');
      assert.deepEqual(errors, []);
      console.log('statistics updates browser: cards, stacked trend, calendar/day/dialog tags, activities, breakdowns, empty-update filter, definitions, responsive layout passed');
    } finally { await browser.close(); }
  }

  // R2.2 重启、删索引后重启都不重复
  const totals = (await summary()).summary.uploads;
  await stop(); await start(); await login();
  assert.deepEqual((await summary()).summary.uploads, totals);
  await stop(); fs.rmSync(path.join(root, 'data', 'resources.sqlite'), { force: true }); await start(); await login();
  assert.deepEqual((await summary()).summary.uploads, totals);
  assert.equal(fs.readdirSync(path.join(journal, 'pending-update')).length, 0);

  console.log('statistics updates: --id/site updates, rejected updates, access/label/version edits, concurrent updates, deletion history, privacy and restart idempotence passed');
}
run().finally(async () => { await stop(); fs.rmSync(root, { recursive: true, force: true }); }).catch(error => { console.error(error); process.exitCode = 1; });

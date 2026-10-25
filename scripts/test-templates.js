// 页面模板：模板包校验、可见范围与全局模板、关键词匹配、数据校验与渲染、转义、沙箱权限、
// 版本更新、导出 Excel、删除模板后页面仍可用、自由排版模板、管理员接口、CLI，以及浏览器里的导出和打印。
// 用法：node scripts/test-templates.js [--browser]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { once } = require('node:events');
const { spawn, execFile: execFileCb } = require('node:child_process');
const { promisify } = require('node:util');
const xlsx = require('../lib/xlsx');

const execFile = promisify(execFileCb);
const root = path.resolve(__dirname, '..');
const children = [];
const directories = [];
const EXAMPLE = path.join(root, 'examples', 'templates', 'vendor-bill');
const exampleFiles = () => Object.fromEntries(fs.readdirSync(EXAMPLE).map((f) => [f, fs.readFileSync(path.join(EXAMPLE, f), 'utf8')]));
const exampleData = () => JSON.parse(fs.readFileSync(path.join(EXAMPLE, 'example.json'), 'utf8'));
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

async function scenario(proxy, browserMode) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeview-templates-')); directories.push(temp);
  const mainPort = await port(), renderPort = await port();
  const base = `http://127.0.0.1:${mainPort}`, render = `http://127.0.0.1:${renderPort}`;
  const data = path.join(temp, 'data'); fs.mkdirSync(data);
  const cfg = path.join(temp, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ server: { port: mainPort, base_url: base },
    storage: { retention_days: 0 },
    tokens: [{ name: 'owner', token: 'owner-token', global_templates: true }, { name: 'other', token: 'other-token' }],
    admin: { user: 'test', password: 'test-password', session_secret: 'test-secret' },
    preview: { proxy_to_render: proxy, render_url: render, gateway_token: 'private-test-gateway' } }));
  if (proxy) await start('render-server.js', { RENDER_PORT: String(renderPort), RENDER_DATA_ROOT: data, RENDER_GATEWAY_TOKEN: 'private-test-gateway' }, render);
  await start('server.js', { DVIEW_CONFIG_PATH: cfg, DVIEW_PREVIEW_PROXY: String(proxy), DVIEW_RENDER_GATEWAY_TOKEN: 'private-test-gateway' }, base);

  const api = async (method, url, { token = 'owner-token', body } = {}) => {
    const response = await request(base + url, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const type = response.headers.get('content-type') || '';
    return { status: response.status, body: type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()), headers: response.headers };
  };
  const push = (files, opts = {}) => api('PUT', `/api/templates/${opts.name || 'vendor-bill'}`, { token: opts.token, body: { files, message: opts.message, ...(opts.global !== undefined ? { global: opts.global } : {}) } });
  const readMeta = (id) => JSON.parse(fs.readFileSync(path.join(data, 'meta', id + '.json'), 'utf8'));
  const unlock = async (id, code) => (await request(`${base}/v/${id}/unlock`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code }) })).headers.get('set-cookie').split(';')[0];
  const page = async (id, cookie, suffix = '') => {
    const response = await request(`${base}/v/${id}${suffix}`, { headers: { cookie } });
    return { status: response.status, text: await response.text(), csp: response.headers.get('content-security-policy') || '' };
  };

  // ---- 发布：模板包校验 ----
  const files = exampleFiles();
  const manifest = JSON.parse(files['template.json']);
  const variant = (change) => { const copy = { ...files }; change(copy); return copy; };
  const withManifest = (change) => variant((copy) => { const m = JSON.parse(copy['template.json']); change(m); copy['template.json'] = JSON.stringify(m); });
  const bad = [
    ['missing description', withManifest((m) => { delete m.description; }), /description/],
    ['extra file', variant((copy) => { copy['notes.txt'] = 'x'; }), /notes\.txt/],
    ['unknown schema keyword', variant((copy) => { const s = JSON.parse(copy['schema.json']); s.properties.vendor.pattern = 'x'; copy['schema.json'] = JSON.stringify(s); }), /pattern/],
    ['example does not match', variant((copy) => { const e = JSON.parse(copy['example.json']); e.items[0].qty = '3'; copy['example.json'] = JSON.stringify(e); }), /items\[0\]\.qty/],
    ['unknown feature', withManifest((m) => { m.features.comments = {}; }), /comments/],
    ['export rows not array', withManifest((m) => { m.features.export.xlsx.rows = 'vendor'; }), /rows/],
    ['layout without schema', withManifest((m) => { delete m.schema; }), /schema/],
    ['name mismatch', withManifest((m) => { m.name = 'other-name'; }), /不一致/],
    ['bad json', variant((copy) => { copy['template.json'] = '{'; }), /JSON/],
  ];
  for (const [label, pkg, pattern] of bad) {
    const result = await push(pkg);
    assert.equal(result.status, 400, label);
    assert.ok(result.body.details.some((line) => pattern.test(line)), `${label}: ${JSON.stringify(result.body.details)}`);
  }
  assert.ok(!fs.existsSync(path.join(data, 'templates')) || fs.readdirSync(path.join(data, 'templates')).length === 0, 'rejected packages leave nothing');

  let result = await push(files, { message: '初版' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.created, true); assert.equal(result.body.version, 1); assert.deepEqual(result.body.features, ['print', 'export']);

  // ---- 可见范围、全局模板、匹配 ----
  let match = await api('GET', '/api/templates/match?q=' + encodeURIComponent('帮我给示例客户出 10 月的账单'));
  assert.deepEqual(match.body.templates.map((t) => [t.name, t.matched]), [['vendor-bill', ['账单']]]);
  assert.deepEqual((await api('GET', '/api/templates/match?q=' + encodeURIComponent('做一个贪吃蛇游戏'))).body.templates, []);
  assert.equal((await api('GET', '/api/templates/match?q=INVOICE')).body.templates.length, 1, 'case-insensitive');
  assert.equal((await api('GET', '/api/templates/match?q=' + encodeURIComponent('账单'), { token: 'other-token' })).body.templates.length, 0, 'private to owner');
  assert.equal((await api('GET', '/api/templates/vendor-bill', { token: 'other-token' })).status, 404);
  assert.equal((await push(files, { token: 'other-token', global: true })).status, 403, 'needs global_templates');
  result = await push(files, { global: true, message: '设为全局' });
  assert.equal(result.status, 200); assert.equal(result.body.global, true); assert.equal(result.body.version, 2);
  match = await api('GET', '/api/templates/match?q=' + encodeURIComponent('账单'), { token: 'other-token' });
  assert.equal(match.body.templates[0].name, 'vendor-bill'); assert.equal(match.body.templates[0].global, true); assert.equal(match.body.templates[0].mine, false);

  const detail = (await api('GET', '/api/templates/vendor-bill', { token: 'other-token' })).body;
  assert.ok(detail.fields.some((f) => f.path === 'items[].qty' && f.type === 'number' && f.required));
  assert.equal(detail.example.vendor, '示例科技有限公司'); assert.match(detail.guide, /不要自己算金额/);
  assert.deepEqual(detail.versions.map((v) => v.message), ['初版', '设为全局']);

  // ---- 渲染：数据校验 ----
  const bill = exampleData();
  result = await api('POST', '/api/templates/vendor-bill/render', { body: { data: { ...bill, items: [{ name: 'x', qty: 1, price: '9' }], customer: undefined } } });
  assert.equal(result.status, 422);
  assert.ok(result.body.details.some((line) => line.startsWith('customer')), JSON.stringify(result.body.details));
  assert.ok(result.body.details.some((line) => line.startsWith('items[0].price')), JSON.stringify(result.body.details));
  assert.equal((await api('POST', '/api/templates/vendor-bill/render', { body: {} })).status, 400, 'data required');
  assert.equal((await api('POST', '/api/templates/missing/render', { body: { data: {} } })).status, 404);
  assert.ok(!fs.existsSync(path.join(data, 'html')) || fs.readdirSync(path.join(data, 'html')).length === 0, 'rejected renders leave nothing');

  // ---- 渲染：确定性、转义 ----
  const hostile = { ...bill, notes: '</script><script>window.HACKED=1</script><b>粗体</b>', customer: '客户 <img src=x onerror=alert(1)>' };
  const dry1 = (await api('POST', '/api/templates/vendor-bill/render', { body: { data: hostile, dry_run: true } })).body;
  const dry2 = (await api('POST', '/api/templates/vendor-bill/render', { body: { data: hostile, dry_run: true } })).body;
  assert.equal(dry1.html, dry2.html, 'deterministic');
  assert.equal(dry1.title, '示例科技有限公司 2026-10 账单 · 客户 <img src=x onerror=alert(1)>');
  const dataScript = dry1.html.split('<script type="application/json" id="dview-data">')[1].split('</script>')[0];
  assert.ok(!dataScript.includes('<'), 'data cannot open or close tags');
  assert.deepEqual(JSON.parse(dataScript), hostile, 'data round-trips');
  assert.match(dry1.html, /<title>示例科技有限公司 2026-10 账单 · 客户 &#60;img src=x onerror=alert\(1\)&#62;<\/title>/);
  assert.ok(!dry1.html.includes('<img src=x'), 'title is escaped');

  // ---- 渲染并上传：新建 ----
  const created = await api('POST', '/api/templates/vendor-bill/render', { body: { data: bill, message: '10 月', access_days: 3 } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.id;
  assert.equal(created.body.version, 1); assert.equal(created.body.updated, false); assert.ok(created.body.accessCode);
  assert.deepEqual(created.body.template, { name: 'vendor-bill', version: 2 });
  assert.equal(created.body.category, 'report'); assert.deepEqual(created.body.tags, ['bill']);
  assert.equal(created.body.description, '示例科技有限公司 2026-10 账单 · 示例客户');
  let meta = readMeta(id);
  assert.deepEqual(meta.template.name, 'vendor-bill'); assert.deepEqual(Object.keys(meta.features), ['print', 'export']);
  assert.equal(meta.versions[0].message, '10 月');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'html', id, '.dview-data.json'), 'utf8')), bill);
  const stored = fs.readFileSync(path.join(data, 'html', id, 'vendor-bill.html'), 'utf8');
  assert.equal(stored, (await api('POST', '/api/templates/vendor-bill/render', { body: { data: bill, dry_run: true } })).body.html, 'stored page equals dry run');

  const cookie = await unlock(id, created.body.accessCode);
  let view = await page(id, cookie);
  assert.equal(view.status, 200); assert.ok(view.text.includes('id="dview-toolbar"'));
  assert.equal((await page(id, cookie, '/.dview-data.json')).status, 404, 'data file is not served');
  assert.match(view.csp, /sandbox allow-scripts allow-modals allow-downloads;/, 'features widen the sandbox');

  // 普通页面的沙箱不变
  const plainForm = new FormData(); plainForm.append('file', new Blob(['<p>plain</p>'], { type: 'text/html' }), 'plain.html');
  const plain = await (await request(base + '/upload', { method: 'POST', headers: { Authorization: 'Bearer owner-token' }, body: plainForm })).json();
  view = await page(plain.id, await unlock(plain.id, plain.accessCode));
  assert.match(view.csp, /sandbox allow-scripts;/);
  assert.equal((await api('GET', `/api/me/items/${plain.id}/export.xlsx`)).status, 409, 'plain pages have no export');

  // ---- 导出接口 ----
  let exported = await api('GET', `/api/me/items/${id}/export.xlsx`);
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-disposition'), /filename\*=UTF-8''/);
  const expected = Buffer.from(xlsx.buildXlsx(xlsx.exportTable(bill, manifest.features.export.xlsx)));
  assert.ok(exported.body.equals(expected), 'export matches the shared generator');
  assert.equal((await api('GET', `/api/me/items/${id}/export.xlsx`, { token: 'other-token' })).status, 403);

  // ---- 更新：同一链接生成新版本；改模板不影响已生成的版本 ----
  const changed = variant((copy) => { copy['layout.html'] = copy['layout.html'].replace('<th>项目</th>', '<th>服务项目</th>'); });
  assert.equal((await push(changed, { message: '改表头' })).body.version, 3);
  assert.ok(!(await page(id, cookie)).text.includes('服务项目'), 'existing page unchanged after template change');
  const bill2 = { ...bill, items: [...bill.items, { name: '加急费', qty: 1, price: 88.8 }] };
  const updated = await api('POST', '/api/templates/vendor-bill/render', { body: { data: bill2, id, message: '补充加急费' } });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.id, id); assert.equal(updated.body.version, 2); assert.equal(updated.body.updated, true);
  assert.equal(updated.body.accessCode, undefined); assert.deepEqual(updated.body.template, { name: 'vendor-bill', version: 3 });
  assert.ok((await page(id, cookie)).text.includes('服务项目'));
  assert.ok(!(await page(id, cookie, '/@1')).text.includes('服务项目'), 'old version keeps old layout');
  exported = await api('GET', `/api/me/items/${id}/export.xlsx`);
  assert.ok(exported.body.equals(Buffer.from(xlsx.buildXlsx(xlsx.exportTable(bill2, manifest.features.export.xlsx)))));
  assert.ok((await api('GET', `/api/me/items/${id}/export.xlsx?version=1`)).body.equals(expected), 'export a past version');
  assert.equal((await api('POST', '/api/templates/vendor-bill/render', { body: { data: bill, id: plain.id }, token: 'other-token' })).status, 403);

  // ---- 自己的同名模板遮住全局模板 ----
  const own = withManifest((m) => { m.title = '另一个账单'; });
  assert.equal((await push(own, { token: 'other-token' })).status, 200);
  match = await api('GET', '/api/templates/match?q=' + encodeURIComponent('账单'), { token: 'other-token' });
  assert.deepEqual(match.body.templates.map((t) => [t.name, t.mine]), [['vendor-bill', true]]);
  assert.equal((await api('GET', '/api/templates/vendor-bill', { token: 'other-token' })).body.title, '另一个账单');
  assert.equal((await api('DELETE', '/api/templates/vendor-bill', { token: 'other-token' })).status, 200);
  assert.equal((await api('GET', '/api/templates/vendor-bill', { token: 'other-token' })).body.title, '供应商月度账单', 'falls back to global');

  // ---- 自由排版的模板：upload --template ----
  const free = { 'template.json': JSON.stringify({ name: 'prd-review', title: '需求评审', description: '需求文档和交互原型', match: ['需求', '原型', 'PRD'], category: 'prototype', tags: ['prd'], guide: 'guide.md' }), 'guide.md': '先拉评论再修改' };
  assert.equal((await push(free, { name: 'prd-review' })).status, 200);
  const send = async (template) => {
    const form = new FormData(); form.append('template', template); form.append('file', new Blob(['<title>登录需求</title>PRD'], { type: 'text/html' }), 'prd.html');
    const response = await request(base + '/upload', { method: 'POST', headers: { Authorization: 'Bearer owner-token' }, body: form });
    return { status: response.status, body: await response.json() };
  };
  result = await send('prd-review');
  assert.equal(result.status, 200); assert.equal(result.body.category, 'prototype'); assert.deepEqual(result.body.template, { name: 'prd-review', version: 1 });
  assert.equal(readMeta(result.body.id).template.name, 'prd-review'); assert.equal(readMeta(result.body.id).features, undefined);
  assert.equal((await send('vendor-bill')).status, 400, 'layout templates need render');
  assert.equal((await send('missing')).status, 404);
  assert.equal((await api('POST', '/api/templates/prd-review/render', { body: { data: {} } })).status, 400);

  // ---- 管理员：列表与全局开关 ----
  const login = await request(base + '/admin/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ user: 'test', password: 'test-password' }) });
  const admin = login.headers.get('set-cookie').split(';')[0];
  const all = await (await request(base + '/admin/api/templates', { headers: { cookie: admin } })).json();
  const vb = all.templates.find((t) => t.name === 'vendor-bill');
  assert.ok(vb.global); assert.ok(all.templates.some((t) => t.name === 'prd-review' && !t.global));
  const patch = (tid, value) => request(`${base}/admin/api/templates/${tid}`, { method: 'PATCH', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ global: value }) });
  assert.equal((await patch(vb.id, false)).status, 200);
  assert.equal((await api('GET', '/api/templates/vendor-bill', { token: 'other-token' })).status, 404, 'no longer global');
  assert.equal((await patch(vb.id, true)).status, 200);
  assert.ok((await request(`${base}/admin/api/item/${id}/export.xlsx`, { headers: { cookie: admin } })).ok);

  // ---- 删除模板：已生成的页面仍可打开和导出 ----
  assert.equal((await api('DELETE', '/api/templates/vendor-bill', { token: 'other-token' })).status, 404, 'only own templates');
  assert.equal((await api('DELETE', '/api/templates/vendor-bill')).status, 200);
  assert.equal((await api('GET', '/api/templates/vendor-bill')).status, 404);
  assert.ok((await page(id, cookie)).text.includes('加急费'));
  assert.equal((await api('GET', `/api/me/items/${id}/export.xlsx`)).status, 200);

  // 仓库里的每个示例模板都能发布，并能用它自带的示例数据渲染
  for (const dirName of fs.readdirSync(path.join(root, 'examples', 'templates'))) {
    const dir = path.join(root, 'examples', 'templates', dirName);
    const pkg = Object.fromEntries(fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
    const pushed = await api('PUT', `/api/templates/${dirName}`, { body: { files: pkg } });
    assert.equal(pushed.status, 200, `${dirName}: ${JSON.stringify(pushed.body)}`);
    const rendered = await api('POST', `/api/templates/${dirName}/render`, { body: { data: JSON.parse(pkg['example.json']), dry_run: true } });
    assert.equal(rendered.status, 200, dirName);
    assert.equal((await api('DELETE', `/api/templates/${dirName}`)).status, 200);
  }

  if (!proxy && !browserMode) await cli(base, temp);
  if (browserMode) await browser(base);
  console.log(`templates (${proxy ? 'render proxy' : 'direct'}): package checks, visibility/global, matching, validation, deterministic escaped render, sandbox flags, versions, export, free layout, admin, delete passed`);
}

async function cli(base, temp) {
  const repo = path.join(temp, 'repo'); fs.mkdirSync(path.join(repo, 'bills'), { recursive: true });
  const git = (...args) => execFile('git', ['-C', repo, ...args]);
  await git('init', '-q'); await git('config', 'user.email', 't@example.com'); await git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'bills', 'acme.json'), JSON.stringify(exampleData()));
  await git('add', '.'); await git('commit', '-qm', 'init');
  // 默认 skill 目录存在时，template push / delete 会自动同步本机的 skill
  const skills = path.join(temp, 'skills'); fs.mkdirSync(skills);
  const env = { ...process.env, DVIEW_URL: base, DVIEW_TOKEN: 'owner-token', CLAUDE_SKILLS_DIR: skills };
  const dview = (...args) => execFile('bash', [path.join(root, 'bin/dview'), ...args], { cwd: repo, env });
  const skillFile = (name, dir = skills) => path.join(dir, `dview-tpl-${name}`, 'SKILL.md');
  const mark = (name, dir = skills) => JSON.parse(fs.readFileSync(path.join(dir, `dview-tpl-${name}`, '.dview-template.json'), 'utf8'));

  let out = await dview('template', 'push', EXAMPLE, '-m', 'CLI 发布');
  assert.match(out.stdout, /已发布模板 vendor-bill v1/);
  out = await dview('template', 'list');
  assert.match(out.stdout, /vendor-bill/); assert.match(out.stdout, /账单/);
  out = await dview('template', 'match', '给', 'ACME', '出', '10', '月账单');
  assert.match(out.stdout, /vendor-bill  （命中: 账单）/);
  out = await dview('template', 'match', '做个游戏');
  assert.match(out.stdout, /没有匹配的模板/);
  const matched = JSON.parse((await dview('template', 'match', '对账单', '--json')).stdout);
  assert.equal(matched.templates[0].name, 'vendor-bill');
  out = await dview('template', 'show', 'vendor-bill');
  assert.match(out.stdout, /items\[\]\.price\s+number\s+必填/); assert.match(out.stdout, /示例数据：/); assert.match(out.stdout, /不要自己算金额/);

  // 校验失败时逐条显示
  const broken = path.join(temp, 'broken'); fs.mkdirSync(broken);
  for (const [name, content] of Object.entries(exampleFiles())) fs.writeFileSync(path.join(broken, name), content);
  fs.writeFileSync(path.join(broken, 'extra.css'), 'x');
  await assert.rejects(dview('template', 'push', broken), (error) => /extra\.css/.test(error.stderr));

  // render：.dview.json 以数据文件为键；再次渲染更新原链接
  const first = JSON.parse((await dview('render', 'vendor-bill', '--data', 'bills/acme.json', '--json')).stdout);
  assert.equal(first.version, 1); assert.ok(first.accessCode);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, '.dview.json'), 'utf8')).items, { 'bills/acme.json': first.id });
  const changed = { ...exampleData(), period: '2026-11' };
  fs.writeFileSync(path.join(repo, 'bills', 'acme.json'), JSON.stringify(changed));
  out = await dview('render', 'vendor-bill', '--data', 'bills/acme.json', '-m', '改为 11 月');
  assert.equal(out.stdout.trim(), first.url); assert.match(out.stderr, /第 2 版/);
  const meta = JSON.parse(fs.readFileSync(path.join(temp, 'data', 'meta', first.id + '.json'), 'utf8'));
  assert.equal(meta.versions[1].message, '改为 11 月'); assert.equal(meta.versions[1].git.dirty, true);
  assert.equal(meta.description, '示例科技有限公司 2026-11 账单 · 示例客户');

  // --out 只在本地生成
  await dview('render', 'vendor-bill', '--data', 'bills/acme.json', '--out', 'preview.html');
  assert.match(fs.readFileSync(path.join(repo, 'preview.html'), 'utf8'), /2026-11 账单/);
  // 数据错误：列出字段，不上传
  fs.writeFileSync(path.join(repo, 'bad.json'), JSON.stringify({ vendor: 'x' }));
  await assert.rejects(dview('render', 'vendor-bill', '--data', 'bad.json'), (error) => /customer: 缺少必填字段/.test(error.stderr));
  fs.writeFileSync(path.join(repo, 'broken.json'), '{');
  await assert.rejects(dview('render', 'vendor-bill', '--data', 'broken.json'), (error) => /不是合法的 JSON/.test(error.stderr));

  // pull 得到同样的文件；目录不为空时拒绝
  await dview('template', 'pull', 'vendor-bill', 'pulled');
  for (const [name, content] of Object.entries(exampleFiles())) assert.equal(fs.readFileSync(path.join(repo, 'pulled', name), 'utf8'), content, name);
  await assert.rejects(dview('template', 'pull', 'vendor-bill', 'pulled'), /不为空/);

  // upload --template
  fs.writeFileSync(path.join(repo, 'prd.html'), '<title>PRD</title>x');
  const uploaded = JSON.parse((await dview('upload', 'prd.html', '--template', 'prd-review', '--json')).stdout);
  assert.equal(uploaded.template.name, 'prd-review');

  // ---- 配套 skill ----
  // push 时已自动生成；内容包含步骤、模板说明、字段和示例
  let skill = fs.readFileSync(skillFile('vendor-bill'), 'utf8');
  assert.match(skill, /^---\nname: dview-tpl-vendor-bill\ndescription: ".*账单.*"\n---\n/);
  assert.match(skill, /dview render vendor-bill --data/); assert.match(skill, /不要自己算金额/);
  assert.match(skill, /\| `items\[\]\.price` \| number \| 是 \|/); assert.match(skill, /```json\n\{\n  "vendor"/);
  assert.match(skill, /生成的页面自带：打印、导出 Excel/);
  assert.deepEqual({ ...mark('vendor-bill'), id: 'x' }, { server: base, id: 'x', name: 'vendor-bill', version: 1, global: false, owner: 'owner', generator: 1 });
  // 用户自己的 skill、其他服务的 skill 不受影响；当前服务已删除模板的 skill 会被删掉
  fs.mkdirSync(path.join(skills, 'dview-tpl-mine')); fs.writeFileSync(path.join(skills, 'dview-tpl-mine', 'SKILL.md'), 'mine');
  fs.mkdirSync(path.join(skills, 'dview-tpl-elsewhere'));
  fs.writeFileSync(path.join(skills, 'dview-tpl-elsewhere', '.dview-template.json'), JSON.stringify({ server: 'https://other.example', id: 'zzzz', name: 'elsewhere', version: 1, generator: 1 }));
  fs.mkdirSync(path.join(skills, 'dview-tpl-gone'));
  fs.writeFileSync(path.join(skills, 'dview-tpl-gone', '.dview-template.json'), JSON.stringify({ server: base, id: 'gone0000gone0000', name: 'gone', version: 1, generator: 1 }));
  out = await dview('template', 'skills', 'sync');
  assert.match(out.stdout, /不变 +dview-tpl-vendor-bill +v1/);
  assert.match(out.stdout, /新增 +dview-tpl-prd-review/, 'free-layout template from the API scenario');
  assert.match(out.stdout, /删除 +dview-tpl-gone/);
  assert.ok(fs.existsSync(path.join(skills, 'dview-tpl-mine', 'SKILL.md')) && fs.existsSync(path.join(skills, 'dview-tpl-elsewhere')));
  assert.match(fs.readFileSync(skillFile('prd-review'), 'utf8'), /dview upload <文件> --json --template prd-review/);
  // 新版本：push 自动更新
  out = await dview('template', 'push', EXAMPLE, '-m', '第二版');
  assert.match(out.stderr, /更新 +dview-tpl-vendor-bill +v2/);
  assert.equal(mark('vendor-bill').version, 2);
  // 全局模板：其他账户默认不同步，--global 才同步，之后一直保持同步
  await dview('template', 'push', EXAMPLE, '--global');
  const other = path.join(temp, 'other-skills');
  const otherEnv = { ...env, DVIEW_TOKEN: 'other-token', CLAUDE_SKILLS_DIR: other };
  const asOther = (...args) => execFile('bash', [path.join(root, 'bin/dview'), ...args], { cwd: repo, env: otherEnv });
  await asOther('template', 'skills', 'sync');
  assert.ok(!fs.existsSync(skillFile('vendor-bill', other)), 'global templates need --global');
  out = await asOther('template', 'skills', 'sync', '--global');
  assert.match(out.stdout, /新增 +dview-tpl-vendor-bill/);
  assert.match(fs.readFileSync(skillFile('vendor-bill', other), 'utf8'), /全局模板，作者是账户 owner/);
  out = await asOther('template', 'skills', 'sync');
  assert.match(out.stdout, /不变 +dview-tpl-vendor-bill/, 'once synced, global skills stay');
  out = await asOther('template', 'skills', 'sync', '--only', 'missing-one');
  assert.match(out.stdout, /未找到 +missing-one/);

  out = await dview('template', 'delete', 'vendor-bill');
  assert.match(out.stdout, /已删除模板 vendor-bill/);
  assert.match(out.stderr, /已删除本机的 skill dview-tpl-vendor-bill/);
  assert.ok(!fs.existsSync(path.join(skills, 'dview-tpl-vendor-bill')));
  out = await asOther('template', 'skills', 'sync');
  assert.match(out.stdout, /删除 +dview-tpl-vendor-bill/, 'deleted template removed on next sync');
  console.log('templates CLI: push/list/match/show, validation errors, render with .dview.json, --out, data errors, pull, upload --template, skills sync (auto, update, unmanaged, other server, global, removal), delete passed');
}

// 浏览器：受保护页面里模板脚本正常显示数据；导出 Excel 的文件和接口一致；打印时工具栏隐藏；注入的脚本不执行
async function browser(base) {
  const { chromium } = require('playwright');
  const bill = { ...exampleData(), notes: '</script><script>window.HACKED=1</script>' };
  const api = (url, body) => fetch(base + url, { method: 'POST', headers: { Authorization: 'Bearer owner-token', 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const pushed = await fetch(base + '/api/templates/vendor-bill', { method: 'PUT', headers: { Authorization: 'Bearer owner-token', 'content-type': 'application/json' }, body: JSON.stringify({ files: exampleFiles() }) });
  assert.equal(pushed.status, 200);
  const created = await api('/api/templates/vendor-bill/render', { data: bill });
  const expected = Buffer.from(await (await fetch(`${base}/api/me/items/${created.id}/export.xlsx`, { headers: { Authorization: 'Bearer owner-token' } })).arrayBuffer());
  const instance = await chromium.launch();
  try {
    const context = await instance.newContext({ acceptDownloads: true });
    const tab = await context.newPage();
    const errors = []; tab.on('pageerror', (e) => errors.push(e.message));
    await tab.goto(`${base}/v/${created.id}`);
    await tab.fill('#code', created.accessCode);
    await Promise.all([tab.waitForURL(`${base}/v/${created.id}`), tab.click('button')]);
    await tab.waitForSelector('#rows tr');
    assert.equal(await tab.locator('#rows tr').count(), 3);
    assert.equal(await tab.textContent('#total'), '¥8,013.60'); // 小计 7,560 + 6% 税额 453.60
    assert.equal(await tab.textContent('#notes'), bill.notes, 'hostile notes shown as text');
    assert.equal(await tab.evaluate(() => window.HACKED), undefined);
    assert.equal(await tab.title(), '示例科技有限公司 2026-10 账单 · 示例客户');
    const [download] = await Promise.all([tab.waitForEvent('download'), tab.click('#dview-toolbar button[data-dview="xlsx"]')]);
    assert.equal(download.suggestedFilename(), '示例科技有限公司 2026-10 账单 · 示例客户.xlsx');
    const file = await download.path();
    assert.ok(fs.readFileSync(file).equals(expected), 'browser export equals API export');
    assert.ok(await tab.isVisible('#dview-toolbar'));
    await tab.emulateMedia({ media: 'print' });
    assert.equal(await tab.isVisible('#dview-toolbar'), false, 'toolbar hidden when printing');
    await tab.emulateMedia({ media: 'screen' });
    // window.print 在沙箱里可调用（allow-modals）：替换成计数，确认按钮确实触发打印
    await tab.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
    await tab.click('#dview-toolbar button[data-dview="print"]');
    assert.equal(await tab.evaluate(() => window.__printed), 1);
    assert.deepEqual(errors, []);
    const mobile = await (await instance.newContext({ viewport: { width: 390, height: 800 } })).newPage();
    await mobile.goto(`${base}/v/${created.id}`);
    await mobile.fill('#code', created.accessCode);
    await Promise.all([mobile.waitForURL(`${base}/v/${created.id}`), mobile.click('button')]);
    await mobile.waitForSelector('#rows tr');
    assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal page scroll on phones');
    console.log('templates browser: protected render, escaped notes, xlsx download equals API export, print button, print media hides toolbar, mobile width passed');
  } finally { await instance.close(); }
}

(async () => {
  const browserMode = process.argv.includes('--browser');
  try {
    if (browserMode) await scenario(false, true);
    else { await scenario(false, false); await scenario(true, false); }
  } finally {
    for (const child of children) if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    for (const dir of directories) fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });

#!/usr/bin/env node
// scripts/backup.js：隔离数据目录 → 备份 → 解包核对内容、SQLite 快照、改名目录、清理旧备份
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const root = path.join(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeview-backup-test-'));
try {
  const data = path.join(temp, 'data');
  const pages = path.join(temp, 'pages'); // 改过名的 html 目录，包内应统一成 html/
  for (const dir of ['meta', 'images', 'statistics/uploads']) fs.mkdirSync(path.join(data, dir), { recursive: true });
  fs.mkdirSync(path.join(pages, 'abc'), { recursive: true });
  fs.writeFileSync(path.join(pages, 'abc', 'index.html'), '<h1>hi</h1>');
  fs.writeFileSync(path.join(data, 'meta', 'abc.json'), '{"id":"abc"}');
  fs.writeFileSync(path.join(data, 'statistics', 'uploads', 'abc.json'), '{"id":"abc"}');
  fs.writeFileSync(path.join(data, 'account-state.json'), '{}');
  const db = new DatabaseSync(path.join(data, 'statistics', 'visits.sqlite'));
  db.exec('CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (42);');
  db.close();
  const config = path.join(temp, 'config.yaml');
  fs.writeFileSync(config, [
    'server: { port: 1, base_url: "http://localhost" }',
    `storage: { html_dir: "${pages}", image_dir: "${data}/images", video_dir: "${data}/videos", meta_dir: "${data}/meta" }`,
    `access: { attempts_file: "${data}/preview-attempts.json" }`,
    `admin: { login_attempts_file: "${data}/admin-login-attempts.json" }`,
    'tokens: []', '',
  ].join('\n'));
  const env = { ...process.env, DVIEW_CONFIG_PATH: config, NODE_NO_WARNINGS: '1' };
  const run = (...args) => execFileSync(process.execPath, [path.join(root, 'scripts', 'backup.js'), ...args], { env, encoding: 'utf8' });

  const dest = path.join(data, 'backups');
  // 预置两份旧的自动备份和一份手动备份：--keep 2 只清理最老的自动备份，不碰手动的。
  fs.mkdirSync(dest);
  for (const name of ['auto-20200101T000000Z.tar.gz', 'auto-20200102T000000Z.tar.gz', 'manual.tar.gz']) fs.writeFileSync(path.join(dest, name), '');
  const output = run('--keep', '2');
  assert.match(output, /清理旧备份: auto-20200101T000000Z\.tar\.gz/);
  const files = fs.readdirSync(dest).sort();
  assert.equal(files.length, 3, files.join(','));
  assert.ok(files.includes('manual.tar.gz') && files.includes('auto-20200102T000000Z.tar.gz'));
  const archive = path.join(dest, files.find((f) => f.startsWith('auto-') && f !== 'auto-20200102T000000Z.tar.gz'));
  assert.equal(fs.statSync(archive).mode & 0o777, 0o600, 'archive is private');
  assert.equal(fs.statSync(dest).mode & 0o777, 0o700, 'backup directory is private');

  const out = path.join(temp, 'restore');
  fs.mkdirSync(out);
  execFileSync('tar', ['-xzf', archive, '-C', out]);
  assert.equal(fs.readFileSync(path.join(out, 'html', 'abc', 'index.html'), 'utf8'), '<h1>hi</h1>', 'renamed html dir stored as html/');
  assert.ok(fs.existsSync(path.join(out, 'meta', 'abc.json')));
  assert.ok(fs.existsSync(path.join(out, 'statistics', 'uploads', 'abc.json')));
  assert.ok(fs.existsSync(path.join(out, 'account-state.json')));
  assert.ok(fs.existsSync(path.join(out, 'config.yaml')));
  assert.ok(fs.existsSync(path.join(out, 'images')));
  assert.ok(!fs.existsSync(path.join(out, 'videos')), 'missing directories are skipped');
  const snapshot = new DatabaseSync(path.join(out, 'statistics', 'visits.sqlite'), { readOnly: true });
  assert.equal(snapshot.prepare('SELECT n FROM t').get().n, 42, 'visits snapshot is readable');
  snapshot.close();
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.entries.html, pages, 'manifest records the original path');

  // --no-config：不带 token 和管理员密码
  const plain = path.join(temp, 'plain');
  run('--dest', plain, '--no-config');
  const members = execFileSync('tar', ['-tzf', path.join(plain, fs.readdirSync(plain)[0])], { encoding: 'utf8' });
  assert.ok(!/config\.yaml/.test(members), 'config.yaml excluded');
  assert.ok(!fs.readdirSync(plain).some((f) => f.endsWith('.partial')), 'no partial file left');

  console.log('backup: uploads/meta/statistics/state, sqlite snapshot, renamed dirs, manifest, private permissions, retention, --no-config passed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

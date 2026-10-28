const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeview-index-'));
const configPath = path.join(root, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({
  server: { port: 3210, base_url: 'http://127.0.0.1:3210' },
  storage: { meta_dir: './data/meta', max_size_mb: 10, retention_days: 0 },
  tokens: [],
  admin: { user: 'admin', password: 'test', session_secret: 'test' },
}));
fs.mkdirSync(path.join(root, 'data', 'meta'), { recursive: true });
process.env.DVIEW_CONFIG_PATH = configPath;

const index = require('../lib/resource-index');
const metas = [
  {
    id: 'alpha', type: 'html', filename: 'Alpha.html', description: 'needle page',
    mime: 'text/html', size: 10, source: 'alice', createdAt: '2026-01-02T00:00:00.000Z',
    category: 'game', agent: 'claude-code', model: 'claude-opus-5-5', project: 'arcade', tags: ['h5', 'demo'],
  },
  {
    id: 'beta', type: 'image', filename: 'Beta.png', description: 'image',
    mime: 'image/png', size: 20, source: 'bob', createdAt: '2026-01-01T00:00:00.000Z',
  },
];

assert.strictEqual(index.rebuild(metas), true);
assert.strictEqual(index.isAvailable(), true);
assert.ok(fs.existsSync(index.dbPath()));

let result = index.listPage({ page: 1, pageSize: 1 });
assert.strictEqual(result.total, 2);
assert.strictEqual(result.totalPages, 2);
assert.strictEqual(result.items[0].id, 'alpha');

result = index.listPage({ q: 'needle', pageSize: 20 });
assert.strictEqual(result.total, 1);
assert.strictEqual(result.items[0].id, 'alpha');
assert.deepStrictEqual(index.sources(), ['alice', 'bob']);
assert.strictEqual(result.items[0].indexed, true);
assert.deepStrictEqual(index.idsBySource('bob'), ['beta']);
assert.deepStrictEqual(index.idsBySource('nobody'), []);
assert.strictEqual(index.usageBySource().get('alice').bytes, 10);

// 分类筛选、未分类筛选、标签与 facet 计数
assert.deepStrictEqual(result.items[0].tags, ['h5', 'demo']);
assert.strictEqual(result.items[0].category, 'game');
assert.strictEqual(index.listPage({ category: 'game' }).total, 1);
assert.strictEqual(index.listPage({ category: 'none' }).items[0].id, 'beta');
assert.strictEqual(index.listPage({ agent: 'claude-code', project: 'arcade' }).total, 1);
assert.strictEqual(index.listPage({ tag: 'demo' }).items[0].id, 'alpha');
assert.strictEqual(index.listPage({ tag: 'missing' }).total, 0);
assert.strictEqual(index.listPage({ q: 'arcade' }).total, 1, 'search covers project');
assert.strictEqual(index.listPage({ q: 'h5' }).total, 1, 'search covers tags');
assert.strictEqual(index.listPage({ sort: 'category', order: 'asc' }).items[0].id, 'beta');
let facets = index.facets();
assert.deepStrictEqual(facets.category, [{ value: '', count: 1 }, { value: 'game', count: 1 }]);
assert.deepStrictEqual(facets.tag.map((row) => row.value).sort(), ['demo', 'h5']);

index.upsert({ ...metas[0], size: 15, tags: ['h5'] });
assert.strictEqual(index.listPage({ tag: 'demo' }).total, 0, 'upsert replaces tags');
assert.strictEqual(index.usageBySource().get('alice').bytes, 15);
index.remove('beta');
assert.strictEqual(index.listPage({ pageSize: 20 }).total, 1);
index.remove('alpha');
assert.strictEqual(index.facets().tag.length, 0, 'remove clears tags');

fs.rmSync(root, { recursive: true, force: true });
console.log('resource index: passed');

// 旧版库（无分类列）打开时应就地迁移
const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeview-index-legacy-'));
fs.mkdirSync(path.join(legacyRoot, 'data', 'meta'), { recursive: true });
const { DatabaseSync } = require('node:sqlite');
const legacy = new DatabaseSync(path.join(legacyRoot, 'data', 'resources.sqlite'));
legacy.exec(`CREATE TABLE resources (id TEXT PRIMARY KEY, type TEXT NOT NULL, filename TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', mime TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`);
legacy.exec("INSERT INTO resources VALUES ('old', 'html', 'old.html', '', 'text/html', 1, 'alice', '2026-01-01')");
legacy.close();
const legacyConfig = path.join(legacyRoot, 'config.json');
fs.writeFileSync(legacyConfig, JSON.stringify({
  server: { port: 3211, base_url: 'http://127.0.0.1:3211' },
  storage: { meta_dir: './data/meta', max_size_mb: 10, retention_days: 0 },
  tokens: [],
  admin: { user: 'admin', password: 'test', session_secret: 'test' },
}));
const { execFileSync } = require('child_process');
const migrated = execFileSync(process.execPath, ['-e', `
  const index = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'resource-index'))});
  const page = index.listPage({ category: 'none' });
  index.upsert({ id: 'new', type: 'html', filename: 'n.html', createdAt: '2026-01-02', category: 'doc', tags: ['x'] });
  console.log(JSON.stringify({ old: page.total, doc: index.listPage({ category: 'doc' }).total }));
`], { env: { ...process.env, DVIEW_CONFIG_PATH: legacyConfig }, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
assert.deepStrictEqual(JSON.parse(migrated.trim().split('\n').pop()), { old: 1, doc: 1 });
fs.rmSync(legacyRoot, { recursive: true, force: true });
console.log('resource index migration: passed');

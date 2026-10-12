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
assert.strictEqual(index.usageBySource().get('alice').bytes, 10);

index.upsert({ ...metas[0], size: 15 });
assert.strictEqual(index.usageBySource().get('alice').bytes, 15);
index.remove('beta');
assert.strictEqual(index.listPage({ pageSize: 20 }).total, 1);

fs.rmSync(root, { recursive: true, force: true });
console.log('resource index: passed');

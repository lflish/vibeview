const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const c = require('../lib/classification');

assert.equal(c.normalizeCategory(' Game '), 'game');
assert.equal(c.normalizeCategory('小游戏'), 'other', 'unknown category falls back to other');
assert.equal(c.normalizeCategory(''), '');
assert.equal(c.normalizeCategory(undefined), '');
assert.equal(c.normalizeLabel('Claude Code'), 'claude-code');
assert.equal(c.normalizeLabel('  vibeview/../x '), 'vibeview..x');
assert.equal(c.normalizeLabel('数据看板'), '数据看板');
assert.equal(c.normalizeLabel('x'.repeat(100)).length, 64);
assert.equal(c.normalizeModel('Claude-Opus-5-5'), 'claude-opus-5-5');
assert.equal(c.normalizeModel('org/model:v1.2 <b>'), 'org/model:v1.2-b');
assert.deepEqual(c.normalizeTags('Q3, onboarding，Q3 ,, '), ['q3', 'onboarding']);
assert.deepEqual(c.normalizeTags(['a,b', 'c']), ['a', 'b', 'c']);
assert.equal(c.normalizeTags(Array.from({ length: 20 }, (_, i) => `t${i}`)).length, c.MAX_TAGS);
assert.deepEqual(c.normalize({}), { category: '', agent: '', model: '', project: '', tags: [] });

assert.deepEqual(
  c.htmlClassification('<meta name="dview:category" content="slides"><meta content="a, b" name="DVIEW:tags">'),
  { category: 'slides', tags: 'a, b' }
);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeview-class-'));
try {
  const file = path.join(root, 'index.html');
  fs.writeFileSync(file, '<meta name="dview:category" content="game"><meta name="dview:tags" content="h5">');
  // 显式字段优先，缺失字段回退到 HTML meta
  assert.deepEqual(c.forUpload(file, 'html', { tags: 'demo', agent: 'Codex' }),
    { category: 'game', agent: 'codex', model: '', project: '', tags: ['demo'] });
  assert.deepEqual(c.forUpload(file, 'image', {}).category, '', 'non-HTML ignores file content');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

const meta = { category: 'report', agent: 'codex', model: '', project: 'p', tags: ['x'] };
assert.deepEqual(c.applyPatch(meta, { tags: '' }), { ...meta, tags: [] });
assert.deepEqual(c.applyPatch(meta, { category: 'dashboard' }), { ...meta, category: 'dashboard' });
assert.deepEqual(c.applyPatch(meta, { unrelated: 1 }), meta);

console.log('classification: passed');

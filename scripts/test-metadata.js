const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const metadata = require('../lib/metadata');

assert.equal(
  metadata.htmlDescription('<meta name="description" content="A &amp; B"><title>Ignored</title>'),
  'A & B'
);
assert.equal(metadata.htmlDescription('<title>Report &amp; Review</title>'), 'Report & Review');
assert.equal(metadata.htmlDescription('<h1>Weekly report</h1>'), 'Weekly report');
assert.equal(metadata.descriptionForUpload('', 'image', ''), '');
assert.equal(metadata.normalizeDescription('   '), '');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeview-metadata-'));
try {
  const file = path.join(root, 'index.html');
  fs.writeFileSync(file, '<html><head><title>Stored title</title></head></html>');
  assert.equal(metadata.descriptionFromFile(file, 'html'), 'Stored title');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('metadata extraction: passed');

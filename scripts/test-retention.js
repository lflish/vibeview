const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Each case loads config in a fresh process and cleans only an isolated fixture.
for (const days of [undefined, 0, 30]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeview-retention-'));
  try {
    const configPath = path.join(root, 'config.yaml');
    fs.writeFileSync(configPath, JSON.stringify({
      storage: days === undefined ? {} : { retention_days: days },
      tokens: [
        { name: 'inherited', token: 'test-inherited' },
        { name: 'keep', token: 'test-keep', retention_days: 0 },
        { name: 'expire', token: 'test-expire', retention_days: 1 },
      ],
    }));
    const result = spawnSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const path = require('node:path');
      const config = require('./lib/config');
      const store = require('./lib/store');
      const { cleanupExpired } = require('./lib/cleanup');
      assert.equal(config.storage.retentionDays, ${days ?? 0});
      const fixtures = ['inherited', 'keep', 'expire'].map(source => {
        const id = store.newId();
        const dir = store.fileDir('html', id);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'index.html');
        fs.writeFileSync(file, 'fixture');
        store.writeMeta(id, { id, type: 'html', filename: 'index.html', source,
          createdAt: new Date(Date.now() - 90 * 86400000).toISOString() });
        return { id, file };
      });
      assert.equal(cleanupExpired(), ${days === 30 ? 2 : 1});
      const expected = [${days !== 30}, true, false];
      fixtures.forEach(({id, file}, i) => {
        assert.equal(Boolean(store.readMeta(id)), expected[i]);
        assert.equal(fs.existsSync(file), expected[i]);
      });
    `], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8',
      env: { ...process.env, DVIEW_CONFIG_PATH: configPath },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    console.log(`retention ${days ?? 'omitted'}: passed`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

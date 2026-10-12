const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAttemptLimiter } = require('../lib/access-attempts');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeview-attempts-'));
try {
  let time = 1000;
  const file = path.join(temp, 'attempts.json');
  const options = { file, maxAttempts: 3, windowMs: 60000, now: () => time };
  let limiter = createAttemptLimiter(options);
  for (let n = 0; n < 3; n++) assert.equal(limiter.take('page-a').allowed, true);
  assert.deepEqual(limiter.take('page-a'), { allowed: false, retryAfter: 60 });
  limiter = createAttemptLimiter(options);
  assert.equal(limiter.take('page-a').allowed, false, 'restart preserves lockout');
  assert.equal(limiter.take('page-b').allowed, true, 'different pages have independent limits');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  time += 60001;
  assert.equal(limiter.take('page-a').allowed, true, 'window expiry restores access');
  limiter.clear('page-a');
  limiter = createAttemptLimiter(options);
  for (let n = 0; n < 3; n++) assert.equal(limiter.take('page-a').allowed, true);
  fs.writeFileSync(file, 'corrupted');
  assert.throws(() => createAttemptLimiter(options), 'corrupt state must not silently reset limits');
  const directory = path.join(temp, 'not-a-file'); fs.mkdirSync(directory);
  assert.throws(() => createAttemptLimiter({ ...options, file: directory }));
  console.log('access attempts: persistent lockout, independent pages, cooldown, reset, permissions, corrupt state passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }

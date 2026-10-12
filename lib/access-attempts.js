const fs = require('node:fs');
const path = require('node:path');

// Resource-wide limits also cover distributed guesses and cannot be spoofed by headers.
// One main-service process owns this file; it is not a multi-worker counter store.
function createAttemptLimiter({ file, maxAttempts = 10, windowMs = 600000, now = Date.now }) {
  const entries = new Map();
  if (file && fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(saved)) throw new Error('Invalid preview attempt state');
    for (const [key, entry] of saved) {
      if (typeof key !== 'string' || !Number.isInteger(entry?.count) || entry.count < 0 || !Number.isFinite(entry.until)) {
        throw new Error('Invalid preview attempt state');
      }
      if (entry.until > now()) entries.set(key, entry);
    }
  }
  function save() {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify([...entries]), { mode: 0o600 });
    fs.renameSync(temporary, file);
  }
  function take(id) {
    const current = now();
    for (const [key, entry] of entries) if (entry.until <= current) entries.delete(key);
    const entry = entries.get(id) || { count: 0, until: current + windowMs };
    if (entry.count >= maxAttempts || (!entries.has(id) && entries.size >= 10000)) {
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((entry.until - current) / 1000)) };
    }
    entry.count++;
    entries.set(id, entry);
    // Persist before hashing: restart or parallel requests cannot evade the counter.
    save();
    return { allowed: true };
  }
  function clear(id) { if (entries.delete(id)) save(); }
  return { take, clear };
}

module.exports = { createAttemptLimiter };

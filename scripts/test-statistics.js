const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStatistics } = require('../lib/statistics-store');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeview-stats-unit-'));
let time = Date.parse('2026-10-12T06:30:00Z');
const options = { directory: path.join(root, 'events'), metaDir: path.join(root, 'meta'), dirForType: type => path.join(root, type), now: () => time, logger: { warn() {} } };
fs.mkdirSync(options.metaDir, { recursive: true });
let serial = 0;
function meta(overrides = {}) {
  return { id: String(++serial).padStart(16, '0'), type: 'html', source: 'alice', size: 100,
    filename: 'PRIVATE-FILENAME.html', description: 'PRIVATE-DESCRIPTION', access: { hash: 'PRIVATE-ACCESS-HASH' }, token: 'PRIVATE-TOKEN',
    createdAt: new Date(time).toISOString(), ...overrides };
}
function save(m) { fs.mkdirSync(path.join(options.dirForType(m.type), m.id), { recursive: true }); fs.writeFileSync(path.join(options.dirForType(m.type), m.id, m.filename), 'fixture'); fs.writeFileSync(path.join(options.metaDir, m.id + '.json'), JSON.stringify(m)); }
function upload(stats, m) { const ticket = stats.prepareUpload(m); save(m); stats.commitUpload(m, ticket); return m; }
function remove(stats, m, reason) { const ticket = stats.prepareDelete(m, reason); fs.rmSync(path.join(options.dirForType(m.type), m.id), { recursive: true }); fs.rmSync(path.join(options.metaDir, m.id + '.json')); stats.commitDelete(ticket); }
try {
  const legacy = meta({ createdAt: '2026-10-11T15:59:59.000Z', source: 'legacy-only' }); save(legacy);
  const invalid = meta({ createdAt: 'not-a-date' }); save(invalid);
  fs.writeFileSync(path.join(options.metaDir, 'malformed.json'), '{bad json');
  let stats = createStatistics(options); stats.initialize();
  let result = stats.summary(); assert.equal(result.summary.uploads.count, 1); assert.equal(result.summary.current.count, 2); assert.equal(result.coverage.skippedMetadata, 2); assert.equal(result.coverage.completeFromDate, '2026-10-13');
  assert.equal(result.daily.find(d => d.date === '2026-10-11').count, 1); assert.equal(result.daily.find(d => d.date === '2026-10-12').count, 0);
  assert.equal(stats.prepareUpload({ ...invalid, access: { mode: 'public' } }), null, 'legacy policy updates work even with missing creation time');
  const live = upload(stats, meta({ createdAt: '2026-10-11T16:00:00.000Z', size: 200 }));
  // Access policy edits do not create a second upload.
  const updated = { ...live, access: { hash: 'ROTATED-PRIVATE-HASH' } }; const ticket = stats.prepareUpload(updated); assert.equal(ticket, null); save(updated); stats.commitUpload(updated, ticket);
  const image = upload(stats, meta({ type: 'image', source: 'bob', size: 300, filename: 'PRIVATE-IMAGE.png' }));
  assert.equal(stats.summary().summary.today.count, 2);
  assert.equal(stats.summary({ source: 'alice', type: 'html' }).summary.today.count, 1);
  assert.equal(stats.summary({ range: '7' }).daily.length, 7); assert.equal(stats.summary({ range: 'month' }).daily.length, 12);
  const month = stats.summary().calendar.days; assert.equal(month.length, 31); assert.equal(month[12].future, true); assert.equal(month[12].count, null);
  remove(stats, live, 'admin'); remove(stats, image, 'owner'); remove(stats, legacy, 'retention');
  result = stats.summary(); assert.equal(result.summary.uploads.count, 3); assert.equal(result.summary.current.count, 1); assert.deepEqual([result.summary.deletions.admin,result.summary.deletions.owner,result.summary.deletions.retention],[1,1,1]);
  assert.ok(result.availableSources.includes('legacy-only')); assert.ok(result.sources.find(s => s.source === 'legacy-only').count === 1);
  const records = stats.day({ date: '2026-10-12', pageSize: '1', page: '2' }); assert.equal(records.total, 2); assert.equal(records.items[0].filename, null); assert.equal(records.retainedCount, 0); assert.equal(records.totalPages, 2);
  assert.equal(stats.summary({ from: '2026-10-01', to: '2026-10-11' }).summary.today.count, 2, 'today independent of history range');
  stats = createStatistics(options); stats.initialize(); assert.equal(stats.summary().summary.uploads.count, 3); assert.equal(stats.summary().summary.deletions.count, 3); assert.equal(stats.summary().coverage.backfilledUploads, 1);
  assert.throws(() => stats.prepareUpload(live), /reuse/);
  const abandoned = meta(); stats.prepareUpload(abandoned); fs.mkdirSync(path.join(options.dirForType(abandoned.type), abandoned.id), { recursive: true });
  const interrupted = meta(); stats.prepareUpload(interrupted); save(interrupted); // metadata committed, event move interrupted
  stats = createStatistics(options); stats.initialize(); assert.equal(stats.summary().summary.uploads.count, 4); assert.equal(fs.existsSync(path.join(options.dirForType(abandoned.type), abandoned.id)), false);
  stats.prepareDelete(interrupted, 'admin'); // deletion intent committed, filesystem work interrupted
  stats = createStatistics(options); stats.initialize(); assert.equal(fs.existsSync(path.join(options.metaDir, interrupted.id + '.json')), false); assert.equal(stats.summary().summary.deletions.count, 4); assert.equal(stats.summary().summary.uploads.count, 4);
  const pendingCommit = meta(); const pending = stats.prepareUpload(pendingCommit); save(pendingCommit);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (from.includes('pending-upload')) { const e = new Error('injected'); e.code = 'EIO'; throw e; } return rename(from, to); };
  try { stats.commitUpload(pendingCommit, pending); } finally { fs.renameSync = rename; }
  assert.equal(stats.summary().summary.uploads.count, 5, 'commit remains successful with a durable intent');
  remove(stats, pendingCommit, 'admin'); // delete before the interrupted upload move is recovered
  stats = createStatistics(options); stats.initialize(); assert.equal(stats.summary().summary.uploads.count, 5); assert.equal(stats.summary().summary.deletions.count, 5);
  const oldClock = stats.summary().coverage.startedAt; time += 2 * 86400000; stats = createStatistics(options); stats.initialize(); assert.equal(stats.summary().coverage.startedAt, oldClock); assert.equal(stats.summary({ from: '2026-10-13', to: '2026-10-14' }).coverage.periodComplete, true);
  for (const query of [{from:'2026-02-30'}, {from:'2026-10-13',to:'2026-10-01'}, {to:'2099-01-01'}, {from:'2020-01-01'}, {type:'bad'}, {source:['alice']}, {month:'2026-13'}, {month:'2099-01'}, {range:'0'}]) assert.throws(() => stats.summary(query), e => e.status === 400);
  for (const query of [{date:'2099-01-01'}, {date:'2026-02-30'}, {page:'0'}, {pageSize:'101'}, {page:['1','2']}]) assert.throws(() => stats.day(query), e => e.status === 400);
  assert.equal(stats.summary({ from: '2025-10-14', to: '2026-10-14' }).daily.length, 366);
  const ny = createStatistics({ ...options, directory: path.join(root,'ny'), timezone: 'America/New_York' });
  assert.equal(ny.dateOf('2026-03-08T04:59:59Z'), '2026-03-07'); assert.equal(ny.dateOf('2026-03-08T05:00:00Z'), '2026-03-08'); assert.equal(ny.dateOf('2026-03-09T03:59:59Z'), '2026-03-08'); assert.equal(ny.dateOf('2026-03-09T04:00:00Z'), '2026-03-09');
  assert.equal(ny.dateOf('2026-11-01T05:30:00Z'), ny.dateOf('2026-11-01T06:30:00Z'));
  assert.throws(() => createStatistics({ ...options, timezone: 'bad-zone' }), RangeError);
  for (const directory of ['uploads','deletions','pending-upload','pending-delete']) for (const file of fs.readdirSync(path.join(options.directory, directory))) {
    const full = path.join(options.directory, directory, file); assert.equal(fs.statSync(full).mode & 0o777, 0o600); const text = fs.readFileSync(full,'utf8'); assert.ok(!text.includes('PRIVATE') && !text.includes('filename') && !text.includes('access'));
  }
  assert.equal(fs.statSync(options.directory).mode & 0o777,0o700);
  // Intent I/O failure cannot start a deletion or create an upload record.
  const safe = meta(); upload(stats, safe); const beforeFailure = stats.summary().summary.uploads.count;
  const openSync = fs.openSync;
  fs.openSync = (file, ...args) => { if (String(file).includes('pending-')) { const error = new Error('injected disk failure'); error.code = 'EIO'; throw error; } return openSync(file, ...args); };
  try {
    assert.throws(() => stats.prepareUpload(meta()), /injected/);
    assert.throws(() => stats.prepareDelete(safe, 'admin'), /injected/);
  } finally { fs.openSync = openSync; }
  assert.ok(fs.existsSync(path.join(options.metaDir, safe.id + '.json')));
  assert.equal(stats.summary().summary.uploads.count, beforeFailure);
  // Corrupted event history must not be silently reported as zero.
  fs.writeFileSync(path.join(options.directory,'uploads',pendingCommit.id+'.json'),'{}'); assert.throws(() => createStatistics(options).initialize(), /Invalid statistics journal/);
  console.log('statistics unit: backfill, midnight/DST, immutable uploads, delete reasons/privacy, filters/pagination, zero days, range validation, restart and interrupted operations passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }

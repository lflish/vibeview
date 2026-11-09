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
  // ---- 更新事件（docs/changes/2026-11-09-stats-create-vs-update，T1、T2）----
  {
    const uroot = path.join(root, 'updates-case');
    const uopt = { directory: path.join(uroot, 'events'), metaDir: path.join(uroot, 'meta'), dirForType: type => path.join(uroot, type), now: () => time, logger: { warn() {} } };
    fs.mkdirSync(uopt.metaDir, { recursive: true });
    const at = offset => new Date(time - 3600000 + offset).toISOString(); // 一小时前起算，避免事件落在“现在”之后
    function umeta(overrides = {}) {
      const createdAt = overrides.createdAt || at(0), size = overrides.size === undefined ? 100 : overrides.size;
      return { id: String(++serial).padStart(16, '0'), type: 'html', source: 'alice', project: 'proj-a', size, filename: 'PRIVATE-FILENAME.html', description: 'PRIVATE-DESCRIPTION',
        access: { hash: 'PRIVATE-ACCESS-HASH' }, createdAt, current: 1, versions: [{ n: 1, filename: 'PRIVATE-FILENAME.html', size, createdAt }], ...overrides };
    }
    function usave(m) { fs.mkdirSync(path.join(uopt.dirForType(m.type), m.id), { recursive: true }); fs.writeFileSync(path.join(uopt.metaDir, m.id + '.json'), JSON.stringify(m)); }
    function uwrite(stats, m) { const ticket = stats.prepareUpload(m); try { usave(m); } catch (error) { stats.cancelUpload(ticket); throw error; } stats.commitUpload(m, ticket); return ticket; }
    function withVersion(m, n, size, createdAt = at(n * 1000)) { const versions = [...m.versions, { n, filename: 'PRIVATE-FILENAME.html', size, createdAt }]; return { ...m, current: n, versions, size: versions.reduce((t, v) => t + v.size, 0), updatedAt: createdAt }; }
    function withoutVersion(m, n) { const versions = m.versions.filter(v => v.n !== n); return { ...m, versions, size: versions.reduce((t, v) => t + v.size, 0) }; }
    function uremove(stats, m) { const ticket = stats.prepareDelete(m, 'admin'); fs.rmSync(path.join(uopt.dirForType(m.type), m.id), { recursive: true, force: true }); fs.rmSync(path.join(uopt.metaDir, m.id + '.json')); stats.commitDelete(ticket); }
    const fresh = () => { const s = createStatistics(uopt); s.initialize(); return s; };
    const ups = s => s.summary().summary.uploads;

    // R2.1 / R2.3 / H8：启动前就存在的资源，回填保留的版本；无效版本跳过；新建体积取 v1
    let pre = umeta({ size: 100 }); pre = withVersion(pre, 2, 40); pre = withVersion(pre, 3, 30); pre = withVersion(pre, 4, 20); pre = withoutVersion(pre, 3); usave(pre); // backfill_retained_versions
    let bad = umeta({ size: 10 }); bad = withVersion(bad, 2, 5, 'bad'); usave(bad); // backfill_skips_invalid_versions / current_version_invalid_returns_null
    let stats = fresh();
    let u = ups(stats);
    assert.equal(u.updated.count, 2, 'backfill_retained_versions: v2 and v4');
    assert.equal(u.updated.bytes, 60);
    assert.equal(u.created.count, 2); assert.equal(u.created.bytes, 110, 'seed_uses_v1_size: create bytes come from v1, not meta.size');
    assert.equal(u.count, u.created.count + u.updated.count); assert.equal(u.bytes, u.created.bytes + u.updated.bytes);
    let cov = stats.summary().coverage; assert.equal(cov.backfilledUpdates, 2); assert.equal(cov.skippedVersions, 1, 'backfill_skips_invalid_versions');
    const backfilledRows = stats.day({ date: stats.summary().today, pageSize: '100' }).items.filter(r => r.id === pre.id && r.uploadKind === 'update');
    assert.deepEqual(backfilledRows.map(r => [r.version, r.at, r.backfilled]).sort(), [[2, pre.versions[1].createdAt, true], [4, pre.versions[2].createdAt, true]]);
    // current_version_invalid_returns_null：当前版本记录无效时，改访问码不抛错、不记更新
    assert.equal(uwrite(stats, { ...bad, access: { hash: 'ROTATED' } }), null);
    assert.equal(ups(stats).updated.count, 2);
    // backfill_idempotent
    stats = fresh(); stats = fresh(); assert.equal(ups(stats).updated.count, 2);

    // R1.1 update_live_version_counts_once
    let live = umeta({ size: 100 }); uwrite(stats, live);
    live = withVersion(live, 2, 40); const ticket = uwrite(stats, live);
    assert.equal(ticket.updates.length, 1); assert.equal(ticket.upload, null);
    u = ups(stats); assert.equal(u.updated.count, 3); assert.equal(u.created.count, 3);
    // access_edit_after_update_not_counted
    assert.equal(uwrite(stats, { ...live, access: { hash: 'ROTATED' } }), null); assert.equal(ups(stats).updated.count, 3);
    // deleted_version_not_recounted：v1、v2、v3 → 删 v2 → v4
    live = withVersion(live, 3, 30); uwrite(stats, live); assert.equal(ups(stats).updated.count, 4);
    live = withoutVersion(live, 2); assert.equal(uwrite(stats, live), null); assert.equal(ups(stats).updated.count, 4);
    live = withVersion(live, 4, 20); uwrite(stats, live); assert.equal(ups(stats).updated.count, 5);
    stats = fresh(); assert.equal(ups(stats).updated.count, 5, 'deleted version is not backfilled again after restart');

    // legacy_resource_update_counts：没有新建记录的老资源（创建时间无效）被更新
    const skippedBefore = stats.summary().coverage.skippedMetadata;
    let legacy = umeta({ createdAt: 'not-a-date' }); legacy.versions = [{ n: 1, filename: 'x.html', size: 100, createdAt: 'not-a-date' }]; usave(legacy);
    stats = fresh(); const legacySkipped = stats.summary().coverage.skippedMetadata; assert.equal(legacySkipped, skippedBefore + 1);
    legacy = withVersion(legacy, 2, 7); uwrite(stats, legacy);
    assert.equal(ups(stats).updated.count, 6); assert.equal(stats.summary().coverage.skippedMetadata, legacySkipped);

    // R2.2：重启不重复
    stats = fresh(); assert.equal(ups(stats).updated.count, 6);

    // R1.7 update_intent_recovery：意图在、元数据已提交 → 记一次
    live = withVersion(live, 5, 9); stats.prepareUpload(live); usave(live);
    stats = fresh(); assert.equal(ups(stats).updated.count, 7);
    assert.equal(fs.readdirSync(path.join(uopt.directory, 'pending-update')).length, 0);
    // recover_uncommitted_update_cleans_dir：意图在、元数据没提交 → 不记，删意图和孤立的版本目录
    const orphan = withVersion(live, 6, 9); stats.prepareUpload(orphan);
    const orphanDir = path.join(uopt.dirForType('html'), live.id, '.versions', '6'); fs.mkdirSync(orphanDir, { recursive: true });
    stats = fresh(); assert.equal(ups(stats).updated.count, 7);
    assert.equal(fs.readdirSync(path.join(uopt.directory, 'pending-update')).length, 0); assert.equal(fs.existsSync(orphanDir), false);

    // delete_finalizes_pending_update：转正时 rename 失败，随后删除资源，重启后仍记一次
    let doomed = umeta({ size: 50 }); uwrite(stats, doomed); doomed = withVersion(doomed, 2, 5);
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => { if (String(from).includes('pending-update') && String(from).endsWith('.json')) { const e = new Error('injected'); e.code = 'EIO'; throw e; } return rename(from, to); };
    try { uwrite(stats, doomed); } finally { fs.renameSync = rename; }
    assert.equal(fs.readdirSync(path.join(uopt.directory, 'pending-update')).length, 1);
    uremove(stats, doomed);
    assert.equal(fs.readdirSync(path.join(uopt.directory, 'pending-update')).length, 0);
    stats = fresh(); assert.equal(ups(stats).updated.count, 8);
    // update_history_survives_delete：删除后合计不减，已删除的行文件名隐藏
    let gone = umeta({ size: 70 }); uwrite(stats, gone); gone = withVersion(gone, 2, 7); uwrite(stats, gone); gone = withVersion(gone, 3, 7); uwrite(stats, gone);
    const beforeDelete = ups(stats); uremove(stats, gone); const afterDelete = ups(stats);
    assert.equal(afterDelete.count, beforeDelete.count); assert.equal(afterDelete.updated.count, beforeDelete.updated.count);
    const goneRows = stats.day({ date: stats.summary().today, pageSize: '100' }).items.filter(r => r.id === gone.id);
    assert.deepEqual(goneRows.map(r => r.uploadKind + r.version).sort(), ['create1', 'update2', 'update3']); assert.ok(goneRows.every(r => r.filename === null && r.retained === false));
    // delete_fails_when_update_finalize_fails：补齐写失败时删除中止
    let stuck = umeta({ size: 50 }); uwrite(stats, stuck); stuck = withVersion(stuck, 2, 5);
    fs.renameSync = (from, to) => { if (String(from).includes('pending-update') && String(from).endsWith('.json')) { const e = new Error('injected'); e.code = 'EIO'; throw e; } return rename(from, to); };
    try { uwrite(stats, stuck); } finally { fs.renameSync = rename; }
    const openSync = fs.openSync;
    fs.openSync = (file, ...args) => { if (String(file).includes(path.join('events', 'updates'))) { const e = new Error('injected update write'); e.code = 'EIO'; throw e; } return openSync(file, ...args); };
    try { assert.throws(() => stats.prepareDelete(stuck, 'admin'), /injected update write/); } finally { fs.openSync = openSync; }
    assert.ok(fs.existsSync(path.join(uopt.metaDir, stuck.id + '.json')));
    assert.equal(fs.readdirSync(path.join(uopt.directory, 'pending-delete')).length, 0, 'no deletion intent was written');

    // T2：类型、来源、项目、筛选、接口旧字段
    let img = umeta({ type: 'image', source: 'bob', project: 'proj-b', size: 300 }); uwrite(stats, img);
    const s = stats.summary();
    const html = s.types.find(t => t.type === 'html'), image = s.types.find(t => t.type === 'image');
    assert.equal(html.count, html.created.count + html.updated.count); assert.ok(html.updated.count > 0); assert.equal(image.updated.count, 0); assert.equal(image.created.count, 1); // aggregate_split_types_projects_sources
    assert.equal(s.sources.find(r => r.source === 'bob').updated.count, 0); assert.ok(s.sources.find(r => r.source === 'alice').updated.count > 0);
    assert.ok(s.projects.find(r => r.project === 'proj-a').updated.count > 0); assert.equal(s.projects.find(r => r.project === 'proj-b').updated.count, 0);
    assert.equal(stats.summary({ source: 'bob' }).summary.uploads.updated.count, 0); // filters_apply_to_updates
    assert.equal(stats.summary({ type: 'image' }).summary.uploads.updated.count, 0);
    const projAUpdates = stats.summary({ project: 'proj-a' }).summary.uploads.updated.count;
    let moved = umeta({ project: 'proj-a', size: 10 }); uwrite(stats, moved); moved = withVersion(moved, 2, 3); uwrite(stats, moved);
    assert.equal(stats.summary({ project: 'proj-a' }).summary.uploads.updated.count, projAUpdates + 1);
    uwrite(stats, { ...moved, project: 'proj-c' });
    assert.equal(stats.summary({ project: 'proj-a' }).summary.uploads.updated.count, projAUpdates, 'updates follow the current project');
    assert.equal(stats.summary({ project: 'proj-c' }).summary.uploads.updated.count, 1);
    const api = stats.summary(); // api_keeps_old_fields
    for (const key of ['count', 'bytes', 'backfilledCount']) assert.ok(key in api.summary.uploads && key in api.summary.today && key in api.daily[0]);
    assert.equal(api.summary.uploads.count, api.summary.uploads.created.count + api.summary.uploads.updated.count);
    assert.ok(api.activities.some(a => a.kind === 'upload') && api.activities.every(a => a.kind === 'delete' ? a.uploadKind === undefined : a.kind === 'upload' && ['create', 'update'].includes(a.uploadKind) && !a.backfilled));
    assert.ok(api.activities.some(a => a.uploadKind === 'update' && a.version >= 2));
    assert.ok(api.deletionActivities.every(a => a.kind === 'delete'));
    const future = api.calendar.days.find(d => d.future); if (future) { assert.equal(future.created, null); assert.equal(future.updated, null); }
    const dayAll = stats.day({ date: api.today, pageSize: '100' }); // day_lists_updates
    assert.equal(dayAll.count, dayAll.created.count + dayAll.updated.count); assert.ok(dayAll.items.some(r => r.uploadKind === 'update' && r.version === 2));
    assert.deepEqual(dayAll.items.map(r => r.at + r.id + String(r.version).padStart(6, '0')), [...dayAll.items].map(r => r.at + r.id + String(r.version).padStart(6, '0')).sort().reverse(), 'items sorted by time, id, version desc');

    // corrupt_update_journal_throws / state_missing_with_updates_throws / 隐私
    for (const directory of ['updates', 'pending-update']) for (const file of fs.readdirSync(path.join(uopt.directory, directory))) {
      const full = path.join(uopt.directory, directory, file); assert.equal(fs.statSync(full).mode & 0o777, 0o600);
      const text = fs.readFileSync(full, 'utf8'); assert.ok(!text.includes('PRIVATE') && !text.includes('filename') && !text.includes('access') && !text.includes('ROTATED'));
    }
    assert.equal(fs.statSync(path.join(uopt.directory, 'updates')).mode & 0o777, 0o700);
    const someUpdate = fs.readdirSync(path.join(uopt.directory, 'updates'))[0];
    const original = fs.readFileSync(path.join(uopt.directory, 'updates', someUpdate));
    fs.writeFileSync(path.join(uopt.directory, 'updates', someUpdate), '{}'); assert.throws(() => createStatistics(uopt).initialize(), /Invalid statistics journal/);
    fs.writeFileSync(path.join(uopt.directory, 'updates', someUpdate), original);
    for (const dir of ['uploads', 'deletions']) fs.rmSync(path.join(uopt.directory, dir), { recursive: true }); fs.rmSync(path.join(uopt.directory, 'state.json'));
    assert.throws(() => createStatistics(uopt).initialize(), /Statistics state is missing/);
  }
  console.log('statistics unit: backfill, midnight/DST, immutable uploads, delete reasons/privacy, filters/pagination, zero days, range validation, restart and interrupted operations, update events/backfill/recovery and create-vs-update aggregation passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }

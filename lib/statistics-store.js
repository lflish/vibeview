const fs = require('node:fs');
const path = require('node:path');
const { isValidId } = require('./preview-store');
const classification = require('./classification');
const TYPES = ['html', 'image', 'video', 'site'];
const DAY = 86400000;

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && value >= '1970-01-01' && Number.isFinite(Date.parse(value + 'T12:00:00Z'))
    && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
}
function addDays(value, count) {
  return new Date(Date.parse(value + 'T12:00:00Z') + count * DAY).toISOString().slice(0, 10);
}
function badRequest(message) { const error = new Error(message); error.status = 400; return error; }
function createStatistics({ directory, timezone = 'Asia/Shanghai', metaDir, dirForType, now = Date.now, logger = console }) {
  const formatter = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dateOf = value => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(value)).map(p => [p.type, p.value]));
    return parts.year.padStart(4, '0') + '-' + parts.month + '-' + parts.day;
  };
  const files = { uploads: 'uploads', deletions: 'deletions', uploadIntent: 'pending-upload', deleteIntent: 'pending-delete' };
  const uploads = new Map(), deletions = new Map(), inventory = new Map();
  const eventDates = new WeakMap();
  function eventDay(event) {
    if (!eventDates.has(event)) eventDates.set(event, dateOf(event.at));
    return eventDates.get(event);
  }
  let initialized = false, state;
  const skipped = new Set();
  const filename = (kind, id) => path.join(directory, files[kind], id + '.json');
  function atomic(file, value) {
    const temporary = file + '.' + process.pid + '.tmp';
    let fd;
    try {
      fd = fs.openSync(temporary, 'w', 0o600);
      fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, file);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(temporary, { force: true });
    }
  }
  function validEvent(event, kind, id) {
    return event && event.id === id && isValidId(id) && TYPES.includes(event.type)
      && typeof event.source === 'string' && Number.isSafeInteger(event.bytes) && event.bytes >= 0
      && typeof event.at === 'string' && Number.isFinite(Date.parse(event.at))
      && (kind === 'upload' ? typeof event.backfilled === 'boolean' : ['admin', 'owner', 'retention'].includes(event.reason));
  }
  function read(kind, eventKind) {
    const result = [];
    for (const file of fs.readdirSync(path.join(directory, files[kind]))) {
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -5), event = JSON.parse(fs.readFileSync(filename(kind, id), 'utf8'));
      if (!validEvent(event, eventKind, id)) throw new Error('Invalid statistics journal: ' + kind + '/' + file);
      result.push(event);
    }
    return result;
  }
  function fromMeta(meta, at = meta.createdAt) {
    const event = { id: meta.id, type: meta.type, source: String(meta.source || 'unknown'), bytes: Number(meta.size) || 0, at };
    // 项目为自报标签，仅用于分组；旧事件没有该字段时按当前元数据或「未设置」处理。
    const project = classification.normalize(meta).project;
    if (project) event.project = project;
    if (Number.isFinite(Date.parse(at))) event.at = new Date(at).toISOString();
    if (!validEvent({ ...event, backfilled: false }, 'upload', event.id)) throw new Error('Invalid statistics resource metadata');
    return event;
  }
  function observe(meta) {
    if (!isValidId(meta.id) || !TYPES.includes(meta.type)) return;
    inventory.set(meta.id, { id: meta.id, type: meta.type, source: String(meta.source || 'unknown'), bytes: Number(meta.size) || 0, filename: String(meta.filename || ''), createdAt: meta.createdAt, project: classification.normalize(meta).project });
  }
  function finalize(event, kind) {
    // An intent is already durable. After the filesystem commit, a rename failure
    // must not misreport a successful upload; replay the intent on next startup.
    try { fs.renameSync(filename(kind === 'upload' ? 'uploadIntent' : 'deleteIntent', event.id), filename(kind === 'upload' ? 'uploads' : 'deletions', event.id)); }
    catch (error) { logger.warn('[statistics] Committed event retained in pending journal: ' + error.code); }
    (kind === 'upload' ? uploads : deletions).set(event.id, event);
  }
  function seed(meta) {
    if (uploads.has(meta.id)) return;
    let event;
    try { event = { ...fromMeta(meta), backfilled: true }; }
    catch { skipped.add(meta.id); return; }
    atomic(filename('uploads', meta.id), event); uploads.set(meta.id, event);
  }
  function initialize() {
    if (initialized) return;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const name of Object.values(files)) fs.mkdirSync(path.join(directory, name), { recursive: true, mode: 0o700 });
    const stateFile = path.join(directory, 'state.json');
    read('uploads', 'upload').forEach(e => uploads.set(e.id, e));
    read('deletions', 'delete').forEach(e => deletions.set(e.id, e));
    if (fs.existsSync(stateFile)) {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (state.version !== 1 || typeof state.startedAt !== 'string' || !Number.isFinite(Date.parse(state.startedAt))) throw new Error('Invalid statistics state');
    } else {
      if (uploads.size || deletions.size) throw new Error('Statistics state is missing; restore the journal backup');
      state = { version: 1, startedAt: new Date(now()).toISOString() }; atomic(stateFile, state);
    }
    fs.mkdirSync(metaDir, { recursive: true });
    const pendingDeletes = read('deleteIntent', 'delete');
    const deletingIds = new Set(pendingDeletes.map(event => event.id));
    for (const event of read('uploadIntent', 'upload')) {
      const metaPath = path.join(metaDir, event.id + '.json');
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (meta.id !== event.id || meta.type !== event.type) throw new Error('Statistics upload intent conflicts with metadata');
        finalize(event, 'upload');
      } else if (deletions.has(event.id) || deletingIds.has(event.id)) {
        // A later deletion proves that the metadata commit happened, even when
        // the upload event's move failed and the file is already gone.
        finalize(event, 'upload');
      } else {
        // This upload never reached its metadata commit point.
        fs.rmSync(path.join(dirForType(event.type), event.id), { recursive: true, force: true });
        fs.rmSync(filename('uploadIntent', event.id), { force: true });
      }
    }
    for (const event of pendingDeletes) {
      const metaPath = path.join(metaDir, event.id + '.json');
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (meta.id !== event.id || meta.type !== event.type) throw new Error('Statistics delete intent conflicts with metadata');
        seed(meta);
      }
      fs.rmSync(path.join(dirForType(event.type), event.id), { recursive: true, force: true });
      fs.rmSync(metaPath, { force: true }); finalize(event, 'delete');
    }
    for (const file of fs.readdirSync(metaDir)) {
      if (!file.endsWith('.json')) continue;
      const text = fs.readFileSync(path.join(metaDir, file), 'utf8');
      let meta;
      try { meta = JSON.parse(text); } catch { skipped.add(file); continue; }
      if (!meta || typeof meta !== 'object' || !isValidId(meta.id) || !TYPES.includes(meta.type)) { skipped.add(file); continue; }
      // Metadata for the same ID cannot be reused after deletion.
      if (deletions.has(meta.id)) throw new Error('Deleted statistics ID reappeared in metadata');
      observe(meta); seed(meta);
    }
    initialized = true;
  }
  function prepareUpload(meta) {
    initialize();
    if (deletions.has(meta.id)) throw new Error('Cannot reuse a deleted resource ID');
    if (uploads.has(meta.id)) return null;
    // Updating a legacy resource with an unknown creation time is not an upload.
    if (fs.existsSync(path.join(metaDir, meta.id + '.json'))) { seed(meta); return null; }
    const event = { ...fromMeta(meta), backfilled: false };
    atomic(filename('uploadIntent', meta.id), event); return event;
  }
  function cancelUpload(event) { if (event) fs.rmSync(filename('uploadIntent', event.id), { force: true }); }
  function commitUpload(meta, event) { if (event) finalize(event, 'upload'); observe(meta); }
  function prepareDelete(meta, reason = 'admin') {
    initialize(); seed(meta);
    const event = { ...fromMeta(meta, new Date(now()).toISOString()), reason };
    if (!validEvent(event, 'delete', event.id)) throw new Error('Invalid statistics deletion reason');
    atomic(filename('deleteIntent', meta.id), event); return event;
  }
  function commitDelete(event) { finalize(event, 'delete'); inventory.delete(event.id); }
  // 仍保留的资源按当前项目归类，已删除的按上传时记录的项目。
  const projectOf = e => inventory.has(e.id) ? inventory.get(e.id).project || '' : e.project || '';
  function filter(query = {}) {
    const source = query.source === undefined ? '' : query.source;
    const type = query.type === undefined ? '' : query.type;
    const rawProject = query.project === undefined ? '' : query.project;
    if (typeof source !== 'string' || source.length > 1024 || typeof type !== 'string' || (type && !TYPES.includes(type))
      || typeof rawProject !== 'string' || rawProject.length > 1024) throw badRequest('Invalid source, type or project');
    // '-' 表示未设置项目
    const project = rawProject === '-' ? '-' : classification.normalizeLabel(rawProject);
    const wanted = project === '-' ? '' : project;
    return { source, type, project, matches: e => (!source || e.source === source) && (!type || e.type === type) && (!project || projectOf(e) === wanted) };
  }
  function context(query) {
    initialize();
    const asOf = new Date(now()).toISOString(), today = dateOf(asOf), f = filter(query);
    return { ...f, asOf, today, events: [...uploads.values()].filter(e => f.matches(e) && e.at <= asOf), current: [...inventory.values()].filter(f.matches) };
  }
  function pagination(query) {
    function integer(value, fallback, max) {
      if (value === undefined) return fallback;
      if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max) throw badRequest('Invalid pagination');
      return Number(value);
    }
    return { page: integer(query.page, 1, 1000000), pageSize: integer(query.pageSize, 20, 100) };
  }
  const aggregate = rows => ({ count: rows.length, bytes: rows.reduce((n, e) => n + e.bytes, 0), backfilledCount: rows.filter(e => e.backfilled).length });
  const details = event => ({ id: event.id, type: event.type, source: event.source, bytes: event.bytes, at: event.at, backfilled: event.backfilled, reason: event.reason, retained: inventory.has(event.id), filename: inventory.get(event.id)?.filename || null });
  function day(query = {}) {
    const c = context(query), selected = query.date === undefined ? c.today : query.date;
    if (!validDate(selected) || selected > c.today) throw badRequest('Invalid or future date');
    const rows = c.events.filter(e => eventDay(e) === selected).sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
    const p = pagination(query), totalPages = Math.max(1, Math.ceil(rows.length / p.pageSize)), page = Math.min(p.page, totalPages);
    return { timezone, asOf: c.asOf, date: selected, ...aggregate(rows), retainedCount: rows.filter(e => inventory.has(e.id)).length,
      items: rows.slice((page - 1) * p.pageSize, page * p.pageSize).map(details), total: rows.length, page, pageSize: p.pageSize, totalPages };
  }
  function summary(query = {}) {
    const c = context(query);
    const range = query.range === undefined ? '30' : query.range;
    if (!['7', '30', 'month'].includes(range)) throw badRequest('Invalid range');
    const from = query.from === undefined ? (range === 'month' ? c.today.slice(0, 8) + '01' : addDays(c.today, -Number(range) + 1)) : query.from;
    const to = query.to === undefined ? c.today : query.to;
    if (!validDate(from) || !validDate(to) || from > to || to > c.today || Date.parse(to) - Date.parse(from) > 365 * DAY) throw badRequest('Invalid date range (maximum 366 days, no future dates)');
    const month = query.month === undefined ? c.today.slice(0, 7) : query.month;
    if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month) || !validDate(month + '-01') || month > c.today.slice(0, 7)) throw badRequest('Invalid or future month');
    const days = new Map();
    for (const event of c.events) { const date = eventDay(event); if (!days.has(date)) days.set(date, []); days.get(date).push(event); }
    const rows = c.events.filter(e => { const d = eventDay(e); return d >= from && d <= to; });
    const deleted = [...deletions.values()].filter(e => c.matches(e) && e.at <= c.asOf && eventDay(e) >= from && eventDay(e) <= to);
    const daily = []; for (let d = from; d <= to; d = addDays(d, 1)) daily.push({ date: d, ...aggregate(days.get(d) || []) });
    const calendar = []; for (let d = month + '-01'; d.startsWith(month); d = addDays(d, 1)) calendar.push({ date: d, future: d > c.today, ...(d > c.today ? { count: null, bytes: null, backfilledCount: 0 } : aggregate(days.get(d) || [])) });
    const completeFromDate = addDays(dateOf(state.startedAt), 1);
    const sourceNames = [...new Set([...uploads.values(), ...deletions.values(), ...inventory.values()].map(e => e.source))].sort((a, b) => a.localeCompare(b));
    const activities = [...rows.map(e => ({ ...e, kind: 'upload' })), ...deleted.map(e => ({ ...e, kind: 'delete' }))]
      .filter(e => !e.backfilled).sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)).slice(0, 8).map(e => ({ ...details(e), kind: e.kind }));
    const projectNames = [...new Set([...uploads.values(), ...inventory.values()].map(projectOf))].sort((a, b) => a.localeCompare(b));
    return { timezone, asOf: c.asOf, today: c.today, filters: { from, to, month, source: c.source, type: c.type, project: c.project },
      coverage: { startedAt: state.startedAt, completeFromDate, backfilledUploads: [...uploads.values()].filter(e => e.backfilled).length, skippedMetadata: skipped.size, earliestUploadDate: [...uploads.values()].reduce((min, e) => { const d = eventDay(e); return min === null || d < min ? d : min; }, null), periodComplete: from >= completeFromDate && !rows.some(e => e.backfilled) },
      summary: { today: { ...aggregate(days.get(c.today) || []), yesterdayCount: (days.get(addDays(c.today, -1)) || []).length }, uploads: aggregate(rows), current: aggregate(c.current),
        deletions: { count: deleted.length, bytes: deleted.reduce((n, e) => n + e.bytes, 0), admin: deleted.filter(e => e.reason === 'admin').length, owner: deleted.filter(e => e.reason === 'owner').length, retention: deleted.filter(e => e.reason === 'retention').length } },
      daily, calendar: { month, days: calendar }, deletionActivities: deleted.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)).slice(0, 8).map(e => ({ ...details(e), kind: 'delete' })), types: TYPES.map(type => ({ type, ...aggregate(rows.filter(e => e.type === type)) })),
      sources: sourceNames.map(source => ({ source, ...aggregate(rows.filter(e => e.source === source)) })).sort((a, b) => b.count - a.count || a.source.localeCompare(b.source)), availableSources: sourceNames, activities,
      projects: projectNames.map(project => ({ project, ...aggregate(rows.filter(e => projectOf(e) === project)), current: c.current.filter(e => projectOf(e) === project).length })).filter(row => row.count || row.current).sort((a, b) => b.count - a.count || b.current - a.current || a.project.localeCompare(b.project)),
      availableProjects: projectNames };
  }
  return { initialize, prepareUpload, cancelUpload, commitUpload, prepareDelete, commitDelete, summary, day, dateOf };
}
module.exports = { createStatistics, validDate, addDays };

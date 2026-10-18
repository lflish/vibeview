// 预览访问统计：只保存「资源 × 天」的计数，不保存 IP、UA 或单条访问记录。
// 计数先在内存中累加，定时批量写入独立的 SQLite 文件（与上传统计日志同目录，随备份保留）。
const fs = require('node:fs');
const path = require('node:path');

let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { DatabaseSync = null; }

const KINDS = ['views', 'admin_views', 'bots', 'challenges', 'unlock_ok', 'unlock_fail', 'rate_limited', 'expired_hits'];
const DAY = 86400000;
// 链接预览爬虫与脚本客户端单独计数，不算作访客打开。保持保守，避免误伤飞书/微信内置浏览器。
const BOT_UA = /bot\b|bot\/|crawler|spider|slurp|facebookexternalhit|embedly|Slack-ImgProxy|SkypeUriPreview|WhatsApp\/|curl\/|wget\/|python-requests|python-urllib|Go-http-client|node-fetch|axios\/|HeadlessChrome/i;

function isBot(userAgent) {
  return !userAgent || BOT_UA.test(String(userAgent));
}

function addDays(value, count) {
  return new Date(Date.parse(value + 'T12:00:00Z') + count * DAY).toISOString().slice(0, 10);
}
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T12:00:00Z'))
    && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
}
function badRequest(message) { const error = new Error(message); error.status = 400; return error; }

function createVisits({ file, dateOf, now = Date.now, flushMs = 30000, retentionDays = 400, logger = console }) {
  let db = null;
  let unavailable = !DatabaseSync;
  let timer = null;
  // key `${id}\n${date}` → 计数；totals: id → { views, first, last }；dims: id → 维度快照
  const pendingDaily = new Map();
  const pendingTotals = new Map();
  const pendingDims = new Map();

  function open() {
    if (db || unavailable) return db;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      db = new DatabaseSync(file);
      db.exec(`
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS visits_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS preview_daily (
          id TEXT NOT NULL, date TEXT NOT NULL,
          ${KINDS.map((kind) => `${kind} INTEGER NOT NULL DEFAULT 0`).join(',\n          ')},
          PRIMARY KEY (id, date)
        );
        CREATE INDEX IF NOT EXISTS preview_daily_date_idx ON preview_daily(date);
        CREATE TABLE IF NOT EXISTS preview_totals (
          id TEXT PRIMARY KEY,
          views INTEGER NOT NULL DEFAULT 0,
          first_viewed_at TEXT,
          last_viewed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS preview_resources (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT '',
          project TEXT NOT NULL DEFAULT '',
          category TEXT NOT NULL DEFAULT '',
          filename TEXT NOT NULL DEFAULT ''
        );
      `);
      db.prepare('INSERT OR IGNORE INTO visits_meta (key, value) VALUES (?, ?)').run('startedAt', new Date(now()).toISOString());
      prune();
      return db;
    } catch (error) {
      logger.warn(`[visits] SQLite unavailable, access statistics disabled: ${error.message}`);
      unavailable = true;
      db = null;
      return null;
    }
  }

  function prune() {
    if (!db || !retentionDays) return;
    const cutoff = addDays(dateOf(now()), -retentionDays);
    db.prepare('DELETE FROM preview_daily WHERE date < ?').run(cutoff);
  }

  function dims(meta) {
    return {
      type: String(meta.type || ''),
      source: String(meta.source || ''),
      project: String(meta.project || ''),
      category: String(meta.category || ''),
      filename: String(meta.filename || ''),
    };
  }

  // kind ∈ KINDS；meta 为当前资源元数据。只做内存累加，开销可忽略。
  function record(meta, kind) {
    if (unavailable || !meta || !meta.id || !KINDS.includes(kind)) return;
    const at = new Date(now()).toISOString();
    const key = meta.id + '\n' + dateOf(at);
    let row = pendingDaily.get(key);
    if (!row) { row = Object.fromEntries(KINDS.map((k) => [k, 0])); pendingDaily.set(key, row); }
    row[kind]++;
    pendingDims.set(meta.id, dims(meta));
    if (kind === 'views') {
      const total = pendingTotals.get(meta.id) || { views: 0, first: at, last: at };
      total.views++;
      total.last = at;
      pendingTotals.set(meta.id, total);
    }
  }

  function flush() {
    if (!pendingDaily.size && !pendingTotals.size && !pendingDims.size) return true;
    const connection = open();
    if (!connection) return false;
    const daily = [...pendingDaily];
    const totals = [...pendingTotals];
    const dimRows = [...pendingDims];
    pendingDaily.clear(); pendingTotals.clear(); pendingDims.clear();
    try {
      connection.exec('BEGIN');
      const upsertDaily = connection.prepare(`
        INSERT INTO preview_daily (id, date, ${KINDS.join(', ')}) VALUES (?, ?, ${KINDS.map(() => '?').join(', ')})
        ON CONFLICT(id, date) DO UPDATE SET ${KINDS.map((k) => `${k} = ${k} + excluded.${k}`).join(', ')}
      `);
      for (const [key, row] of daily) {
        const [id, date] = key.split('\n');
        upsertDaily.run(id, date, ...KINDS.map((k) => row[k]));
      }
      const upsertTotal = connection.prepare(`
        INSERT INTO preview_totals (id, views, first_viewed_at, last_viewed_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET views = views + excluded.views,
          first_viewed_at = COALESCE(first_viewed_at, excluded.first_viewed_at),
          last_viewed_at = MAX(COALESCE(last_viewed_at, ''), excluded.last_viewed_at)
      `);
      for (const [id, total] of totals) upsertTotal.run(id, total.views, total.first, total.last);
      const upsertDims = connection.prepare(`
        INSERT INTO preview_resources (id, type, source, project, category, filename) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET type = excluded.type, source = excluded.source, project = excluded.project,
          category = excluded.category, filename = excluded.filename
      `);
      for (const [id, d] of dimRows) upsertDims.run(id, d.type, d.source, d.project, d.category, d.filename);
      connection.exec('COMMIT');
      return true;
    } catch (error) {
      try { connection.exec('ROLLBACK'); } catch { /* ignore */ }
      // 写入失败时把计数放回内存，下次再试，避免静默丢数。
      for (const [key, row] of daily) {
        const current = pendingDaily.get(key);
        if (!current) pendingDaily.set(key, row);
        else for (const k of KINDS) current[k] += row[k];
      }
      for (const [id, total] of totals) {
        const current = pendingTotals.get(id);
        if (!current) pendingTotals.set(id, total);
        else { current.views += total.views; current.first = total.first < current.first ? total.first : current.first; }
      }
      for (const [id, d] of dimRows) if (!pendingDims.has(id)) pendingDims.set(id, d);
      logger.warn(`[visits] flush failed, will retry: ${error.message}`);
      return false;
    }
  }

  // 资源标签被修改后同步维度快照，让按项目 / 分类统计跟随当前标签。
  function syncResource(meta) {
    if (!meta || !meta.id) return;
    const connection = open();
    if (!connection) return;
    try {
      const d = dims(meta);
      connection.prepare('UPDATE preview_resources SET type = ?, source = ?, project = ?, category = ?, filename = ? WHERE id = ?')
        .run(d.type, d.source, d.project, d.category, d.filename, meta.id);
      if (pendingDims.has(meta.id)) pendingDims.set(meta.id, d);
    } catch (error) {
      logger.warn(`[visits] sync failed: ${error.message}`);
    }
  }

  function start() {
    if (!open() || timer) return;
    timer = setInterval(() => { flush(); }, flushMs);
    timer.unref();
    // 每天清理一次过期的按天明细
    const pruneTimer = setInterval(() => { try { prune(); } catch { /* ignore */ } }, DAY);
    pruneTimer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    flush();
    if (db) { try { db.close(); } catch { /* ignore */ } db = null; unavailable = true; }
  }

  // 资源 id → { views, firstViewedAt, lastViewedAt }；读取前先落盘，保证列表与筛选一致。
  function totalsFor(ids) {
    const result = new Map();
    if (!ids.length) return result;
    flush();
    const connection = open();
    if (!connection) return result;
    try {
      const statement = connection.prepare('SELECT id, views, first_viewed_at AS firstViewedAt, last_viewed_at AS lastViewedAt FROM preview_totals WHERE id = ?');
      for (const id of ids) {
        const row = statement.get(id);
        if (row) result.set(id, { views: Number(row.views), firstViewedAt: row.firstViewedAt, lastViewedAt: row.lastViewedAt });
      }
    } catch (error) {
      logger.warn(`[visits] totals failed: ${error.message}`);
    }
    return result;
  }

  // 按日期范围汇总；current 为当前仍保留的资源（已按来源 / 类型 / 项目筛选）。
  function summary(query = {}, current = []) {
    const connection = open();
    const today = dateOf(now());
    const from = query.from === undefined ? addDays(today, -29) : query.from;
    const to = query.to === undefined ? today : query.to;
    if (!validDate(from) || !validDate(to) || from > to || to > today || Date.parse(to) - Date.parse(from) > 365 * DAY) {
      throw badRequest('Invalid date range (maximum 366 days, no future dates)');
    }
    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
    const empty = Object.fromEntries(KINDS.map((k) => [k, 0]));
    if (!connection) {
      return { available: false, from, to, totals: { ...empty }, daily: days.map((date) => ({ date, views: 0 })), top: [], projects: [], neverViewed: 0, viewedInRange: 0 };
    }
    flush();
    const where = ['d.date >= ?', 'd.date <= ?'];
    const params = [from, to];
    for (const key of ['source', 'type']) {
      if (query[key]) { where.push(`COALESCE(r.${key}, '') = ?`); params.push(query[key]); }
    }
    if (query.project) { where.push("COALESCE(r.project, '') = ?"); params.push(query.project === '-' ? '' : query.project); }
    const clause = `FROM preview_daily d LEFT JOIN preview_resources r ON r.id = d.id WHERE ${where.join(' AND ')}`;
    const sums = connection.prepare(`SELECT ${KINDS.map((k) => `COALESCE(SUM(d.${k}), 0) AS ${k}`).join(', ')} ${clause}`).get(...params);
    const byDay = new Map(connection.prepare(`SELECT d.date AS date, SUM(d.views) AS views ${clause} GROUP BY d.date`).all(...params)
      .map((row) => [row.date, Number(row.views)]));
    const top = connection.prepare(`
      SELECT d.id AS id, SUM(d.views) AS views, r.type AS type, r.project AS project, r.filename AS filename
      ${clause} GROUP BY d.id HAVING SUM(d.views) > 0 ORDER BY views DESC, d.id LIMIT 8
    `).all(...params);
    const projects = connection.prepare(`
      SELECT COALESCE(r.project, '') AS project, SUM(d.views) AS views
      ${clause} GROUP BY COALESCE(r.project, '') HAVING SUM(d.views) > 0 ORDER BY views DESC, project
    `).all(...params);
    const viewedIds = new Set(connection.prepare(`SELECT DISTINCT d.id AS id ${clause} AND d.views > 0`).all(...params).map((row) => row.id));
    const currentIds = current.map((item) => item.id);
    const lifetime = totalsFor(currentIds);
    const currentById = new Map(current.map((item) => [item.id, item]));
    const since = startedAt();
    return {
      available: true,
      startedAt: since,
      from,
      to,
      totals: Object.fromEntries(KINDS.map((k) => [k, Number(sums[k])])),
      daily: days.map((date) => ({ date, views: byDay.get(date) || 0 })),
      top: top.map((row) => {
        const item = currentById.get(row.id);
        return {
          id: row.id,
          views: Number(row.views),
          type: item ? item.type : row.type,
          project: item ? item.project : row.project || '',
          // 已删除的资源隐藏原文件名，与上传统计保持一致。
          filename: item ? item.filename : null,
          retained: !!item,
          lastViewedAt: lifetime.get(row.id)?.lastViewedAt || null,
        };
      }),
      projects: projects.map((row) => ({ project: row.project, views: Number(row.views) })),
      neverViewed: currentIds.filter((id) => !lifetime.get(id)?.views).length,
      // 统计开始前上传、之后也没被打开的资源：此前是否被打开过无从得知。
      neverViewedBeforeStart: since ? current.filter((item) => !lifetime.get(item.id)?.views && String(item.createdAt || '') < since).length : 0,
      viewedInRange: currentIds.filter((id) => viewedIds.has(id)).length,
    };
  }

  function startedAt() {
    const connection = open();
    if (!connection) return null;
    try { return connection.prepare("SELECT value FROM visits_meta WHERE key = 'startedAt'").get()?.value || null; }
    catch { return null; }
  }

  return { record, flush, start, stop, startedAt, syncResource, totalsFor, summary, isAvailable: () => !!open(), file, KINDS };
}

module.exports = { createVisits, isBot, KINDS };

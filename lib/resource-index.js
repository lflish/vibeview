// SQLite 索引：JSON meta 仍是权威数据，SQLite 只负责管理列表查询和统计。
const path = require('path');
const config = require('./config');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  DatabaseSync = null;
}

let db = null;
let unavailable = false;

function dbPath() {
  return path.join(config.storage.metaDir, '..', 'resources.sqlite');
}

function open() {
  if (db || unavailable || !DatabaseSync) return db;
  try {
    db = new DatabaseSync(dbPath());
    db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS resources (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        filename TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        mime TEXT NOT NULL DEFAULT '',
        size INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS resources_created_idx ON resources(created_at DESC, id);
      CREATE INDEX IF NOT EXISTS resources_source_idx ON resources(source);
      CREATE INDEX IF NOT EXISTS resources_type_idx ON resources(type);
    `);
    return db;
  } catch (error) {
    console.warn(`[resource-index] SQLite unavailable, using JSON scan: ${error.message}`);
    unavailable = true;
    db = null;
    return null;
  }
}

function normalize(meta) {
  return {
    id: String(meta.id),
    type: String(meta.type || ''),
    filename: String(meta.filename || ''),
    description: String(meta.description || ''),
    mime: String(meta.mime || ''),
    size: Number(meta.size) || 0,
    source: String(meta.source || ''),
    created_at: String(meta.createdAt || new Date(0).toISOString()),
  };
}

function upsert(meta) {
  const connection = open();
  if (!connection || !meta || !meta.id) return false;
  try {
    connection.prepare(`
      INSERT INTO resources (id, type, filename, description, mime, size, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        type=excluded.type, filename=excluded.filename, description=excluded.description,
        mime=excluded.mime, size=excluded.size, source=excluded.source, created_at=excluded.created_at
    `).run(...Object.values(normalize(meta)));
    return true;
  } catch (error) {
    console.warn(`[resource-index] upsert failed: ${error.message}`);
    return false;
  }
}

function remove(id) {
  const connection = open();
  if (!connection) return false;
  try {
    connection.prepare('DELETE FROM resources WHERE id = ?').run(id);
    return true;
  } catch (error) {
    console.warn(`[resource-index] remove failed: ${error.message}`);
    return false;
  }
}

function rebuild(metas) {
  const connection = open();
  if (!connection) return false;
  try {
    const insert = connection.prepare(`
      INSERT INTO resources (id, type, filename, description, mime, size, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        type=excluded.type, filename=excluded.filename, description=excluded.description,
        mime=excluded.mime, size=excluded.size, source=excluded.source, created_at=excluded.created_at
    `);
    connection.exec('BEGIN');
    connection.exec('DELETE FROM resources');
    for (const meta of metas || []) insert.run(...Object.values(normalize(meta)));
    connection.exec('COMMIT');
    return true;
  } catch (error) {
    try { connection.exec('ROLLBACK'); } catch { /* ignore rollback errors */ }
    console.warn(`[resource-index] rebuild failed: ${error.message}`);
    return false;
  }
}

const SORT_COLUMNS = {
  time: 'created_at',
  name: 'filename',
  size: 'size',
  type: 'type',
  source: 'source',
};

function listPage({ page = 1, pageSize = 20, q = '', type = '', source = '', sort = 'time', order = 'desc' } = {}) {
  const connection = open();
  if (!connection) return null;
  try {
    const where = [];
    const params = [];
    if (q) {
      where.push("(filename LIKE ? ESCAPE '!' OR description LIKE ? ESCAPE '!' OR source LIKE ? ESCAPE '!' OR id LIKE ? ESCAPE '!' OR type LIKE ? ESCAPE '!')");
      const term = `%${String(q).replace(/[!%_]/g, '!$&')}%`;
      params.push(term, term, term, term, term);
    }
    if (type) {
      where.push('type = ?');
      params.push(type);
    }
    if (source) {
      where.push('source = ?');
      params.push(source);
    }
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const total = connection.prepare(`SELECT COUNT(*) AS count FROM resources${clause}`).get(...params).count;
    const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 20));
    const totalPages = Math.max(1, Math.ceil(total / safePageSize));
    const safePage = Math.min(Math.max(1, Number(page) || 1), totalPages);
    const column = SORT_COLUMNS[sort] || SORT_COLUMNS.time;
    const direction = order === 'asc' ? 'ASC' : 'DESC';
    const rows = connection.prepare(`
      SELECT id, type, filename, description, mime, size, source, created_at AS createdAt
      FROM resources${clause}
      ORDER BY ${column} ${direction}, id ${direction}
      LIMIT ? OFFSET ?
    `).all(...params, safePageSize, (safePage - 1) * safePageSize);
    return {
      items: rows,
      total: Number(total),
      page: safePage,
      pageSize: safePageSize,
      totalPages,
    };
  } catch (error) {
    console.warn(`[resource-index] list failed, using JSON scan: ${error.message}`);
    return null;
  }
}

function sources() {
  const connection = open();
  if (!connection) return null;
  try {
    return connection.prepare("SELECT DISTINCT source FROM resources WHERE source <> '' ORDER BY source COLLATE NOCASE").all()
      .map((row) => row.source);
  } catch (error) {
    console.warn(`[resource-index] source list failed: ${error.message}`);
    return null;
  }
}

function usageBySource() {
  const connection = open();
  if (!connection) return null;
  try {
    const rows = connection.prepare(`
      SELECT source, COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes
      FROM resources GROUP BY source
    `).all();
    return new Map(rows.map((row) => [row.source || 'unknown', {
      source: row.source || 'unknown', count: Number(row.count), bytes: Number(row.bytes),
    }]));
  } catch (error) {
    console.warn(`[resource-index] usage failed: ${error.message}`);
    return null;
  }
}

function isAvailable() {
  return !!open();
}

module.exports = { dbPath, isAvailable, listPage, rebuild, remove, sources, upsert, usageBySource };

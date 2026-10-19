// SQLite 索引：JSON meta 仍是权威数据，SQLite 只负责管理列表查询和统计。
const path = require('path');
const config = require('./config');
const classification = require('./classification');

const CLASS_COLUMNS = ['category', 'agent', 'model', 'project', 'tags'];
const COLUMNS = ['id', 'type', 'filename', 'description', 'mime', 'size', 'source', 'created_at', ...CLASS_COLUMNS];
const UPSERT_SQL = `
  INSERT INTO resources (${COLUMNS.join(', ')})
  VALUES (${COLUMNS.map(() => '?').join(', ')})
  ON CONFLICT(id) DO UPDATE SET
    ${COLUMNS.filter((column) => column !== 'id').map((column) => `${column}=excluded.${column}`).join(', ')}
`;

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  DatabaseSync = null;
}

let db = null;
let unavailable = false;
let visitsFile = null;
let visitsAttached = false;
const DAY = 86400000;

// 访问统计库独立保存；挂到索引连接上，列表才能按打开次数筛选和排序。
function attachVisits(file) {
  visitsFile = file;
  const connection = open();
  if (connection) tryAttach(connection);
}

function tryAttach(connection) {
  if (visitsAttached || !visitsFile) return;
  try {
    connection.prepare('ATTACH DATABASE ? AS visits').run(visitsFile);
    connection.prepare('SELECT 1 FROM visits.preview_totals LIMIT 1').get();
    visitsAttached = true;
  } catch (error) {
    console.warn(`[resource-index] visits database not attached: ${error.message}`);
  }
}

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
      CREATE TABLE IF NOT EXISTS resource_tags (
        id TEXT NOT NULL,
        tag TEXT NOT NULL,
        PRIMARY KEY (id, tag)
      );
      CREATE INDEX IF NOT EXISTS resource_tags_tag_idx ON resource_tags(tag);
    `);
    // 旧库缺少分类列时就地补齐；数据会在启动 rebuild 时从 JSON 重新填充。
    const existing = new Set(db.prepare('PRAGMA table_info(resources)').all().map((column) => column.name));
    for (const column of CLASS_COLUMNS) {
      if (!existing.has(column)) db.exec(`ALTER TABLE resources ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS resources_created_idx ON resources(created_at DESC, id);
      CREATE INDEX IF NOT EXISTS resources_source_idx ON resources(source);
      CREATE INDEX IF NOT EXISTS resources_type_idx ON resources(type);
      CREATE INDEX IF NOT EXISTS resources_category_idx ON resources(category);
      CREATE INDEX IF NOT EXISTS resources_agent_idx ON resources(agent);
      CREATE INDEX IF NOT EXISTS resources_project_idx ON resources(project);
    `);
    tryAttach(db);
    return db;
  } catch (error) {
    console.warn(`[resource-index] SQLite unavailable, using JSON scan: ${error.message}`);
    unavailable = true;
    db = null;
    return null;
  }
}

function normalize(meta) {
  const labels = classification.normalize(meta);
  return {
    id: String(meta.id),
    type: String(meta.type || ''),
    filename: String((meta.type === 'site' && meta.archiveName) || meta.filename || ''),
    description: String(meta.description || ''),
    mime: String(meta.mime || ''),
    size: Number(meta.size) || 0,
    source: String(meta.source || ''),
    created_at: String(meta.createdAt || new Date(0).toISOString()),
    category: labels.category,
    agent: labels.agent,
    model: labels.model,
    project: labels.project,
    tags: JSON.stringify(labels.tags),
  };
}

function writeRow(connection, meta) {
  const row = normalize(meta);
  connection.prepare(UPSERT_SQL).run(...COLUMNS.map((column) => row[column]));
  connection.prepare('DELETE FROM resource_tags WHERE id = ?').run(row.id);
  const insertTag = connection.prepare('INSERT OR IGNORE INTO resource_tags (id, tag) VALUES (?, ?)');
  for (const tag of JSON.parse(row.tags)) insertTag.run(row.id, tag);
}

function parseTags(value) {
  try {
    const tags = JSON.parse(value || '[]');
    return Array.isArray(tags) ? tags : [];
  } catch {
    return [];
  }
}

function upsert(meta) {
  const connection = open();
  if (!connection || !meta || !meta.id) return false;
  try {
    connection.exec('BEGIN');
    writeRow(connection, meta);
    connection.exec('COMMIT');
    return true;
  } catch (error) {
    try { connection.exec('ROLLBACK'); } catch { /* ignore rollback errors */ }
    console.warn(`[resource-index] upsert failed: ${error.message}`);
    return false;
  }
}

function remove(id) {
  const connection = open();
  if (!connection) return false;
  try {
    connection.prepare('DELETE FROM resources WHERE id = ?').run(id);
    connection.prepare('DELETE FROM resource_tags WHERE id = ?').run(id);
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
    connection.exec('BEGIN');
    connection.exec('DELETE FROM resources');
    connection.exec('DELETE FROM resource_tags');
    for (const meta of metas || []) writeRow(connection, meta);
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
  category: 'category',
  project: 'project',
  agent: 'agent',
};

const SEARCH_COLUMNS = ['filename', 'description', 'source', 'id', 'type', 'category', 'agent', 'model', 'project'];

const VISIT_VIEWS = '(SELECT v.views FROM visits.preview_totals v WHERE v.id = resources.id)';
const VISIT_LAST = '(SELECT v.last_viewed_at FROM visits.preview_totals v WHERE v.id = resources.id)';

// category 传 'none' 表示未分类，project 传 '-' 表示未设置项目；其余筛选均为精确匹配。
// visit: never（从未打开）/ stale30（30 天未打开，含从未打开）/ recent7（7 天内打开过）
function filterClause({ q = '', type = '', source = '', category = '', agent = '', project = '', tag = '', visit = '' } = {}) {
  const where = [];
  const params = [];
  if (q) {
    const term = `%${String(q).replace(/[!%_]/g, '!$&')}%`;
    where.push(`(${SEARCH_COLUMNS.map((column) => `${column} LIKE ? ESCAPE '!'`).join(' OR ')}
      OR EXISTS (SELECT 1 FROM resource_tags t WHERE t.id = resources.id AND t.tag LIKE ? ESCAPE '!'))`);
    params.push(...SEARCH_COLUMNS.map(() => term), term);
  }
  for (const [column, value] of [['type', type], ['source', source], ['agent', agent], ['project', project]]) {
    if (value) {
      where.push(`${column} = ?`);
      params.push(column === 'project' && value === '-' ? '' : value);
    }
  }
  if (visit && visitsAttached) {
    if (visit === 'never') where.push(`COALESCE(${VISIT_VIEWS}, 0) = 0`);
    else if (visit === 'stale30') {
      where.push(`COALESCE(${VISIT_LAST}, '') < ?`);
      params.push(new Date(Date.now() - 30 * DAY).toISOString());
    } else if (visit === 'recent7') {
      where.push(`COALESCE(${VISIT_LAST}, '') >= ?`);
      params.push(new Date(Date.now() - 7 * DAY).toISOString());
    }
  }
  if (category) {
    where.push('category = ?');
    params.push(category === 'none' ? '' : category);
  }
  if (tag) {
    where.push('EXISTS (SELECT 1 FROM resource_tags t WHERE t.id = resources.id AND t.tag = ?)');
    params.push(tag);
  }
  return { clause: where.length ? ` WHERE ${where.join(' AND ')}` : '', params };
}

function listPage({ page = 1, pageSize = 20, sort = 'time', order = 'desc', ...filters } = {}) {
  const connection = open();
  if (!connection) return null;
  try {
    const { clause, params } = filterClause(filters);
    const total = connection.prepare(`SELECT COUNT(*) AS count FROM resources${clause}`).get(...params).count;
    const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 20));
    const totalPages = Math.max(1, Math.ceil(total / safePageSize));
    const safePage = Math.min(Math.max(1, Number(page) || 1), totalPages);
    const column = sort === 'views' && visitsAttached ? `COALESCE(${VISIT_VIEWS}, 0)`
      : sort === 'viewed' && visitsAttached ? `COALESCE(${VISIT_LAST}, '')`
        : SORT_COLUMNS[sort] || SORT_COLUMNS.time;
    const direction = order === 'asc' ? 'ASC' : 'DESC';
    const rows = connection.prepare(`
      SELECT id, type, filename, description, mime, size, source, created_at AS createdAt,
        category, agent, model, project, tags
      FROM resources${clause}
      ORDER BY ${column} ${direction}, id ${direction}
      LIMIT ? OFFSET ?
    `).all(...params, safePageSize, (safePage - 1) * safePageSize);
    return {
      items: rows.map((row) => ({ ...row, tags: parseTags(row.tags) })),
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

// 各分类维度的取值与数量（全量，不随当前筛选变化），供管理端下拉框使用。
function facets({ limit = 200 } = {}) {
  const connection = open();
  if (!connection) return null;
  try {
    const group = (column) => connection.prepare(`
      SELECT ${column} AS value, COUNT(*) AS count FROM resources
      GROUP BY ${column} ORDER BY count DESC, value LIMIT ?
    `).all(limit).map((row) => ({ value: row.value, count: Number(row.count) }));
    const tags = connection.prepare(`
      SELECT tag AS value, COUNT(*) AS count FROM resource_tags
      GROUP BY tag ORDER BY count DESC, tag LIMIT ?
    `).all(limit).map((row) => ({ value: row.value, count: Number(row.count) }));
    return { category: group('category'), agent: group('agent'), project: group('project'), tag: tags };
  } catch (error) {
    console.warn(`[resource-index] facets failed: ${error.message}`);
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

function hasVisits() {
  return !!open() && visitsAttached;
}

module.exports = { attachVisits, hasVisits, dbPath, facets, isAvailable, listPage, rebuild, remove, sources, upsert, usageBySource };

// 页面模板：存储、版本、可见范围（自己的 + 全局的）、模板包校验和关键词匹配。
// 布局：<template_dir>/<模板 id>/meta.json 与 <template_dir>/<模板 id>/v<n>/<文件>。
const fs = require('fs');
const path = require('path');
const { customAlphabet } = require('nanoid');
const classification = require('./classification');
const schemaCheck = require('./template-schema');
const { render } = require('./template-render');
const { createLocks } = require('./locks');

const newId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 16);
const ID_RE = /^[0-9A-Za-z]{16}$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const FILE_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const MAX_FILE = 2 * 1024 * 1024;
const MAX_TOTAL = 5 * 1024 * 1024;
const FEATURES = ['print', 'export'];
// 存储上限：每个账户的模板数、每个模板保留的版本数。已生成的页面不依赖模板文件，删旧版本不影响它们。
const MAX_TEMPLATES_PER_ACCOUNT = 100;
const MAX_VERSIONS = 50;

class TemplateError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    if (details) this.details = details;
  }
}

function normalizeText(value) {
  return String(value || '').normalize('NFKC').toLowerCase();
}

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// 检查导出配置；返回规范化后的配置。
function checkExport(value, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { errors.push('features.export 应为对象'); return null; }
  for (const key of Object.keys(value)) if (key !== 'xlsx') errors.push(`features.export: 不支持的格式 ${key}（支持 xlsx）`);
  const spec = value.xlsx;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) { errors.push('features.export.xlsx 应为对象'); return null; }
  const rows = text(spec.rows, 200);
  if (!rows || !/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/.test(rows)) errors.push('features.export.xlsx.rows 应为数据里数组的字段路径，如 items');
  if (!Array.isArray(spec.columns) || !spec.columns.length || spec.columns.length > 50) {
    errors.push('features.export.xlsx.columns 应为 1–50 列的数组');
    return null;
  }
  const fieldPath = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;
  const columns = spec.columns.map((column, i) => {
    const at = `features.export.xlsx.columns[${i}]`;
    if (!column || typeof column !== 'object') { errors.push(`${at} 应为对象`); return {}; }
    const out = { header: text(column.header, 60) };
    const hasField = column.field !== undefined;
    const hasProduct = column.product !== undefined;
    if (hasField === hasProduct) errors.push(`${at} 需要 field 或 product 其中之一`);
    if (hasField) {
      if (typeof column.field !== 'string' || !fieldPath.test(column.field)) errors.push(`${at}.field 应为字段路径`);
      else out.field = column.field;
    }
    if (hasProduct) {
      if (!Array.isArray(column.product) || column.product.length < 2 || column.product.length > 5 || column.product.some((f) => typeof f !== 'string' || !fieldPath.test(f))) {
        errors.push(`${at}.product 应为 2–5 个字段路径`);
      } else out.product = column.product;
    }
    if (!out.header) out.header = out.field || '';
    if (column.total === true) out.total = true;
    for (const key of Object.keys(column)) if (!['header', 'field', 'product', 'total'].includes(key)) errors.push(`${at}: 不支持的字段 ${key}`);
    return out;
  });
  for (const key of Object.keys(spec)) if (!['sheet', 'rows', 'columns'].includes(key)) errors.push(`features.export.xlsx: 不支持的字段 ${key}`);
  return { xlsx: { sheet: text(spec.sheet, 31) || '明细', rows, columns } };
}

/**
 * 校验模板包。files 为 { 文件名: 文本内容 }。
 * 返回 { manifest, files }；不合法时抛 TemplateError(400, ..., details)。
 */
function validatePackage(files, expectedName) {
  const errors = [];
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new TemplateError(400, 'files 应为 { 文件名: 内容 }');
  let total = 0;
  for (const [name, content] of Object.entries(files)) {
    if (!FILE_RE.test(name)) errors.push(`文件名不合法: ${name}`);
    if (typeof content !== 'string') { errors.push(`${name}: 内容应为文本`); continue; }
    const size = Buffer.byteLength(content);
    if (size > MAX_FILE) errors.push(`${name}: 超过 2 MB`);
    total += size;
  }
  if (total > MAX_TOTAL) errors.push('模板包合计超过 5 MB');
  if (errors.length) throw new TemplateError(400, 'invalid template package', errors);
  if (typeof files['template.json'] !== 'string') throw new TemplateError(400, 'invalid template package', ['缺少 template.json']);

  let raw;
  try { raw = JSON.parse(files['template.json']); } catch (error) {
    throw new TemplateError(400, 'invalid template package', [`template.json 不是合法的 JSON: ${error.message}`]);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TemplateError(400, 'invalid template package', ['template.json 应为对象']);

  const known = ['name', 'title', 'description', 'match', 'category', 'tags', 'layout', 'schema', 'example', 'guide', 'pageTitle', 'features'];
  for (const key of Object.keys(raw)) if (!known.includes(key)) errors.push(`template.json: 不支持的字段 ${key}`);
  const name = typeof raw.name === 'string' ? raw.name : '';
  if (!NAME_RE.test(name)) errors.push('name 只能用小写字母、数字和 -，以字母或数字开头，最长 63 个字符');
  if (expectedName && name && name !== expectedName) errors.push(`name 是 ${name}，与发布的名称 ${expectedName} 不一致`);
  const description = text(raw.description, 300);
  if (!description) errors.push('description 必填：说明这个模板用来生成什么页面');

  const seen = new Set();
  const match = [];
  if (!Array.isArray(raw.match)) errors.push('match 应为关键词数组');
  else {
    for (const word of raw.match) {
      const value = typeof word === 'string' ? word.normalize('NFKC').trim() : '';
      if (!value || value.length > 40) { errors.push(`match: 关键词应为 1–40 个字符: ${JSON.stringify(word)}`); continue; }
      if (seen.has(value.toLowerCase())) continue;
      seen.add(value.toLowerCase());
      match.push(value);
    }
    if (!match.length || match.length > 30) errors.push('match 需要 1–30 个关键词');
  }

  const refs = {};
  const exts = { layout: ['.html', '.htm'], schema: ['.json'], example: ['.json'], guide: ['.md'] };
  for (const key of Object.keys(exts)) {
    const value = raw[key];
    if (value === undefined || value === null) { refs[key] = null; continue; }
    if (typeof value !== 'string' || !FILE_RE.test(value) || !exts[key].includes(path.extname(value).toLowerCase())) {
      errors.push(`${key} 应为 ${exts[key].join(' / ')} 文件名`);
      refs[key] = null;
      continue;
    }
    if (typeof files[value] !== 'string') errors.push(`${key} 引用的文件 ${value} 不在模板包里`);
    refs[key] = value;
  }
  const extra = Object.keys(files).filter((file) => file !== 'template.json' && !Object.values(refs).includes(file));
  if (extra.length) errors.push(`模板包里有未被 template.json 引用的文件: ${extra.join(', ')}`);

  let schema = null;
  let example;
  if (refs.layout) {
    if (!refs.schema) errors.push('有 layout 时需要 schema');
    if (!refs.example) errors.push('有 layout 时需要 example（示例数据）');
  }
  if (refs.schema && typeof files[refs.schema] === 'string') {
    try { schema = JSON.parse(files[refs.schema]); } catch (error) { errors.push(`${refs.schema} 不是合法的 JSON: ${error.message}`); }
    if (schema) for (const problem of schemaCheck.checkSchema(schema)) errors.push(`${refs.schema}: ${problem}`);
  }
  if (refs.example && typeof files[refs.example] === 'string') {
    try { example = JSON.parse(files[refs.example]); } catch (error) { errors.push(`${refs.example} 不是合法的 JSON: ${error.message}`); }
  }

  const features = {};
  if (raw.features !== undefined) {
    if (!raw.features || typeof raw.features !== 'object' || Array.isArray(raw.features)) errors.push('features 应为对象');
    else {
      for (const key of Object.keys(raw.features)) if (!FEATURES.includes(key)) errors.push(`features: 不支持的功能 ${key}（本版支持 ${FEATURES.join('、')}）`);
      if (raw.features.print !== undefined) {
        if (typeof raw.features.print !== 'boolean') errors.push('features.print 应为 true 或 false');
        else if (raw.features.print) features.print = true;
      }
      if (raw.features.export !== undefined) {
        const exported = checkExport(raw.features.export, errors);
        if (exported) features.export = exported;
      }
      if (Object.keys(features).length && !refs.layout) errors.push('print、export 需要固定排版（layout）');
    }
  }
  const pageTitle = text(raw.pageTitle, 120);

  if (!errors.length && refs.layout) {
    const problems = schemaCheck.validate(schema, example);
    for (const problem of problems) errors.push(`${refs.example} 不符合 ${refs.schema}: ${problem}`);
    if (features.export) {
      const rows = features.export.xlsx.rows.split('.').reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), example);
      if (!Array.isArray(rows)) errors.push(`features.export.xlsx.rows: 示例数据里 ${features.export.xlsx.rows} 不是数组`);
    }
  }
  if (errors.length) throw new TemplateError(400, 'invalid template package', errors);

  const manifest = {
    name,
    title: text(raw.title, 80) || name,
    description,
    match,
    category: classification.normalizeCategory(raw.category),
    tags: classification.normalizeTags(raw.tags),
    layout: refs.layout,
    schema: refs.schema,
    example: refs.example,
    guide: refs.guide,
    ...(pageTitle ? { pageTitle } : {}),
    features,
  };
  // 用示例数据试渲染一次，确认模板能用
  if (manifest.layout) render({ layout: files[manifest.layout], data: example, pageTitle: manifest.pageTitle, features });
  return { manifest, files };
}

function createTemplates({ directory }) {
  const withLock = createLocks();
  const metaFile = (id) => path.join(directory, id, 'meta.json');
  const versionDir = (id, n) => path.join(directory, id, `v${n}`);

  function readMeta(id) {
    if (!ID_RE.test(id)) return null;
    try { return JSON.parse(fs.readFileSync(metaFile(id), 'utf8')); } catch { return null; }
  }

  function writeMeta(meta) {
    const file = metaFile(meta.id);
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(meta, null, 2));
    fs.renameSync(temporary, file);
  }

  function all() {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory).map(readMeta).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  const visibleTo = (account) => (meta) => meta.owner === account.name || meta.global;

  // 按名称查找：先找自己的，再找全局的
  function find(account, name) {
    const list = all().filter((meta) => meta.name === name);
    return list.find((meta) => meta.owner === account.name) || list.find((meta) => meta.global) || null;
  }

  function current(meta) {
    return meta.versions.find((v) => v.n === meta.current);
  }

  function readFiles(meta, n = meta.current) {
    const entry = meta.versions.find((v) => v.n === n);
    if (!entry) return null;
    const dir = versionDir(meta.id, n);
    return Object.fromEntries(entry.files.map((file) => [file, fs.readFileSync(path.join(dir, file), 'utf8')]));
  }

  function summary(meta, account) {
    const entry = current(meta);
    return {
      id: meta.id,
      name: meta.name,
      title: entry.manifest.title,
      description: entry.manifest.description,
      match: entry.manifest.match,
      category: entry.manifest.category,
      tags: entry.manifest.tags,
      layout: !!entry.manifest.layout,
      features: Object.keys(entry.manifest.features || {}),
      owner: meta.owner,
      global: !!meta.global,
      ...(account ? { mine: meta.owner === account.name } : {}),
      version: meta.current,
      updatedAt: meta.updatedAt,
    };
  }

  function detail(meta, account) {
    const entry = current(meta);
    const files = readFiles(meta);
    const manifest = entry.manifest;
    return {
      ...summary(meta, account),
      pageTitle: manifest.pageTitle || '',
      featureConfig: manifest.features || {},
      fields: manifest.schema ? schemaCheck.describe(JSON.parse(files[manifest.schema])) : [],
      example: manifest.example ? JSON.parse(files[manifest.example]) : null,
      guide: manifest.guide ? files[manifest.guide] : '',
      versions: meta.versions.map((v) => ({ n: v.n, createdAt: v.createdAt, message: v.message || '' })),
    };
  }

  function list(account) {
    return all().filter(visibleTo(account)).map((meta) => summary(meta, account));
  }

  // 关键词匹配：用户原话里出现了哪些关键词（NFKC + 小写的子串匹配）
  function match(account, query) {
    const q = normalizeText(query);
    if (!q.trim()) return [];
    const results = [];
    for (const meta of all().filter(visibleTo(account))) {
      const entry = current(meta);
      const matched = entry.manifest.match.filter((word) => q.includes(normalizeText(word)));
      if (!matched.length) continue;
      results.push({ ...summary(meta, account), matched, score: matched.length });
    }
    // 自己的同名模板会遮住全局模板
    const own = new Set(results.filter((r) => r.mine).map((r) => r.name));
    return results.filter((r) => r.mine || !own.has(r.name)).sort((a, b) => b.score - a.score
      || b.matched.join('').length - a.matched.join('').length
      || Number(b.mine) - Number(a.mine)
      || a.name.localeCompare(b.name));
  }

  async function push(account, name, files, { message = '', global } = {}) {
    if (!NAME_RE.test(name)) return Promise.reject(new TemplateError(400, 'bad template name'));
    const { manifest } = validatePackage(files, name);
    if (global === true && !account.globalTemplates) return Promise.reject(new TemplateError(403, 'this account cannot publish global templates (set global_templates: true in config.yaml)'));
    return withLock(`${account.name}\u0000${name}`, () => {
      const existing = all().find((meta) => meta.owner === account.name && meta.name === name);
      const now = new Date().toISOString();
      const makeGlobal = global === undefined ? !!(existing && existing.global) : global;
      if (makeGlobal) {
        const clash = all().find((meta) => meta.global && meta.name === name && (!existing || meta.id !== existing.id));
        if (clash) throw new TemplateError(409, `a global template named ${name} already exists`);
      }
      if (!existing && all().filter((m) => m.owner === account.name).length >= MAX_TEMPLATES_PER_ACCOUNT) {
        throw new TemplateError(429, `too many templates (max ${MAX_TEMPLATES_PER_ACCOUNT} per account)`);
      }
      const meta = existing || { id: newId(), name, owner: account.name, global: false, current: 0, versions: [], createdAt: now };
      const n = meta.versions.reduce((max, v) => Math.max(max, v.n), 0) + 1;
      const dir = versionDir(meta.id, n);
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      const staging = `${dir}.${process.pid}.tmp`;
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging);
      for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(staging, file), content);
      fs.renameSync(staging, dir);
      const allVersions = [...meta.versions, { n, createdAt: now, message: text(message, 500), files: Object.keys(files).sort(), manifest }];
      const dropped = allVersions.slice(0, Math.max(0, allVersions.length - MAX_VERSIONS));
      const next = {
        ...meta,
        global: makeGlobal,
        current: n,
        versions: allVersions.slice(dropped.length),
        updatedAt: now,
      };
      try { writeMeta(next); } catch (error) { fs.rmSync(dir, { recursive: true, force: true }); throw error; }
      for (const old of dropped) fs.rmSync(versionDir(meta.id, old.n), { recursive: true, force: true });
      return { ...summary(next, account), created: !existing };
    });
  }

  function remove(account, name) {
    return withLock(`${account.name}\u0000${name}`, () => {
      const meta = all().find((m) => m.owner === account.name && m.name === name);
      if (!meta) throw new TemplateError(404, 'template not found (only your own templates can be deleted)');
      fs.rmSync(path.join(directory, meta.id), { recursive: true, force: true });
      return { ok: true, id: meta.id, name };
    });
  }

  function setGlobal(id, flag) {
    const meta = readMeta(id);
    if (!meta) return Promise.reject(new TemplateError(404, 'template not found'));
    return withLock(`${meta.owner}\u0000${meta.name}`, () => {
      const latest = readMeta(id);
      if (!latest) throw new TemplateError(404, 'template not found');
      if (flag && all().some((other) => other.global && other.name === latest.name && other.id !== id)) {
        throw new TemplateError(409, `a global template named ${latest.name} already exists`);
      }
      const next = { ...latest, global: !!flag, updatedAt: new Date().toISOString() };
      writeMeta(next);
      return summary(next);
    });
  }

  // 管理端：全部模板；usage 是 id → { pages, lastUsedAt }（由调用方从资源元数据统计）
  function adminList(usage = new Map()) {
    return all().map((meta) => adminFields(meta, usage));
  }

  function adminFields(meta, usage = new Map()) {
    const used = usage.get(meta.id) || { pages: 0, lastUsedAt: null };
    return { ...summary(meta), versionCount: meta.versions.length, pages: used.pages, lastUsedAt: used.lastUsedAt };
  }

  function byId(id) {
    return readMeta(id);
  }

  return { find, list, match, push, remove, setGlobal, adminList, adminFields, byId, detail, readFiles, current, summary };
}

module.exports = { createTemplates, validatePackage, TemplateError, NAME_RE };

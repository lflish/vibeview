// 资源版本：第 1 版放在资源目录本身（旧数据不用迁移），第 n 版（n ≥ 2）放在 <资源目录>/.versions/<n>/。
// 以 . 开头的路径不会被站点解压写入，也不会被预览路由读出，所以对外不可见。
// 不依赖 config，主服务和渲染 sidecar 共用。
const path = require('path');

const VERSIONS_DIR = '.versions';
const MAX_VERSION = 999999;

// 没有 versions 字段的旧资源，当作只有第 1 版。
function list(meta) {
  if (Array.isArray(meta.versions) && meta.versions.length) return meta.versions;
  return [{
    n: 1,
    filename: meta.filename,
    mime: meta.mime,
    size: Number(meta.size) || 0,
    ...(meta.type === 'site' ? { fileCount: meta.fileCount, archiveName: meta.archiveName } : {}),
    createdAt: meta.createdAt,
  }];
}

function current(meta) {
  return Number.isInteger(meta.current) && meta.current > 0 ? meta.current : 1;
}

function find(meta, n) {
  return list(meta).find((entry) => entry.n === n) || null;
}

function dir(baseDir, n) {
  return n > 1 ? path.join(baseDir, VERSIONS_DIR, String(n)) : baseDir;
}

// 预览地址里的版本段：@3 → 3；其他返回 null。
function parseSegment(segment) {
  const match = /^@([1-9]\d{0,5})$/.exec(String(segment || ''));
  return match ? Number(match[1]) : null;
}

function totalSize(entries) {
  return entries.reduce((sum, entry) => sum + (Number(entry.size) || 0), 0);
}

// 超出上限时从最早的版本开始删；第 1 版、当前版本和锁定（定稿）的版本保留。
function prune(entries, max, keep) {
  const kept = [...entries];
  const removed = [];
  for (let i = 0; kept.length > max && i < kept.length;) {
    const entry = kept[i];
    if (entry.n === 1 || entry.n === keep || entry.locked) { i++; continue; }
    removed.push(...kept.splice(i, 1));
  }
  return { kept, removed };
}

function summary(meta) {
  const entries = list(meta);
  return { version: current(meta), versionCount: entries.length, updatedAt: meta.updatedAt || meta.createdAt };
}

module.exports = { VERSIONS_DIR, MAX_VERSION, list, current, find, dir, parseSegment, totalSize, prune, summary };

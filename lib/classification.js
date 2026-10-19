// 资源分类元数据：category（固定枚举）、agent / model / project（自报标签）、tags（自由标签）。
// 这些字段由上传方自报，只用于整理与筛选，不参与权限；可信来源仍是 token 对应的 source。
const fs = require('fs');

const CATEGORIES = Object.freeze([
  'doc', 'report', 'dashboard', 'prototype', 'game', 'slides', 'tool', 'demo', 'screenshot', 'other',
]);
const MAX_TAGS = 8;
const MAX_TAG_LENGTH = 32;
const MAX_LABEL_LENGTH = 64;
const MAX_HTML_BYTES = 256 * 1024;
const FIELDS = ['category', 'agent', 'model', 'project', 'tags'];

// 小写 slug：保留各语言字母/数字与 . _ -，空白转 -，去掉首尾分隔符。
function slug(value, max) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, max);
}

// 空值返回 ''（未分类）；无法识别的值归入 other，避免各 agent 自造分类。
function normalizeCategory(value) {
  const v = slug(value, 32);
  if (!v) return '';
  return CATEGORIES.includes(v) ? v : 'other';
}

function normalizeLabel(value) {
  return slug(value, MAX_LABEL_LENGTH);
}

// 模型名保留大小写外的常见字符，如 claude-opus-5-5、gpt-5.1、org/model:tag。
function normalizeModel(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._:@/-]/g, '')
    .slice(0, MAX_LABEL_LENGTH);
}

// 接受数组、逗号分隔字符串或二者混合；去重并限制数量。
function normalizeTags(value) {
  const raw = Array.isArray(value) ? value : [value];
  const tags = [];
  for (const entry of raw) {
    for (const part of String(entry == null ? '' : entry).split(/[,，]/)) {
      const tag = slug(part, MAX_TAG_LENGTH);
      if (tag && !tags.includes(tag)) tags.push(tag);
      if (tags.length >= MAX_TAGS) return tags;
    }
  }
  return tags;
}

const NORMALIZERS = {
  category: normalizeCategory,
  agent: normalizeLabel,
  model: normalizeModel,
  project: normalizeLabel,
  tags: normalizeTags,
};

function attr(tag, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i');
  const match = String(tag).match(re);
  return match ? match[2] : '';
}

// HTML 内的兜底声明：<meta name="dview:category" content="game"> 等。
function htmlClassification(html) {
  const found = {};
  for (const tag of String(html || '').match(/<meta\b[^>]*>/gi) || []) {
    const name = attr(tag, 'name').toLowerCase();
    if (!name.startsWith('dview:')) continue;
    const field = name.slice('dview:'.length);
    if (FIELDS.includes(field) && !(field in found)) found[field] = attr(tag, 'content');
  }
  return found;
}

function classificationFromFile(filePath, type) {
  if ((type !== 'html' && type !== 'site') || !filePath) return {};
  try {
    return htmlClassification(fs.readFileSync(filePath, 'utf8').slice(0, MAX_HTML_BYTES));
  } catch {
    return {};
  }
}

// 统一输出形状，缺省字段为空字符串 / 空数组。
function normalize(input = {}) {
  return {
    category: normalizeCategory(input.category),
    agent: normalizeLabel(input.agent),
    model: normalizeModel(input.model),
    project: normalizeLabel(input.project),
    tags: normalizeTags(input.tags),
  };
}

function isEmpty(value) {
  return Array.isArray(value) ? value.length === 0 : !value;
}

// 上传时：显式字段优先，其次 HTML <meta name="dview:*">。
function forUpload(filePath, type, explicit = {}) {
  const fromFile = classificationFromFile(filePath, type);
  const result = {};
  for (const field of FIELDS) {
    const own = NORMALIZERS[field](explicit[field]);
    result[field] = isEmpty(own) ? NORMALIZERS[field](fromFile[field]) : own;
  }
  return result;
}

// 编辑时：只改请求里出现的字段，其他保持原值。
function applyPatch(meta, patch = {}) {
  const next = normalize(meta);
  for (const field of FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) next[field] = NORMALIZERS[field](patch[field]);
  }
  return next;
}

module.exports = {
  CATEGORIES,
  FIELDS,
  MAX_TAGS,
  applyPatch,
  classificationFromFile,
  forUpload,
  htmlClassification,
  normalize,
  normalizeCategory,
  normalizeLabel,
  normalizeModel,
  normalizeTags,
};

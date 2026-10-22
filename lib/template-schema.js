// 模板数据校验：JSON Schema 的一个小子集，足够描述账单这类结构化数据。
// 支持 type、properties、required、items、enum、minItems/maxItems、minimum/maximum、minLength/maxLength、
// title、description。其他关键字视为错误，避免模板作者以为写了约束其实没生效。
const TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
const KEYWORDS = new Set(['type', 'properties', 'required', 'items', 'enum', 'minItems', 'maxItems', 'minimum', 'maximum',
  'minLength', 'maxLength', 'title', 'description', '$schema']);
const MAX_ERRORS = 50;
const MAX_DEPTH = 20;

const TYPE_NAMES = { object: '对象', array: '数组', string: '字符串', number: '数字', integer: '整数', boolean: '布尔值', null: 'null' };

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value, type) {
  const actual = typeOf(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  return actual === type;
}

function child(path, key) {
  if (typeof key === 'number') return `${path}[${key}]`;
  return path ? `${path}.${key}` : key;
}

// 检查 schema 本身；返回错误列表（空表示合法）。
function checkSchema(schema, path = '', depth = 0, errors = []) {
  const at = path || '(根)';
  if (depth > MAX_DEPTH) { errors.push(`${at}: 嵌套过深`); return errors; }
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) { errors.push(`${at}: 应为对象`); return errors; }
  for (const key of Object.keys(schema)) if (!KEYWORDS.has(key)) errors.push(`${at}: 不支持的关键字 ${key}`);
  const types = Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type];
  if (!types.length) errors.push(`${at}: 缺少 type`);
  for (const type of types) if (!TYPES.includes(type)) errors.push(`${at}: 未知类型 ${type}`);
  if (schema.properties !== undefined) {
    if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) errors.push(`${at}: properties 应为对象`);
    else for (const [key, sub] of Object.entries(schema.properties)) checkSchema(sub, child(path, key), depth + 1, errors);
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== 'string'))) {
    errors.push(`${at}: required 应为字符串数组`);
  }
  if (schema.items !== undefined) checkSchema(schema.items, `${path}[]`, depth + 1, errors);
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) errors.push(`${at}: enum 应为非空数组`);
  for (const key of ['minItems', 'maxItems', 'minLength', 'maxLength']) {
    if (schema[key] !== undefined && !(Number.isInteger(schema[key]) && schema[key] >= 0)) errors.push(`${at}: ${key} 应为非负整数`);
  }
  for (const key of ['minimum', 'maximum']) {
    if (schema[key] !== undefined && typeof schema[key] !== 'number') errors.push(`${at}: ${key} 应为数字`);
  }
  return errors;
}

// 按 schema 校验数据；返回错误列表，最多 MAX_ERRORS 条。
function validate(schema, value) {
  const errors = [];
  const push = (message) => { if (errors.length < MAX_ERRORS) errors.push(message); };
  (function walk(s, v, path, depth) {
    if (errors.length >= MAX_ERRORS || depth > MAX_DEPTH) return;
    const at = path || '(根)';
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((type) => matchesType(v, type))) {
      push(`${at}: 应为 ${types.map((type) => TYPE_NAMES[type] || type).join(' 或 ')}，实际是 ${TYPE_NAMES[typeOf(v)] || typeOf(v)}`);
      return;
    }
    if (s.enum && !s.enum.some((option) => option === v)) push(`${at}: 只能是 ${s.enum.map((option) => JSON.stringify(option)).join(' / ')}`);
    if (typeof v === 'string') {
      const length = [...v].length;
      if (s.minLength !== undefined && length < s.minLength) push(`${at}: 至少 ${s.minLength} 个字符`);
      if (s.maxLength !== undefined && length > s.maxLength) push(`${at}: 最多 ${s.maxLength} 个字符`);
    }
    if (typeof v === 'number') {
      if (s.minimum !== undefined && v < s.minimum) push(`${at}: 不能小于 ${s.minimum}`);
      if (s.maximum !== undefined && v > s.maximum) push(`${at}: 不能大于 ${s.maximum}`);
    }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) push(`${at}: 至少 ${s.minItems} 项`);
      if (s.maxItems !== undefined && v.length > s.maxItems) push(`${at}: 最多 ${s.maxItems} 项`);
      if (s.items) v.forEach((item, i) => walk(s.items, item, child(path, i), depth + 1));
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const key of s.required || []) if (!Object.prototype.hasOwnProperty.call(v, key)) push(`${child(path, key)}: 缺少必填字段`);
      for (const [key, sub] of Object.entries(s.properties || {})) {
        if (Object.prototype.hasOwnProperty.call(v, key)) walk(sub, v[key], child(path, key), depth + 1);
      }
    }
  })(schema, value, '', 0);
  return errors;
}

// 把 schema 展开成字段说明（给 agent 和管理页看）。
function describe(schema) {
  const fields = [];
  (function walk(s, path, required, depth) {
    if (!s || depth > MAX_DEPTH) return;
    if (path) {
      fields.push({
        path,
        type: Array.isArray(s.type) ? s.type.join('|') : s.type,
        required,
        ...(s.title ? { title: s.title } : {}),
        ...(s.description ? { description: s.description } : {}),
        ...(s.enum ? { enum: s.enum } : {}),
      });
    }
    for (const [key, sub] of Object.entries(s.properties || {})) walk(sub, child(path, key), (s.required || []).includes(key), depth + 1);
    if (s.items) walk(s.items, `${path}[]`, true, depth + 1);
  })(schema, '', true, 0);
  return fields;
}

module.exports = { checkSchema, validate, describe };

const fs = require('fs');
const path = require('path');
const config = require('./config');
const store = require('./store');

// 运行时账户状态（disabled 等），不写回 config.yaml，避免动密钥
const STATE_PATH = path.join(config.storage.metaDir, '..', 'account-state.json');

function loadState() {
  try {
    if (!fs.existsSync(STATE_PATH)) return { accounts: {} };
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return { accounts: raw.accounts && typeof raw.accounts === 'object' ? raw.accounts : {} };
  } catch {
    return { accounts: {} };
  }
}

function saveState(state) {
  const dir = path.dirname(STATE_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = STATE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}

function normalizeAccount(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim();
  const token = String(raw.token || '').trim();
  if (!name || !token) return null;

  const maxFiles = raw.max_files != null ? Number(raw.max_files) : null;
  const maxStorageMb = raw.max_storage_mb != null ? Number(raw.max_storage_mb) : null;
  const retentionDays = raw.retention_days != null ? Number(raw.retention_days) : null;

  return {
    name,
    token,
    // config.yaml 里可写死 disabled；运行时覆盖见 account-state.json
    disabledInConfig: !!raw.disabled,
    maxFiles: Number.isFinite(maxFiles) && maxFiles > 0 ? Math.floor(maxFiles) : null,
    maxStorageMb: Number.isFinite(maxStorageMb) && maxStorageMb > 0 ? maxStorageMb : null,
    retentionDays:
      Number.isFinite(retentionDays) && retentionDays >= 0 ? Math.floor(retentionDays) : null,
  };
}

function listConfigured() {
  return (config.tokens || []).map(normalizeAccount).filter(Boolean);
}

function getRuntimeDisabled(name) {
  const state = loadState();
  const entry = state.accounts[name];
  if (!entry || typeof entry.disabled !== 'boolean') return null;
  return entry.disabled;
}

function isDisabled(account) {
  if (!account) return true;
  const runtime = getRuntimeDisabled(account.name);
  if (runtime !== null) return runtime;
  return account.disabledInConfig;
}

// 用 Bearer token 反查账户；禁用的返回 null
function findActiveByToken(token) {
  if (!token) return null;
  const acc = listConfigured().find((a) => a.token === token) || null;
  if (!acc || isDisabled(acc)) return null;
  return acc;
}

function findByName(name) {
  if (!name) return null;
  return listConfigured().find((a) => a.name === name) || null;
}

function setDisabled(name, disabled) {
  const acc = findByName(name);
  if (!acc) return { ok: false, error: 'account not found' };
  const state = loadState();
  if (!state.accounts[name]) state.accounts[name] = {};
  state.accounts[name].disabled = !!disabled;
  state.accounts[name].updatedAt = new Date().toISOString();
  saveState(state);
  return { ok: true, name, disabled: !!disabled };
}

// 按来源汇总用量（文件数 + 字节）
function usageBySource() {
  const map = new Map();
  for (const meta of store.listAll()) {
    const src = meta.source || 'unknown';
    let u = map.get(src);
    if (!u) {
      u = { source: src, count: 0, bytes: 0 };
      map.set(src, u);
    }
    u.count += 1;
    u.bytes += Number(meta.size) || 0;
  }
  return map;
}

function usageFor(source) {
  const all = usageBySource();
  return all.get(source) || { source, count: 0, bytes: 0 };
}

function listAccountsWithUsage() {
  const usage = usageBySource();
  const configured = listConfigured().map((a) => {
    const u = usage.get(a.name) || { count: 0, bytes: 0 };
    usage.delete(a.name);
    return {
      name: a.name,
      disabled: isDisabled(a),
      maxFiles: a.maxFiles,
      maxStorageMb: a.maxStorageMb,
      retentionDays: a.retentionDays,
      count: u.count,
      bytes: u.bytes,
      configured: true,
    };
  });

  // 仍有上传记录、但 config 里已删掉的来源
  const orphans = [];
  for (const [source, u] of usage) {
    orphans.push({
      name: source,
      disabled: true,
      maxFiles: null,
      maxStorageMb: null,
      retentionDays: null,
      count: u.count,
      bytes: u.bytes,
      configured: false,
    });
  }
  orphans.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return configured.concat(orphans);
}

// 上传前配额检查；返回 { ok:true } 或 { ok:false, error, status }
function checkQuota(account, incomingBytes) {
  if (!account) return { ok: false, error: 'unauthorized', status: 401 };
  if (isDisabled(account)) return { ok: false, error: 'account disabled', status: 403 };

  const usage = usageFor(account.name);
  const nextCount = usage.count + 1;
  const nextBytes = usage.bytes + (Number(incomingBytes) || 0);

  if (account.maxFiles != null && nextCount > account.maxFiles) {
    return {
      ok: false,
      error: `quota exceeded: max_files=${account.maxFiles} (current ${usage.count})`,
      status: 429,
    };
  }
  if (account.maxStorageMb != null) {
    const limit = account.maxStorageMb * 1024 * 1024;
    if (nextBytes > limit) {
      return {
        ok: false,
        error: `quota exceeded: max_storage_mb=${account.maxStorageMb} (current ${(
          usage.bytes /
          1024 /
          1024
        ).toFixed(1)} MB)`,
        status: 429,
      };
    }
  }
  return { ok: true };
}

// 某账户的有效保留天数（账户覆盖 > 全局）
function retentionDaysFor(source) {
  const acc = findByName(source);
  if (acc && acc.retentionDays != null) return acc.retentionDays;
  return config.storage.retentionDays;
}

function publicAccountInfo(account) {
  if (!account) return null;
  const usage = usageFor(account.name);
  return {
    name: account.name,
    disabled: isDisabled(account),
    maxFiles: account.maxFiles,
    maxStorageMb: account.maxStorageMb,
    retentionDays: account.retentionDays != null ? account.retentionDays : config.storage.retentionDays,
    usage: {
      count: usage.count,
      bytes: usage.bytes,
    },
  };
}

module.exports = {
  STATE_PATH,
  listConfigured,
  findActiveByToken,
  findByName,
  isDisabled,
  setDisabled,
  usageBySource,
  usageFor,
  listAccountsWithUsage,
  checkQuota,
  retentionDaysFor,
  publicAccountInfo,
};

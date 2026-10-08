const config = require('./config');
const store = require('./store');
const accounts = require('./accounts');

// 按账户 retention 覆盖（缺省用全局）清理过期上传
function cleanupExpired() {
  let removed = 0;
  const now = Date.now();
  for (const meta of store.listAll()) {
    const days = accounts.retentionDaysFor(meta.source);
    if (!days || days <= 0) continue; // 0 表示该账户/全局不清理
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    const created = new Date(meta.createdAt).getTime();
    if (!Number.isNaN(created) && created < cutoff) {
      if (store.remove(meta.id)) removed++;
    }
  }
  if (removed > 0) {
    console.log(`[cleanup] 已清理 ${removed} 条过期上传（全局默认 ${config.storage.retentionDays} 天，可按账户覆盖）`);
  }
  return removed;
}

// 启动时跑一次，并每 6 小时跑一次
function startCleanupScheduler() {
  cleanupExpired();
  setInterval(cleanupExpired, 6 * 60 * 60 * 1000);
}

module.exports = { cleanupExpired, startCleanupScheduler };

const config = require('./config');
const store = require('./store');

// 删除超过 retentionDays 的上传，返回清理条数
function cleanupExpired() {
  const days = config.storage.retentionDays;
  if (!days || days <= 0) return 0; // 0 或未配置视为不清理
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const meta of store.listAll()) {
    const created = new Date(meta.createdAt).getTime();
    if (!Number.isNaN(created) && created < cutoff) {
      if (store.remove(meta.id)) removed++;
    }
  }
  if (removed > 0) {
    console.log(`[cleanup] 已清理 ${removed} 条过期上传 (>${days} 天)`);
  }
  return removed;
}

// 启动时跑一次，并每 6 小时跑一次
function startCleanupScheduler() {
  cleanupExpired();
  setInterval(cleanupExpired, 6 * 60 * 60 * 1000);
}

module.exports = { cleanupExpired, startCleanupScheduler };

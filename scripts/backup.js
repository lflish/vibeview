#!/usr/bin/env node
// 数据备份：把 config.yaml 指向的上传文件、元数据、统计和状态文件打成一个 tar.gz。
// 可以在服务运行时执行：统计事件是原子写入的单个文件，visits.sqlite 先做一致快照再打包。
// 只是还在内存里、尚未写盘的访问计数（最多 30 秒）不会进入本次备份。
//
// 用法: node scripts/backup.js [--dest DIR] [--keep N] [--no-config]
//   --dest       备份目录，默认 meta_dir 旁的 backups/（即 data/backups）
//   --keep       保留最近 N 份自动备份（auto-*.tar.gz），默认 14；0 表示不清理
//   --no-config  不把 config.yaml 打进去（它含 token 与管理员密码）
//
// 恢复：停止服务 → 解包到临时目录 → 按包内 manifest.json 记录的原路径放回 → 启动服务。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const config = require('../lib/config');

const CONFIG_PATH = path.resolve(
  process.env.DVIEW_CONFIG_PATH || process.env.CONFIG_PATH || path.join(__dirname, '..', 'config.yaml')
);

function parseArgs(argv) {
  const options = { dest: path.join(config.storage.metaDir, '..', 'backups'), keep: 14, includeConfig: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dest') options.dest = path.resolve(argv[++i] || '');
    else if (arg === '--keep') options.keep = Number(argv[++i]);
    else if (arg === '--no-config') options.includeConfig = false;
    else if (arg === '-h' || arg === '--help') { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 12).join('\n').replace(/^\/\/ ?/gm, '')); process.exit(0); }
    else throw new Error(`未知参数: ${arg}`);
  }
  if (!Number.isInteger(options.keep) || options.keep < 0) throw new Error('--keep 需要一个非负整数');
  return options;
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

// 用 VACUUM INTO 得到一个一致的快照；不会锁住正在运行的服务太久。
function snapshotSqlite(source, target) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(source, { readOnly: true });
  try { db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`); } finally { db.close(); }
}

function prune(dest, keep) {
  if (!keep) return [];
  const old = fs.readdirSync(dest).filter((name) => /^auto-\d{8}T\d{6}Z\.tar\.gz$/.test(name)).sort().reverse().slice(keep);
  for (const name of old) fs.rmSync(path.join(dest, name), { force: true });
  return old;
}

function backup(options) {
  fs.mkdirSync(options.dest, { recursive: true, mode: 0o700 });
  fs.chmodSync(options.dest, 0o700);
  const name = `auto-${stamp()}.tar.gz`;
  const output = path.join(options.dest, name);
  const partial = `${output}.partial`;
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeview-backup-'));
  try {
    // 小文件先复制到临时目录，统一放在包内固定位置；大的上传目录直接打包，不复制。
    const manifest = { createdAt: new Date().toISOString(), host: os.hostname(), entries: {} };
    const record = (member, source) => { manifest.entries[member] = source; };
    if (fs.existsSync(config.storage.metaDir)) {
      fs.cpSync(config.storage.metaDir, path.join(staging, 'meta'), { recursive: true });
      record('meta', config.storage.metaDir);
    }
    const stats = config.statistics.directory;
    if (fs.existsSync(stats)) {
      fs.cpSync(stats, path.join(staging, 'statistics'), {
        recursive: true,
        filter: (src) => !/^visits\.sqlite(-journal|-wal|-shm)?$/.test(path.basename(src)) || path.dirname(src) !== stats,
      });
      const visits = path.join(stats, 'visits.sqlite');
      if (fs.existsSync(visits)) snapshotSqlite(visits, path.join(staging, 'statistics', 'visits.sqlite'));
      record('statistics', stats);
    }
    const states = {
      'account-state.json': path.join(config.storage.metaDir, '..', 'account-state.json'),
      'preview-attempts.json': config.access.attemptsFile,
      'admin-login-attempts.json': config.admin.loginAttemptsFile,
    };
    if (options.includeConfig) states['config.yaml'] = CONFIG_PATH;
    for (const [member, source] of Object.entries(states)) {
      if (!fs.existsSync(source)) continue;
      fs.copyFileSync(source, path.join(staging, member));
      record(member, source);
    }

    const uploads = { html: config.storage.htmlDir, images: config.storage.imageDir, videos: config.storage.videoDir, sites: config.storage.siteDir };
    const tarArgs = ['-czf', partial, '-C', staging, '.'];
    for (const [member, dir] of Object.entries(uploads)) {
      if (!fs.existsSync(dir)) continue;
      // 包内统一叫 html/images/videos/sites，原路径记在 manifest 里；只有改过目录名时才需要 GNU tar 的改名。
      const base = path.basename(dir);
      // 站点上传中途的临时 zip 不备份
      if (member === 'sites') tarArgs.push(`--exclude=${base}/.incoming`);
      if (base !== member) tarArgs.push(`--transform=s,^${base.replace(/[,\\]/g, '\\$&')}\\(/\\|$\\),${member}\\1,`);
      tarArgs.push('-C', path.dirname(dir), base);
      record(member, dir);
    }
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

    const previous = process.umask(0o077);
    try { execFileSync('tar', tarArgs, { stdio: ['ignore', 'ignore', 'pipe'] }); } finally { process.umask(previous); }
    // 能完整读出来才算备份成功。
    const members = execFileSync('tar', ['-tzf', partial], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\n').filter(Boolean);
    if (!members.some((m) => m.replace(/^\.\//, '') === 'manifest.json')) throw new Error('备份包缺少 manifest.json');
    fs.renameSync(partial, output);
    const removed = prune(options.dest, options.keep);
    return { file: output, bytes: fs.statSync(output).size, members: members.length, entries: Object.keys(manifest.entries), removed };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(partial, { force: true });
  }
}

if (require.main === module) {
  try {
    const result = backup(parseArgs(process.argv.slice(2)));
    const size = result.bytes >= 1048576 ? `${(result.bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(result.bytes / 1024)} KB`;
    console.log(`[backup] ${result.file} (${size}, ${result.members} entries: ${result.entries.join(', ')})`);
    if (result.removed.length) console.log(`[backup] 清理旧备份: ${result.removed.join(', ')}`);
  } catch (error) {
    console.error('[backup] 失败:', error.message);
    process.exit(1);
  }
}

module.exports = { backup, prune };

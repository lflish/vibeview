// 多页面站点：安全解压上传的 zip。
// 规则：只接受常见网页资源类型；拒绝符号链接、加密条目、越界路径和 "~" 开头的路径段（预览地址保留）；
// 跳过 "." 开头的隐藏文件和 __MACOSX；文件数和解压后总大小都有上限，按实际解压字节计数，防压缩炸弹。
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const yauzl = require('yauzl');
const { validSegment } = require('./preview-store');

const ALLOWED_EXTENSIONS = new Set([
  'html', 'htm', 'css', 'js', 'mjs', 'json', 'map', 'txt', 'md', 'xml', 'csv', 'tsv', 'webmanifest',
  'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp',
  'mp4', 'webm', 'mp3', 'wav', 'ogg', 'm4a',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'wasm', 'glb', 'gltf', 'bin', 'pdf',
]);
const MAX_PATH_LENGTH = 512;

class SiteArchiveError extends Error {}

function isZipUpload(mime, filename) {
  const m = String(mime || '').toLowerCase();
  return path.extname(filename || '').toLowerCase() === '.zip' || m === 'application/zip' || m === 'application/x-zip-compressed';
}

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: true, validateEntrySizes: true, strictFileNames: false }, (err, zip) => {
      if (err) reject(new SiteArchiveError(`invalid zip: ${err.message}`)); else resolve(zip);
    });
  });
}

function readEntries(zip) {
  return new Promise((resolve, reject) => {
    const entries = [];
    zip.on('entry', (entry) => { entries.push(entry); zip.readEntry(); });
    zip.on('end', () => resolve(entries));
    zip.on('error', (err) => reject(new SiteArchiveError(`invalid zip: ${err.message}`)));
    zip.readEntry();
  });
}

function openStream(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => (err ? reject(new SiteArchiveError(`invalid zip entry ${entry.fileName}: ${err.message}`)) : resolve(stream)));
  });
}

// 先检查目录表，确定要写哪些文件；不写任何东西。
function plan(entries, limits) {
  const files = [];
  let skipped = 0;
  const seen = new Set();
  for (const entry of entries) {
    const name = entry.fileName;
    if (name.endsWith('/')) continue; // 目录按需创建
    const parts = name.split('/').filter((part) => part !== '');
    if (parts[0] === '__MACOSX' || parts.some((part) => part.startsWith('.'))) { skipped++; continue; }
    const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
    if (mode === 0o120000) throw new SiteArchiveError(`symbolic links are not allowed: ${name}`);
    if (entry.generalPurposeBitFlag & 0x1) throw new SiteArchiveError(`encrypted entries are not supported: ${name}`);
    if (name.length > MAX_PATH_LENGTH || !parts.length || !parts.every(validSegment)) throw new SiteArchiveError(`invalid path: ${name}`);
    const ext = path.extname(parts[parts.length - 1]).slice(1).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) throw new SiteArchiveError(`unsupported file type: ${name}`);
    const key = parts.join('/');
    if (seen.has(key.toLowerCase())) throw new SiteArchiveError(`duplicate path: ${name}`);
    seen.add(key.toLowerCase());
    files.push({ entry, parts });
  }
  if (files.length > limits.maxFiles) throw new SiteArchiveError(`too many files: ${files.length} (max ${limits.maxFiles})`);
  const declared = files.reduce((sum, file) => sum + file.entry.uncompressedSize, 0);
  if (declared > limits.maxBytes) throw new SiteArchiveError(`site too large: ${declared} bytes unpacked (max ${limits.maxBytes})`);

  // 压缩整个 dist/ 目录时，入口在唯一的顶层目录里：去掉这一层。
  const hasRootIndex = files.some((file) => file.parts.length === 1 && file.parts[0] === 'index.html');
  if (!hasRootIndex && files.length) {
    const top = files[0].parts[0];
    const shared = files.every((file) => file.parts.length > 1 && file.parts[0] === top);
    if (shared && files.some((file) => file.parts.length === 2 && file.parts[1] === 'index.html')) {
      for (const file of files) file.parts = file.parts.slice(1);
    }
  }
  if (!files.some((file) => file.parts.length === 1 && file.parts[0] === 'index.html')) {
    throw new SiteArchiveError('site must contain index.html at the top level');
  }
  return { files, skipped };
}

/**
 * 把 zip 解压到 destDir（必须不存在）。成功返回 { fileCount, size, skipped }；失败时清理 destDir 并抛 SiteArchiveError。
 * @param {string} zipPath
 * @param {string} destDir
 * @param {{ maxFiles: number, maxBytes: number }} limits
 */
async function extractSite(zipPath, destDir, limits) {
  const zip = await openZip(zipPath);
  const root = path.resolve(destDir);
  let created = false;
  try {
    // 目录和被跳过的条目不计入文件数；先按目录表里的总条目数设上限，避免把巨量条目读进内存
    if (zip.entryCount > limits.maxFiles * 2 + 1000) throw new SiteArchiveError(`too many entries: ${zip.entryCount}`);
    const { files, skipped } = plan(await readEntries(zip), limits);
    fs.mkdirSync(path.dirname(root), { recursive: true });
    fs.mkdirSync(root); // 已存在就报错，绝不覆盖或清理别人的目录
    created = true;
    let total = 0;
    for (const file of files) {
      const target = path.join(root, ...file.parts);
      if (!target.startsWith(root + path.sep)) throw new SiteArchiveError(`invalid path: ${file.entry.fileName}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const counter = new Transform({
        transform(chunk, _encoding, done) {
          total += chunk.length;
          if (total > limits.maxBytes) return done(new SiteArchiveError(`site too large: more than ${limits.maxBytes} bytes unpacked`));
          done(null, chunk);
        },
      });
      try {
        await pipeline(await openStream(zip, file.entry), counter, fs.createWriteStream(target, { flags: 'wx' }));
      } catch (error) {
        throw error instanceof SiteArchiveError ? error : new SiteArchiveError(`invalid zip entry ${file.entry.fileName}: ${error.message}`);
      }
    }
    return { fileCount: files.length, size: total, skipped };
  } catch (error) {
    if (created) fs.rmSync(root, { recursive: true, force: true });
    throw error;
  } finally {
    zip.close();
  }
}

module.exports = { extractSite, isZipUpload, validSegment, SiteArchiveError, ALLOWED_EXTENSIONS };

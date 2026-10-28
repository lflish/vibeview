const fs = require('fs');

const MAX_DESCRIPTION_LENGTH = 180;
const MAX_HTML_BYTES = 256 * 1024;

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function normalizeDescription(value) {
  const text = decodeEntities(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > MAX_DESCRIPTION_LENGTH
    ? text.slice(0, MAX_DESCRIPTION_LENGTH - 1).trimEnd() + '…'
    : text;
}

function attr(tag, name) {
  const re = new RegExp(`${name}\\s*=\\s*(["'])(.*?)\\1`, 'i');
  const match = String(tag).match(re);
  return match ? match[2] : '';
}

function htmlDescription(html) {
  const metas = String(html || '').match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metas) {
    if (attr(tag, 'name').toLowerCase() === 'description') {
      const value = normalizeDescription(attr(tag, 'content'));
      if (value) return value;
    }
  }

  const title = String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const titleText = normalizeDescription(title && title[1]);
  if (titleText) return titleText;

  const heading = String(html || '').match(/<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/i);
  return normalizeDescription(heading && heading[1]);
}

// 只读取文件头部，避免为大 HTML 把整个文件读进内存
function readHead(filePath, maxBytes) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytes = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.toString('utf8', 0, bytes);
  } finally {
    fs.closeSync(fd);
  }
}

function descriptionFromFile(filePath, type) {
  if ((type !== 'html' && type !== 'site') || !filePath) return '';
  try {
    return htmlDescription(readHead(filePath, MAX_HTML_BYTES));
  } catch {
    return '';
  }
}

function descriptionForUpload(filePath, type, explicit) {
  return normalizeDescription(explicit) || descriptionFromFile(filePath, type);
}

module.exports = {
  MAX_DESCRIPTION_LENGTH,
  MAX_HTML_BYTES,
  descriptionFromFile,
  descriptionForUpload,
  htmlDescription,
  normalizeDescription,
};

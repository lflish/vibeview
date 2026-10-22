// 模板渲染：把数据以 JSON 嵌入模板页面，替换标题，按功能注入工具栏（打印、导出 Excel）。
// 平台从不把数据当 HTML 插入；模板脚本读取 window.DVIEW_DATA 后用 textContent 显示。
// 输出只取决于模板版本和数据，不含时间戳：同样的输入逐字节相同。
const fs = require('fs');
const path = require('path');

const XLSX_SOURCE = fs.readFileSync(path.join(__dirname, 'xlsx.js'), 'utf8');
if (/<\/script/i.test(XLSX_SOURCE)) throw new Error('xlsx.js must not contain a closing script tag');

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// 能安全放进 <script> 的 JSON：不会提前闭合标签，也不会在旧解析器里断行。
function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function getPath(value, keyPath) {
  return String(keyPath || '').split('.').filter(Boolean).reduce((current, key) => (
    current != null && typeof current === 'object' ? current[key] : undefined), value);
}

// "{vendor} {period} 账单" → 用数据替换；结果是纯文本
function fillTitle(pattern, data) {
  if (!pattern) return '';
  return pattern.replace(/\{([A-Za-z0-9_.]+)\}/g, (_, key) => {
    const value = getPath(data, key);
    return value == null || typeof value === 'object' ? '' : String(value);
  }).replace(/\s+/g, ' ').trim().slice(0, 180);
}

function toolbar(features, title) {
  const buttons = [];
  if (features.print) buttons.push('<button type="button" data-dview="print">打印</button>');
  if (features.export && features.export.xlsx) buttons.push('<button type="button" data-dview="xlsx">导出 Excel</button>');
  if (!buttons.length) return '';
  const filename = (title || 'export').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) + '.xlsx';
  const xlsxSpec = features.export && features.export.xlsx ? features.export.xlsx : null;
  return `
<div id="dview-toolbar" role="toolbar" aria-label="页面工具">${buttons.join('')}</div>
<style>
#dview-toolbar{position:fixed;top:12px;right:12px;z-index:2147483647;display:flex;gap:6px;font:13px/1.4 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
#dview-toolbar button{padding:6px 12px;border:1px solid #d5dde7;border-radius:8px;background:#fff;color:#1e293b;font:inherit;cursor:pointer;box-shadow:0 1px 2px rgba(15,23,42,.06)}
#dview-toolbar button:hover{border-color:#2563eb;color:#2563eb}
#dview-toolbar button:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
@media (max-width:640px){#dview-toolbar{top:auto;bottom:12px}}
@media print{#dview-toolbar{display:none!important}}
</style>
${xlsxSpec ? `<script>${XLSX_SOURCE}</script>` : ''}
<script>
(function () {
  var spec = ${scriptJson(xlsxSpec)};
  var filename = ${scriptJson(filename)};
  document.getElementById('dview-toolbar').addEventListener('click', function (event) {
    var button = event.target.closest('button[data-dview]');
    if (!button) return;
    if (button.getAttribute('data-dview') === 'print') return window.print();
    var bytes = DviewXlsx.buildXlsx(DviewXlsx.exportTable(window.DVIEW_DATA, spec));
    var url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });
})();
</script>
`;
}

/**
 * @param {{ layout: string, data: any, pageTitle?: string, features?: object }} input
 * @returns {{ html: string, title: string }}
 */
function render({ layout, data, pageTitle, features = {} }) {
  const title = fillTitle(pageTitle, data);
  let html = String(layout);
  if (title) {
    if (/<title\b[^>]*>[\s\S]*?<\/title>/i.test(html)) {
      html = html.replace(/(<title\b[^>]*>)[\s\S]*?(<\/title>)/i, (_, open, close) => `${open}${escapeHtml(title)}${close}`);
    }
  }
  const head = `\n<script type="application/json" id="dview-data">${scriptJson(data)}</script>\n`
    + '<script>window.DVIEW_DATA = JSON.parse(document.getElementById("dview-data").textContent);</script>\n'
    + (title && !/<title\b/i.test(html) ? `<title>${escapeHtml(title)}</title>\n` : '');
  // 数据要在模板脚本之前可用：放在 <head> 开头；没有 <head> 时放在文档最前面（<!doctype> 之后）
  if (/<head\b[^>]*>/i.test(html)) html = html.replace(/<head\b[^>]*>/i, (tag) => tag + head);
  else if (/<!doctype[^>]*>/i.test(html)) html = html.replace(/<!doctype[^>]*>/i, (tag) => tag + head);
  else html = head + html;

  const bar = toolbar(features, title);
  if (bar) {
    const close = html.search(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i);
    html = close === -1 ? html + bar : html.slice(0, close) + bar + html.slice(close);
  }
  return { html, title };
}

module.exports = { render, fillTitle, scriptJson, getPath };

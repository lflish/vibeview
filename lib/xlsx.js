// 极简 xlsx 生成器：一个工作表、内联字符串、表头加粗，不压缩的 zip。
// 同一份代码在服务端（导出接口）和浏览器（渲染时注入页面的"导出 Excel"按钮）运行，
// 所以只用标准 JS，不依赖 Node API 和第三方库。输出不含时间戳，同样的输入得到同样的文件。
// 注意：这个文件会被原样内联进页面的 <script>，不能出现脚本结束标签。
(function (root) {
  'use strict';

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function utf8(text) {
    return new TextEncoder().encode(text);
  }

  // 不压缩（stored）的 zip；时间固定为 1980-01-01 00:00。
  function zip(files) {
    var parts = [];
    var central = [];
    var offset = 0;
    var DOS_DATE = 0x21;
    files.forEach(function (file) {
      var name = utf8(file.name);
      var data = file.data;
      var crc = crc32(data);
      var local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true);
      local.setUint16(8, 0, true);
      local.setUint16(10, 0, true);
      local.setUint16(12, DOS_DATE, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      var entry = new DataView(new ArrayBuffer(46));
      entry.setUint32(0, 0x02014b50, true);
      entry.setUint16(4, 20, true);
      entry.setUint16(6, 20, true);
      entry.setUint16(8, 0x0800, true);
      entry.setUint16(10, 0, true);
      entry.setUint16(12, 0, true);
      entry.setUint16(14, DOS_DATE, true);
      entry.setUint32(16, crc, true);
      entry.setUint32(20, data.length, true);
      entry.setUint32(24, data.length, true);
      entry.setUint16(28, name.length, true);
      entry.setUint32(42, offset, true);
      parts.push(new Uint8Array(local.buffer), name, data);
      central.push(new Uint8Array(entry.buffer), name);
      offset += 30 + name.length + data.length;
    });
    var centralSize = central.reduce(function (sum, part) { return sum + part.length; }, 0);
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    var all = parts.concat(central, [new Uint8Array(end.buffer)]);
    var out = new Uint8Array(offset + centralSize + 22);
    var at = 0;
    all.forEach(function (part) { out.set(part, at); at += part.length; });
    return out;
  }

  function xmlText(value) {
    // 去掉 XML 不允许的控制字符
    return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function columnName(index) {
    var name = '';
    for (var n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
    return name;
  }

  function displayWidth(value) {
    var width = 0;
    var text = String(value == null ? '' : value);
    for (var i = 0; i < text.length; i++) width += text.charCodeAt(i) > 0x2e7f ? 2 : 1;
    return width;
  }

  function sheetName(name) {
    var clean = String(name || 'Sheet1').replace(/[\[\]:*?\/\\]/g, ' ').trim().slice(0, 31);
    return clean || 'Sheet1';
  }

  // table: { sheet, rows: 二维数组, boldRows: 需要加粗的行号 }
  function buildXlsx(table) {
    var rows = table.rows || [];
    var bold = {};
    (table.boldRows || []).forEach(function (r) { bold[r] = true; });
    var widths = [];
    var body = rows.map(function (row, r) {
      var cells = row.map(function (value, c) {
        widths[c] = Math.max(widths[c] || 0, displayWidth(value));
        var ref = columnName(c) + (r + 1);
        var style = bold[r] ? ' s="1"' : '';
        if (value === null || value === undefined || value === '') return '';
        if (typeof value === 'number' && isFinite(value)) return '<c r="' + ref + '"' + style + '><v>' + value + '</v></c>';
        if (typeof value === 'boolean') return '<c r="' + ref + '"' + style + ' t="b"><v>' + (value ? 1 : 0) + '</v></c>';
        return '<c r="' + ref + '"' + style + ' t="inlineStr"><is><t xml:space="preserve">' + xmlText(value) + '</t></is></c>';
      }).join('');
      return '<row r="' + (r + 1) + '">' + cells + '</row>';
    }).join('');
    var cols = widths.length ? '<cols>' + widths.map(function (w, i) {
      return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + Math.min(60, Math.max(8, w + 2)) + '" customWidth="1"/>';
    }).join('') + '</cols>' : '';
    var ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    var rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    var head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    var files = [
      ['[Content_Types].xml', head + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        + '</Types>'],
      ['_rels/.rels', head + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="' + rel + '/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
      ['xl/workbook.xml', head + '<workbook xmlns="' + ns + '" xmlns:r="' + rel + '"><sheets>'
        + '<sheet name="' + xmlText(sheetName(table.sheet)) + '" sheetId="1" r:id="rId1"/></sheets></workbook>'],
      ['xl/_rels/workbook.xml.rels', head + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="' + rel + '/worksheet" Target="worksheets/sheet1.xml"/>'
        + '<Relationship Id="rId2" Type="' + rel + '/styles" Target="styles.xml"/></Relationships>'],
      ['xl/styles.xml', head + '<styleSheet xmlns="' + ns + '">'
        + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
        + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
        + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
        + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'],
      ['xl/worksheets/sheet1.xml', head + '<worksheet xmlns="' + ns + '">' + cols + '<sheetData>' + body + '</sheetData></worksheet>'],
    ];
    return zip(files.map(function (file) { return { name: file[0], data: utf8(file[1]) }; }));
  }

  function getPath(value, path) {
    return String(path || '').split('.').filter(Boolean).reduce(function (current, key) {
      return current != null && typeof current === 'object' ? current[key] : undefined;
    }, value);
  }

  // 消除浮点误差（0.1 * 3 → 0.3）
  function tidy(number) {
    return Math.round(number * 1e10) / 1e10;
  }

  // 按模板的 export.xlsx 配置，把页面数据变成表格：表头 + 明细行 + 可选的合计行。
  function exportTable(data, spec) {
    var list = getPath(data, spec.rows);
    var items = Array.isArray(list) ? list : [];
    var columns = spec.columns || [];
    var header = columns.map(function (column) { return column.header || column.field || ''; });
    var rows = items.map(function (item) {
      return columns.map(function (column) {
        if (column.product) {
          var factors = column.product.map(function (field) { return getPath(item, field); });
          if (!factors.every(function (n) { return typeof n === 'number' && isFinite(n); })) return null;
          return tidy(factors.reduce(function (a, b) { return a * b; }, 1));
        }
        var value = getPath(item, column.field);
        return value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
      });
    });
    var table = { sheet: spec.sheet, rows: [header].concat(rows), boldRows: [0] };
    if (columns.some(function (column) { return column.total; })) {
      var totals = columns.map(function (column, c) {
        if (!column.total) return c === 0 ? '合计' : null;
        return tidy(rows.reduce(function (sum, row) { return sum + (typeof row[c] === 'number' ? row[c] : 0); }, 0));
      });
      table.rows.push(totals);
      table.boldRows.push(table.rows.length - 1);
    }
    return table;
  }

  var api = { buildXlsx: buildXlsx, exportTable: exportTable, crc32: crc32 };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DviewXlsx = api;
})(typeof window !== 'undefined' ? window : this);

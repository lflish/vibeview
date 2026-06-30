// 图片/视频预览的包裹页：深色背景居中展示，原始文件经 /v/:id/raw 引用

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function page(title, bodyInner) {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  html,body{margin:0;height:100%;background:#1a1a1a;}
  body{display:flex;align-items:center;justify-content:center;}
  img,video{max-width:100%;max-height:100vh;object-fit:contain;}
</style>
</head>
<body>
${bodyInner}
</body>
</html>`;
}

function renderImage(id, filename) {
  const src = `/v/${id}/raw`;
  return page(filename, `<img src="${src}" alt="${escapeHtml(filename)}">`);
}

function renderVideo(id, filename) {
  const src = `/v/${id}/raw`;
  return page(filename, `<video src="${src}" controls autoplay></video>`);
}

module.exports = { renderImage, renderVideo };

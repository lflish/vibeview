// vibeview 管理端页面脚本：资源列表、筛选、访问码与账户管理。
(function () {
  const PAGE_SIZE = 20;
  const TYPE_LABEL = { html: 'HTML', image: '图片', video: '视频' };
  const CATEGORY_LABEL = {
    doc: '开发文档', report: '报告', dashboard: '数据看板', prototype: '原型', game: '游戏',
    slides: '幻灯片', tool: '工具', demo: '演示', screenshot: '截图', other: '其他',
  };
  const facetFilters = { category: '', project: '', agent: '', tag: '' };
  let categories = Object.keys(CATEGORY_LABEL);

  let allItems = [];
  let typeFilter = '';
  let sourceFilter = '';
  let visitFilter = '';
  let visitsAvailable = true;
  let visitsSince = '';
  let query = '';
  let sortKey = 'time-desc';
  let page = 1;
  let totalItems = 0;
  let totalPages = 1;
  let requestSeq = 0;
  let pendingDelete = null;
  const selectedIds = new Set();

  const $ = (id) => document.getElementById(id);
  const el = {
    loading: $('loading'),
    error: $('error'),
    errorMsg: $('error-msg'),
    empty: $('empty'),
    emptyFilter: $('empty-filter'),
    tableWrap: $('table-wrap'),
    rows: $('rows'),
    pager: $('pager'),
    pagerInfo: $('pager-info'),
    pageNum: $('page-num'),
    prev: $('prev'),
    next: $('next'),
    stats: $('stats'),
    hdrCount: $('hdr-count'),
    q: $('q'),
    qClear: $('q-clear'),
    searchWrap: $('search-wrap'),
    sourceFilter: $('source-filter'),
    sort: $('sort'),
    toasts: $('toasts'),
    delModal: $('del-modal'),
    delBody: $('del-body'),
    delOk: $('del-ok'),
    delCancel: $('del-cancel'),
    selectAll: $('select-all'),
    selectedCount: $('selected-count'),
    bulkDelete: $('btn-bulk-delete'),
    bulkBar: $('bulk-bar'),
    clearFilters: $('btn-clear-filters'),
  };

  function fmtSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function fmtTime(s) {
    try {
      return new Date(s).toLocaleString('zh-CN', { hour12: false });
    } catch {
      return s || '-';
    }
  }
  // 列表里用短日期：同年省略年份，完整时间放在 title 中。
  function fmtShort(s) {
    const d = new Date(s);
    if (!Number.isFinite(d.getTime())) return '-';
    const pad = (n) => String(n).padStart(2, '0');
    const day = (d.getMonth() + 1) + '月' + d.getDate() + '日';
    const year = d.getFullYear() === new Date().getFullYear() ? '' : d.getFullYear() + '年';
    return year + day + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fmtAge(s) {
    const created = new Date(s).getTime();
    if (!Number.isFinite(created)) return '时间未知';
    const seconds = Math.max(0, Math.floor((Date.now() - created) / 1000));
    if (seconds < 60) return '刚刚创建';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return '已持续 ' + minutes + ' 分钟';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return '已持续 ' + hours + ' 小时';
    const days = Math.floor(hours / 24);
    if (days < 30) return '已持续 ' + days + ' 天';
    const months = Math.floor(days / 30);
    if (months < 12) return '已持续 ' + months + ' 个月';
    return '已持续 ' + Math.floor(months / 12) + ' 年';
  }
  function updateAges() {
    document.querySelectorAll('[data-created-at]').forEach((node) => {
      node.textContent = fmtAge(node.dataset.createdAt);
    });
  }

  function toast(msg, kind) {
    const t = document.createElement('div');
    t.className = 'toast ' + (kind || 'info');
    t.textContent = msg;
    el.toasts.appendChild(t);
    setTimeout(() => {
      t.style.opacity = '0';
      t.style.transition = 'opacity .25s';
      setTimeout(() => t.remove(), 250);
    }, 2600);
  }

  function showOnly(which) {
    ['loading', 'error', 'empty', 'emptyFilter', 'tableWrap', 'pager'].forEach((k) => {
      const node = el[k];
      if (!node) return;
      const on = which === k || (which === 'table' && (k === 'tableWrap' || k === 'pager'));
      node.classList.toggle('hidden', !on);
    });
  }

  function updateSourceOptions(sources) {
    sources = Array.isArray(sources) ? sources : [];
    const cur = el.sourceFilter.value;
    el.sourceFilter.replaceChildren(new Option('全部', ''));
    for (const s of sources) el.sourceFilter.appendChild(new Option(s, s));
    if (sources.includes(cur)) el.sourceFilter.value = cur;
    else {
      sourceFilter = '';
      el.sourceFilter.value = '';
    }
    syncFilterUi();
  }

  // 有值的筛选框高亮，并在有任何筛选时显示「清除筛选」。
  function hasActiveFilter() {
    return !!(typeFilter || sourceFilter || visitFilter || query.trim() || Object.values(facetFilters).some(Boolean));
  }
  function syncFilterUi() {
    document.querySelectorAll('.filter-row select').forEach((select) => {
      select.closest('.select-wrap').classList.toggle('on', !!select.value);
    });
    document.querySelectorAll('#type-filters .chip').forEach((chip) => {
      chip.setAttribute('aria-pressed', String((chip.dataset.type || '') === typeFilter));
    });
    el.clearFilters.classList.toggle('hidden', !hasActiveFilter());
    const facetCount = [sourceFilter, visitFilter, ...Object.values(facetFilters)].filter(Boolean).length;
    renderProjectNav();
    $('filter-count').textContent = facetCount ? String(facetCount) : '';
  }
  $('btn-filters').addEventListener('click', () => {
    const open = $('btn-filters').closest('.toolbar').classList.toggle('filters-open');
    $('btn-filters').setAttribute('aria-expanded', String(open));
  });

  function categoryLabel(value) {
    return value ? (CATEGORY_LABEL[value] || value) : '未分类';
  }

  // 下拉框选项来自服务端 facet 计数；当前选中的值即使已无数据也保留，避免筛选被悄悄清掉。
  function updateFacetOptions(facets) {
    facets = facets || {};
    document.querySelectorAll('select.facet').forEach((select) => {
      const key = select.dataset.facet;
      const current = facetFilters[key];
      let rows = Array.isArray(facets[key]) ? facets[key].slice() : [];
      if (key === 'category') {
        const counts = new Map(rows.map((row) => [row.value, row.count]));
        rows = [''].concat(categories).filter((value) => counts.has(value) || value === current)
          .map((value) => ({ value, count: counts.get(value) || 0 }));
      } else {
        const unset = rows.find((row) => !row.value);
        rows = rows.filter((row) => row.value);
        if (key === 'project' && ((unset && unset.count) || current === '-')) rows.push({ value: '-', count: unset ? unset.count : 0 });
        if (current && !rows.some((row) => row.value === current)) rows.unshift({ value: current, count: 0 });
      }
      select.replaceChildren(new Option('全部', ''));
      for (const row of rows) {
        const value = key === 'category' && !row.value ? 'none' : row.value;
        const text = key === 'category' ? categoryLabel(row.value) : key === 'tag' ? '#' + row.value
          : key === 'project' && row.value === '-' ? '未设置项目' : row.value;
        select.appendChild(new Option(text + ' (' + row.count + ')', value));
      }
      select.value = current;
      select.closest('.select-wrap').classList.toggle('hidden', rows.length === 0 && !current);
    });
    syncFilterUi();
  }

  // 项目导航：把项目当作「目录」使用，数据来自全量 facet 计数。
  let projectFacet = [];
  function renderProjectNav() {
    const nav = $('project-nav');
    const named = projectFacet.filter((row) => row.value);
    const unset = projectFacet.find((row) => !row.value);
    const current = facetFilters.project;
    if (!named.length && current !== '-') { nav.classList.add('hidden'); return; }
    nav.classList.remove('hidden');
    nav.replaceChildren();
    const title = document.createElement('span');
    title.className = 'nav-title';
    title.innerHTML = icon('folder', 13);
    title.appendChild(document.createTextNode('项目'));
    nav.appendChild(title);
    const total = projectFacet.reduce((n, row) => n + row.count, 0);
    const chip = (value, text, count, cls) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'project-chip' + (cls ? ' ' + cls : '');
      b.setAttribute('aria-pressed', String(current === value));
      b.appendChild(document.createTextNode(text));
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = String(count);
      b.appendChild(n);
      b.onclick = () => setFacet('project', current === value ? '' : value);
      nav.appendChild(b);
    };
    chip('', '全部', total);
    for (const row of named) chip(row.value, row.value, row.count);
    if ((unset && unset.count) || current === '-') chip('-', '未设置项目', unset ? unset.count : 0, 'none');
  }

  function fmtAgo(s) {
    const t = new Date(s).getTime();
    if (!Number.isFinite(t)) return '';
    const minutes = Math.max(0, Math.floor((Date.now() - t) / 60000));
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return minutes + ' 分钟前';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + ' 小时前';
    const days = Math.floor(hours / 24);
    if (days < 30) return days + ' 天前';
    const months = Math.floor(days / 30);
    return months < 12 ? months + ' 个月前' : Math.floor(months / 12) + ' 年前';
  }
  function viewsCell(it) {
    const box = document.createElement('div');
    box.className = 'views-cell';
    const v = it.visits;
    if (!v) { box.textContent = '-'; return box; }
    if (!v.views && visitsSince && String(it.createdAt || '') < visitsSince) {
      const unknown = document.createElement('span');
      unknown.className = 'last';
      unknown.textContent = '暂无记录';
      unknown.title = '访问统计从 ' + fmtTime(visitsSince) + ' 开始，此前的打开无法补录';
      box.appendChild(unknown);
      return box;
    }
    if (!v.views) {
      const never = document.createElement('span');
      never.className = 'never';
      never.textContent = '从未打开';
      never.title = '不含管理员自己的预览和链接预览爬虫';
      box.appendChild(never);
      return box;
    }
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = v.views.toLocaleString('zh-CN') + ' 次';
    const last = document.createElement('span');
    last.className = 'last';
    last.textContent = fmtAgo(v.lastViewedAt);
    last.title = '最后打开 ' + fmtTime(v.lastViewedAt) + (v.firstViewedAt ? '\n首次打开 ' + fmtTime(v.firstViewedAt) : '');
    box.append(count, last);
    return box;
  }
  function syncVisitsUi() {
    $('visit-filter-wrap').classList.toggle('hidden', !visitsAvailable);
    document.querySelectorAll('#sort option[data-visits]').forEach((option) => { option.hidden = !visitsAvailable; });
    document.querySelectorAll('.views-col').forEach((node) => node.classList.toggle('hidden', !visitsAvailable));
  }

  function setFacet(key, value) {
    facetFilters[key] = value;
    const select = document.querySelector('select.facet[data-facet="' + key + '"]');
    if (select) select.value = value;
    page = 1;
    load();
  }

  function labelsLine(it) {
    const line = document.createElement('div');
    line.className = 'labels';
    const chip = (cls, text, title, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'label-chip ' + cls;
      b.textContent = text;
      b.title = title;
      b.onclick = onClick;
      line.appendChild(b);
      return b;
    };
    if (it.category) chip('cat cat-' + it.category, categoryLabel(it.category), '只看「' + categoryLabel(it.category) + '」', () => setFacet('category', it.category));
    else chip('cat none', '未分类', '设置分类', () => openLabels(it));
    if (it.project) chip('', it.project, '只看项目 ' + it.project, () => setFacet('project', it.project)).insertAdjacentHTML('afterbegin', icon('folder', 11));
    if (it.agent) {
      const b = chip('', it.agent, '只看 agent ' + it.agent + (it.model ? '（模型 ' + it.model + '）' : ''), () => setFacet('agent', it.agent));
      b.insertAdjacentHTML('afterbegin', icon('bot', 11));
      if (it.model) {
        const k = document.createElement('span');
        k.className = 'k';
        k.textContent = '· ' + it.model;
        b.appendChild(k);
      }
    }
    for (const tag of it.tags || []) chip('tagchip', tag, '只看标签 #' + tag, () => setFacet('tag', tag));
    return line;
  }

  function syncSortHeaders() {
    const [field, dir] = sortKey.split('-');
    document.querySelectorAll('th.sortable').forEach((th) => {
      const on = th.dataset.sort === field;
      const arrow = th.querySelector('.arrow');
      th.classList.toggle('sorted', on);
      th.setAttribute('aria-sort', on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none');
      if (arrow) arrow.textContent = on ? (dir === 'asc' ? '↑' : '↓') : '↕';
    });
  }

  async function copyText(text, message) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        // Plain-HTTP deployments have no async clipboard API.
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        const copied = document.execCommand('copy');
        ta.remove();
        if (!copied) throw new Error('copy failed');
      }
      toast(message || '已复制', 'ok');
      return true;
    } catch {
      toast('复制失败，请手动复制', 'err');
      return false;
    }
  }
  const copyUrl = (url, message) => copyText(url, message || '预览链接已复制');

  const ICONS = {
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 3.5v.5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M3 3l18 18M10.6 5.1A10.6 10.6 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.1 3.9M6.6 6.6C3.9 8.3 2 12 2 12s3.6 7 10 7c1.8 0 3.4-.5 4.7-1.3M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    share: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    link: '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 14.1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 2.9-1.2V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.1a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    trash: '<path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
    open: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    hash: '<path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 13v1m6-1v1"/>',
    html: '<path d="m8 8-4 4 4 4m8-8 4 4-4 4M14 5l-4 14"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
    video: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>',
  };
  function icon(name, size) {
    const n = size || 14;
    return '<svg width="' + n + '" height="' + n + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + '</svg>';
  }
  function fmtRemaining(iso) {
    const ms = Date.parse(iso) - Date.now();
    if (!Number.isFinite(ms) || ms <= 0) return '已过期';
    const hours = ms / 3600000;
    if (hours < 1) return '剩 ' + Math.max(1, Math.ceil(ms / 60000)) + ' 分钟';
    if (hours < 24) return '剩 ' + Math.ceil(hours) + ' 小时';
    return '剩 ' + Math.ceil(hours / 24) + ' 天';
  }
  // Fetched on demand and never cached, so a reset elsewhere is never shared stale.
  async function fetchAccessCode(it) {
    const r = await fetch('/admin/api/item/' + encodeURIComponent(it.id) + '/access-code', { cache: 'no-store' });
    if (r.status === 401) { location.href = '/admin/login'; return null; }
    const data = await r.json().catch(() => ({}));
    if (data.access) it.access = data.access;
    return r.ok ? data.accessCode : null;
  }
  function shareText(it, code) {
    const access = it.access || {};
    // Lead with the page's own summary so the recipient knows what they are opening.
    const summary = String(it.description || '').replace(/\s+/g, ' ').trim();
    const intro = summary ? (summary.length > 80 ? summary.slice(0, 79) + '…' : summary) : (it.filename || it.id);
    const lines = [intro, '链接：' + it.url];
    if (code) {
      lines.push('访问码：' + code);
      lines.push('有效期至：' + (access.expiresAt ? fmtTime(access.expiresAt) : '不过期'));
    } else lines.push('公开访问，无需访问码');
    return lines.join('\n');
  }
  async function shareItem(it) {
    const access = it.access || { required: true };
    if (!access.required) return copyText(shareText(it), '分享信息已复制（公开访问）');
    const code = access.configured && !access.expired ? await fetchAccessCode(it) : null;
    if (code) return copyText(shareText(it, code), '链接和访问码已复制');
    // No readable code: send the user straight to generating one.
    openAccess(it);
    toast(access.expired ? '访问码已过期，请重新生成后分享' : '当前访问码无法查看，请重新生成后分享', 'info');
  }

  let menuEl = null;
  let menuOpener = null;
  function closeMenu(restoreFocus) {
    if (!menuEl) return;
    menuEl.remove();
    menuEl = null;
    if (menuOpener) {
      menuOpener.setAttribute('aria-expanded', 'false');
      if (restoreFocus && menuOpener.isConnected) menuOpener.focus();
    }
    menuOpener = null;
  }
  function openMenu(it, opener) {
    if (menuOpener === opener) return closeMenu(true);
    closeMenu(false);
    menuOpener = opener;
    opener.setAttribute('aria-expanded', 'true');
    menuEl = document.createElement('div');
    menuEl.className = 'row-menu';
    menuEl.setAttribute('role', 'menu');
    const entries = [
      ['open', '打开预览', () => window.open(it.url, '_blank', 'noopener')],
      ['link', '仅复制链接', () => copyUrl(it.url)],
      ['hash', '复制 ID', () => copyText(it.id, 'ID 已复制')],
      null,
      ['settings', '访问设置…', () => openAccess(it)],
      ['tag', '编辑分类…', () => openLabels(it)],
      null,
      ['trash', '删除…', () => openDelete(it), 'danger'],
    ];
    for (const entry of entries) {
      if (!entry) { menuEl.appendChild(document.createElement('hr')); continue; }
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      if (entry[3]) b.className = entry[3];
      b.innerHTML = icon(entry[0]);
      b.appendChild(document.createTextNode(entry[1]));
      b.onclick = () => { closeMenu(false); entry[2](); };
      menuEl.appendChild(b);
    }
    document.body.appendChild(menuEl);
    const r = opener.getBoundingClientRect();
    const w = menuEl.offsetWidth, h = menuEl.offsetHeight;
    menuEl.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + 'px';
    menuEl.style.top = (r.bottom + 6 + h > innerHeight ? r.top - h - 6 : r.bottom + 6) + 'px';
    menuEl.querySelector('button').focus();
    menuEl.addEventListener('keydown', (event) => {
      const items = [...menuEl.querySelectorAll('button')];
      const i = items.indexOf(document.activeElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        items[(i + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
      } else if (event.key === 'Tab') closeMenu(false);
    });
  }
  document.addEventListener('mousedown', (event) => {
    if (menuEl && !menuEl.contains(event.target) && event.target !== menuOpener && !menuOpener.contains(event.target)) closeMenu(false);
  });
  window.addEventListener('scroll', () => closeMenu(false), true);
  window.addEventListener('resize', () => closeMenu(false));

  function openDelete(it) {
    pendingDelete = it;
    el.delBody.textContent = '确定删除「' + (it.filename || it.id) + '」？此操作不可恢复。';
    el.delModal.classList.remove('hidden');
    el.delOk.focus();
  }
  function closeDelete() {
    pendingDelete = null;
    el.delModal.classList.add('hidden');
  }

  function updateSelectionUi() {
    const checks = [...el.rows.querySelectorAll('.row-check')];
    const selectedOnPage = checks.filter((node) => selectedIds.has(node.dataset.id)).length;
    el.selectedCount.textContent = selectedIds.size ? '已选 ' + selectedIds.size + ' 项' : '';
    el.bulkDelete.disabled = selectedIds.size === 0;
    el.bulkBar.classList.toggle('hidden', selectedIds.size === 0);
    el.selectAll.checked = checks.length > 0 && selectedOnPage === checks.length;
    el.selectAll.indeterminate = selectedOnPage > 0 && selectedOnPage < checks.length;
    for (const node of checks) node.closest('tr').classList.toggle('selected', selectedIds.has(node.dataset.id));
  }

  function openBulkDelete() {
    if (!selectedIds.size) return;
    pendingDelete = { bulk: true, ids: [...selectedIds] };
    el.delBody.textContent = '确定删除当前选中的 ' + selectedIds.size + ' 项？此操作不可恢复。';
    el.delModal.classList.remove('hidden');
    el.delOk.focus();
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const it = pendingDelete;
    const isBulk = !!it.bulk;
    el.delOk.disabled = true;
    try {
      const options = isBulk
        ? {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: it.ids }),
          }
        : { method: 'DELETE' };
      const r = await fetch(isBulk ? '/admin/api/items' : '/admin/api/item/' + encodeURIComponent(it.id), options);
      if (r.status === 401) {
        toast('登录已过期，请重新登录', 'err');
        setTimeout(() => { location.href = '/admin/login'; }, 800);
        return;
      }
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) throw new Error(data.error || '删除失败');
      closeDelete();
      if (isBulk) {
        selectedIds.clear();
        toast('已删除 ' + (data.deleted || 0) + ' 项', 'ok');
      } else {
        toast('已删除 ' + (it.filename || it.id), 'ok');
      }
      load();
    } catch (e) {
      toast(e.message || '删除失败', 'err');
    } finally {
      el.delOk.disabled = false;
    }
  }

  function rowFor(it) {
    const tr = document.createElement('tr');
    tr.dataset.id = it.id;
    const cell = (cls) => {
      const td = document.createElement('td');
      if (cls) td.className = cls;
      tr.appendChild(td);
      return td;
    };

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'row-check';
    check.dataset.id = it.id;
    check.checked = selectedIds.has(it.id);
    check.setAttribute('aria-label', '选择 ' + (it.filename || it.id));
    check.addEventListener('change', () => {
      if (check.checked) selectedIds.add(it.id);
      else selectedIds.delete(it.id);
      updateSelectionUi();
    });
    cell('check-col').appendChild(check);

    const res = document.createElement('div');
    res.className = 'res';
    const tile = document.createElement('span');
    tile.className = 'type-tile ' + (it.type || '');
    tile.title = TYPE_LABEL[it.type] || it.type || '';
    tile.innerHTML = icon(ICONS[it.type] ? it.type : 'html', 18);
    const body = document.createElement('div');
    body.className = 'res-body';
    const title = document.createElement('div');
    title.className = 'res-title';
    const a = document.createElement('a');
    a.href = it.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = it.filename || '(无文件名)';
    a.title = (it.filename || '') + '\nID ' + it.id + '\n在新标签页打开预览';
    title.appendChild(a);
    const description = document.createElement('span');
    description.className = 'description' + (it.description ? '' : ' empty');
    description.textContent = it.description || '暂无简介';
    description.title = it.description || '';
    body.append(title, description, labelsLine(it));
    res.append(tile, body);
    cell('res-col').appendChild(res);

    cell('access-col').appendChild(accessCell(it));
    const tdViews = cell('num views-col');
    tdViews.appendChild(viewsCell(it));
    if (!visitsAvailable) tdViews.classList.add('hidden');

    const tdSrc = cell('source');
    tdSrc.textContent = it.source || '-';
    tdSrc.title = it.source ? '来源账户 ' + it.source : '';

    cell('size num').textContent = fmtSize(it.size);

    const tdTime = cell('time');
    const created = document.createElement('span');
    created.className = 'created';
    created.textContent = fmtShort(it.createdAt);
    created.title = fmtTime(it.createdAt);
    const age = document.createElement('span');
    age.className = 'age';
    age.dataset.createdAt = it.createdAt || '';
    age.textContent = fmtAge(it.createdAt);
    tdTime.append(created, age);

    // 窄屏卡片布局用：来源 · 大小 · 时间合并为一行
    const before = visitsSince && String(it.createdAt || '') < visitsSince;
    const opened = !visitsAvailable || !it.visits ? '' : it.visits.views ? '打开 ' + it.visits.views + ' 次' : before ? '' : '从未打开';
    cell('meta-col').textContent = [it.source, fmtSize(it.size), fmtShort(it.createdAt), opened].filter(Boolean).join(' · ');

    const ops = document.createElement('div');
    ops.className = 'ops';
    const btnShare = document.createElement('button');
    btnShare.type = 'button';
    btnShare.className = 'btn btn-sm btn-share';
    btnShare.innerHTML = icon('share', 13);
    btnShare.appendChild(document.createTextNode('复制分享'));
    btnShare.title = '复制简介、链接、访问码和有效期，可直接发送';
    btnShare.onclick = () => shareItem(it);
    const btnMore = document.createElement('button');
    btnMore.type = 'button';
    btnMore.className = 'btn btn-quiet btn-more';
    btnMore.textContent = '⋯';
    btnMore.setAttribute('aria-label', '更多操作：' + (it.filename || it.id));
    btnMore.setAttribute('aria-haspopup', 'menu');
    btnMore.setAttribute('aria-expanded', 'false');
    btnMore.onclick = () => openMenu(it, btnMore);
    ops.append(btnShare, btnMore);
    cell('ops-col').appendChild(ops);

    return tr;
  }

  function accessCell(it) {
    const cell = document.createElement('div');
    cell.className = 'access-cell';
    const access = it.access || { required: true, configured: false };
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.title = '访问设置';
    badge.onclick = () => openAccess(it);
    const state = !access.required ? ['public', 'globe', '公开', '']
      : !access.configured ? ['pending', 'clock', '待生成', '']
      : access.expired ? ['expired', 'alert', '已过期', '']
      : ['ok', 'lock', '访问码', access.expiresAt ? fmtRemaining(access.expiresAt) : '不过期'];
    badge.className = 'access-badge ' + state[0];
    badge.innerHTML = icon(state[1], 12);
    badge.appendChild(document.createTextNode(state[2]));
    if (state[3]) {
      const sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = '· ' + state[3];
      badge.appendChild(sub);
    }
    if (access.expiresAt) badge.title = '到期 ' + fmtTime(access.expiresAt) + '，点击修改访问设置';
    badge.setAttribute('aria-label', '访问状态：' + badge.textContent + '，打开访问设置');
    cell.appendChild(badge);

    if (access.required && access.configured && !access.expired) {
      if (access.recoverable) {
        const line = document.createElement('span');
        line.className = 'access-code';
        const value = document.createElement('span');
        value.className = 'value';
        value.textContent = '••••••••';
        const eye = document.createElement('button');
        eye.type = 'button';
        eye.className = 'icon-btn';
        eye.innerHTML = icon('eye');
        eye.setAttribute('aria-label', '显示访问码');
        eye.title = '显示访问码';
        let shown = false;
        eye.onclick = async () => {
          if (shown) {
            shown = false;
            value.textContent = '••••••••';
          } else {
            const code = await fetchAccessCode(it);
            if (!code) return toast('访问码无法查看，请重新生成', 'err');
            shown = true;
            value.textContent = code;
          }
          eye.innerHTML = icon(shown ? 'eyeOff' : 'eye');
          eye.setAttribute('aria-label', shown ? '隐藏访问码' : '显示访问码');
          eye.title = shown ? '隐藏访问码' : '显示访问码';
        };
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'icon-btn';
        copy.innerHTML = icon('copy');
        copy.setAttribute('aria-label', '复制访问码');
        copy.title = '复制访问码';
        copy.onclick = async () => {
          const code = await fetchAccessCode(it);
          if (code) copyText(code, '访问码已复制');
          else toast('访问码无法查看，请重新生成', 'err');
        };
        line.append(value, eye, copy);
        cell.appendChild(line);
      } else {
        const note = document.createElement('span');
        note.className = 'access-note';
        note.textContent = '旧访问码无法查看 · ';
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'link-btn';
        link.textContent = '重新生成';
        link.onclick = () => openAccess(it);
        note.appendChild(link);
        cell.appendChild(note);
      }
    }
    return cell;
  }

  let accessItem = null;
  let accessBusy = false;
  let accessOpener = null;
  function syncAccessFields() {
    const required = $('access-mode').value === 'code';
    $('access-settings').classList.toggle('hidden', !required);
    $('access-reset').classList.toggle('hidden', !required);
    $('access-until').classList.toggle('hidden', $('access-ttl').value !== 'custom');
    $('access-until').required = required && $('access-ttl').value === 'custom';
  }
  function openAccess(it) {
    accessItem = it;
    accessOpener = document.activeElement;
    $('access-name').textContent = it.filename || it.id;
    const access = it.access || { required: true, configured: false };
    $('access-mode').value = access.required ? 'code' : 'public';
    $('access-ttl').value = !access.configured ? '7' : access.expiresAt ? 'custom' : 'none';
    if (access.expiresAt) {
      const date = new Date(access.expiresAt);
      $('access-until').value = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    } else $('access-until').value = '';
    $('access-code').value = '';
    $('access-error').textContent = '';
    $('access-result').classList.add('hidden');
    syncAccessFields();
    setAccessHint(access);
    $('access-modal').classList.remove('hidden');
    $('access-mode').focus();
    if (access.required && access.configured && !access.expired && access.recoverable) {
      fetchAccessCode(it).then((code) => {
        if (code && accessItem === it) showAccessCode(code, '当前访问码');
      });
    }
  }
  function setAccessHint(access) {
    $('access-hint').textContent = !access.configured ? '还没有访问码，保存设置后会生成。'
      : access.expired ? '访问码已过期。重新生成，或修改有效期后继续使用当前访问码。'
      : access.recoverable ? '访问码可随时在这里查看和复制；重置后旧访问码立即失效。'
      : '此访问码在升级前生成，无法查看。重置访问码后即可随时查看和复制。';
  }
  function showAccessCode(code, label) {
    $('access-code-label').textContent = label;
    $('access-code').value = code;
    $('access-result').classList.remove('hidden');
  }
  function closeAccess() {
    if (accessBusy) return;
    $('access-modal').classList.add('hidden');
    $('access-code').value = '';
    accessItem = null;
    if (accessOpener && accessOpener.isConnected) accessOpener.focus();
  }
  async function saveAccess(reset) {
    if (!accessItem || accessBusy) return;
    accessBusy = true;
    $('access-save').disabled = $('access-reset').disabled = true;
    $('access-error').textContent = '';
    try {
      const ttl = $('access-ttl').value;
      const mode = $('access-mode').value;
      const expiresAt = mode === 'public' || ttl === 'none' ? null : ttl === 'custom'
        ? new Date($('access-until').value).toISOString()
        : new Date(Date.now() + Number(ttl) * 86400000).toISOString();
      const r = await fetch('/admin/api/item/' + encodeURIComponent(accessItem.id) + '/access', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, expiresAt: mode === 'code' ? expiresAt : null, reset }),
      });
      if (r.status === 401) { location.href = '/admin/login'; return; }
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || '保存失败');
      accessItem.access = data.access;
      setAccessHint(data.access);
      if (data.accessCode) showAccessCode(data.accessCode, reset ? '新访问码（旧访问码已失效）' : '新访问码');
      else if (mode === 'public') {
        $('access-code').value = '';
        $('access-result').classList.add('hidden');
      }
      else if (data.access.recoverable && $('access-result').classList.contains('hidden')) {
        const code = await fetchAccessCode(accessItem);
        if (code) showAccessCode(code, '当前访问码');
      }
      toast(mode === 'public' ? '已设为公开访问' : data.accessCode ? '新访问码已生成，请复制保存' : '访问码有效期已更新', 'ok');
      render();
    } catch (error) { $('access-error').textContent = error.message || '保存失败'; }
    finally { accessBusy = false; $('access-save').disabled = $('access-reset').disabled = false; }
  }
  $('access-form').addEventListener('submit', event => { event.preventDefault(); saveAccess(false); });
  $('access-reset').addEventListener('click', () => { if ($('access-form').reportValidity()) saveAccess(true); });
  $('access-close').addEventListener('click', closeAccess);
  $('access-mode').addEventListener('change', syncAccessFields);
  $('access-ttl').addEventListener('change', syncAccessFields);
  $('access-copy').addEventListener('click', () => copyText($('access-code').value, '访问码已复制'));
  $('access-share').addEventListener('click', () => {
    if (accessItem) copyText(shareText(accessItem, $('access-code').value), '链接和访问码已复制');
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (menuEl) closeMenu(true);
    else if (!$('access-modal').classList.contains('hidden')) closeAccess();
  });

  let labelsItem = null;
  let labelsOpener = null;
  function openLabels(it) {
    labelsItem = it;
    labelsOpener = document.activeElement;
    $('labels-name').textContent = it.filename || it.id;
    const select = $('labels-category');
    select.replaceChildren(new Option('未分类', ''));
    for (const value of categories) select.appendChild(new Option(categoryLabel(value) + ' · ' + value, value));
    select.value = it.category || '';
    $('labels-project').value = it.project || '';
    $('labels-agent').value = it.agent || '';
    $('labels-model').value = it.model || '';
    $('labels-tags').value = (it.tags || []).join(', ');
    $('labels-description').value = it.description || '';
    $('labels-error').textContent = '';
    $('labels-modal').classList.remove('hidden');
    select.focus();
  }
  function closeLabels() {
    $('labels-modal').classList.add('hidden');
    labelsItem = null;
    if (labelsOpener && labelsOpener.isConnected) labelsOpener.focus();
  }
  $('labels-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!labelsItem) return;
    const save = $('labels-save');
    save.disabled = true;
    $('labels-error').textContent = '';
    try {
      const body = {
        category: $('labels-category').value,
        project: $('labels-project').value,
        agent: $('labels-agent').value,
        model: $('labels-model').value,
        tags: $('labels-tags').value,
      };
      // 简介未改动时不提交，避免把页面标题回填值固化为手写简介
      if ($('labels-description').value.trim() !== (labelsItem.description || '')) body.description = $('labels-description').value;
      const r = await fetch('/admin/api/item/' + encodeURIComponent(labelsItem.id) + '/meta', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (r.status === 401) { location.href = '/admin/login'; return; }
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || '保存失败');
      closeLabels();
      toast('分类已更新', 'ok');
      load();
    } catch (error) {
      $('labels-error').textContent = error.message || '保存失败';
    } finally {
      save.disabled = false;
    }
  });
  $('labels-cancel').addEventListener('click', closeLabels);
  $('labels-modal').addEventListener('click', (event) => { if (event.target === $('labels-modal')) closeLabels(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('labels-modal').classList.contains('hidden')) closeLabels();
  });

  let bulkOpener = null;
  function openBulkLabels() {
    if (!selectedIds.size) return;
    bulkOpener = document.activeElement;
    $('bulk-name').textContent = '应用到已选的 ' + selectedIds.size + ' 项；留空的字段保持不变。';
    const select = $('bulk-category');
    select.replaceChildren(new Option('保持不变', '__keep'), new Option('未分类', ''));
    for (const value of categories) select.appendChild(new Option(categoryLabel(value) + ' · ' + value, value));
    $('bulk-project').value = '';
    $('bulk-tags').value = '';
    $('bulk-error').textContent = '';
    $('bulk-modal').classList.remove('hidden');
    select.focus();
  }
  function closeBulkLabels() {
    $('bulk-modal').classList.add('hidden');
    if (bulkOpener && bulkOpener.isConnected) bulkOpener.focus();
  }
  $('bulk-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = { ids: [...selectedIds] };
    if ($('bulk-category').value !== '__keep') body.category = $('bulk-category').value;
    if ($('bulk-project').value.trim()) body.project = $('bulk-project').value;
    if ($('bulk-tags').value.trim()) body.addTags = $('bulk-tags').value;
    if (Object.keys(body).length === 1) {
      $('bulk-error').textContent = '请至少修改一项';
      return;
    }
    const save = $('bulk-save');
    save.disabled = true;
    try {
      const r = await fetch('/admin/api/items/meta', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (r.status === 401) { location.href = '/admin/login'; return; }
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || '保存失败');
      closeBulkLabels();
      selectedIds.clear();
      toast('已更新 ' + (data.updated || 0) + ' 项', 'ok');
      load();
    } catch (error) {
      $('bulk-error').textContent = error.message || '保存失败';
    } finally {
      save.disabled = false;
    }
  });
  $('btn-bulk-labels').addEventListener('click', openBulkLabels);
  $('bulk-cancel').addEventListener('click', closeBulkLabels);
  $('bulk-modal').addEventListener('click', (event) => { if (event.target === $('bulk-modal')) closeBulkLabels(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('bulk-modal').classList.contains('hidden')) closeBulkLabels();
  });

  function render() {
    const list = allItems;
    const totalAll = totalItems;
    updateSelectionUi();
    el.hdrCount.textContent = totalAll ? totalAll + ' 项' : '';

    const hasFilter = hasActiveFilter();
    syncFilterUi();
    if (!totalAll && !hasFilter) {
      showOnly('empty');
      el.stats.textContent = '';
      syncSortHeaders();
      return;
    }
    if (!list.length) {
      showOnly('emptyFilter');
      el.stats.textContent = '0 / ' + totalAll;
      syncSortHeaders();
      return;
    }

    el.rows.replaceChildren();
    for (const it of list) el.rows.appendChild(rowFor(it));
    updateSelectionUi();

    el.stats.textContent = hasFilter
      ? '当前页 ' + list.length + ' / 匹配 ' + totalAll
      : '共 ' + totalAll + ' 项';
    el.pagerInfo.textContent =
      '第 ' + ((page - 1) * PAGE_SIZE + 1) + '–' + ((page - 1) * PAGE_SIZE + list.length) + ' 项，共 ' + totalAll + ' 项';
    el.pageNum.textContent = page + ' / ' + totalPages;
    el.prev.disabled = page <= 1;
    el.next.disabled = page >= totalPages;

    showOnly('table');
    syncSortHeaders();
  }

  async function load() {
    const seq = ++requestSeq;
    selectedIds.clear();
    el.rows.replaceChildren();
    updateSelectionUi();
    showOnly('loading');
    try {
      const [sort, order] = sortKey.split('-');
      const params = new URLSearchParams({
        page: String(page), pageSize: String(PAGE_SIZE), sort, order,
      });
      if (query.trim()) params.set('q', query.trim());
      if (typeFilter) params.set('type', typeFilter);
      if (sourceFilter) params.set('source', sourceFilter);
      if (visitFilter) params.set('visit', visitFilter);
      for (const [key, value] of Object.entries(facetFilters)) if (value) params.set(key, value);
      const r = await fetch('/admin/api/list?' + params.toString());
      if (seq !== requestSeq) return;
      if (r.status === 401) {
        location.href = '/admin/login';
        return;
      }
      if (!r.ok) throw new Error('请求失败 (' + r.status + ')');
      const data = await r.json();
      if (seq !== requestSeq) return;
      allItems = Array.isArray(data.items) ? data.items : [];
      selectedIds.clear();
      totalItems = Number(data.total) || 0;
      totalPages = Math.max(1, Number(data.totalPages) || 1);
      page = Math.max(1, Number(data.page) || 1);
      updateSourceOptions(data.sources);
      if (Array.isArray(data.categories) && data.categories.length) categories = data.categories;
      visitsAvailable = data.visitsAvailable !== false;
      visitsSince = data.visitsSince || '';
      projectFacet = (data.facets && Array.isArray(data.facets.project)) ? data.facets.project : [];
      syncVisitsUi();
      updateFacetOptions(data.facets);
      render();
    } catch (e) {
      if (seq !== requestSeq) return;
      el.errorMsg.textContent = e instanceof TypeError
        ? '请求失败，请检查 HTTPS 证书和网络连接后重试'
        : (e.message || '加载失败');
      showOnly('error');
    }
  }

  // events
  let qTimer = null;
  el.q.addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      query = el.q.value;
      el.searchWrap.classList.toggle('has-value', !!query);
      page = 1;
      load();
    }, 150);
  });
  el.qClear.addEventListener('click', () => {
    el.q.value = '';
    query = '';
    el.searchWrap.classList.remove('has-value');
    page = 1;
    load();
    el.q.focus();
  });

  document.getElementById('type-filters').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    typeFilter = btn.dataset.type || '';
    syncFilterUi();
    page = 1;
    load();
  });

  el.sourceFilter.addEventListener('change', () => {
    sourceFilter = el.sourceFilter.value;
    page = 1;
    load();
  });
  $('visit-filter').addEventListener('change', () => {
    visitFilter = $('visit-filter').value;
    page = 1;
    load();
  });

  document.querySelectorAll('select.facet').forEach((select) => {
    select.addEventListener('change', () => setFacet(select.dataset.facet, select.value));
  });

  el.sort.addEventListener('change', () => {
    sortKey = el.sort.value;
    page = 1;
    load();
  });

  document.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const f = th.dataset.sort;
      const [curF, curD] = sortKey.split('-');
      if (curF === f) sortKey = f + '-' + (curD === 'asc' ? 'desc' : 'asc');
      else sortKey = f + '-' + (f === 'name' || f === 'source' ? 'asc' : 'desc');
      el.sort.value = sortKey;
      page = 1;
      load();
    });
  });

  el.prev.addEventListener('click', () => { if (page > 1) { page--; load(); } });
  el.next.addEventListener('click', () => { if (page < totalPages) { page++; load(); } });
  $('btn-refresh').addEventListener('click', () => load());
  $('btn-retry').addEventListener('click', () => load());
  function resetFilters() {
    query = '';
    typeFilter = '';
    sourceFilter = '';
    visitFilter = '';
    $('visit-filter').value = '';
    el.q.value = '';
    el.searchWrap.classList.remove('has-value');
    el.sourceFilter.value = '';
    for (const key of Object.keys(facetFilters)) facetFilters[key] = '';
    document.querySelectorAll('select.facet').forEach((select) => { select.value = ''; });
    syncFilterUi();
    page = 1;
    load();
  }
  $('btn-reset-filter').addEventListener('click', resetFilters);
  el.clearFilters.addEventListener('click', resetFilters);
  $('btn-bulk-clear').addEventListener('click', () => {
    selectedIds.clear();
    el.rows.querySelectorAll('.row-check').forEach((node) => { node.checked = false; });
    updateSelectionUi();
  });

  el.delCancel.addEventListener('click', closeDelete);
  el.delOk.addEventListener('click', confirmDelete);
  el.bulkDelete.addEventListener('click', openBulkDelete);
  el.selectAll.addEventListener('change', () => {
    el.rows.querySelectorAll('.row-check').forEach((node) => {
      node.checked = el.selectAll.checked;
      if (node.checked) selectedIds.add(node.dataset.id);
      else selectedIds.delete(node.dataset.id);
    });
    updateSelectionUi();
  });
  el.delModal.addEventListener('click', (e) => {
    if (e.target === el.delModal) closeDelete();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.delModal.classList.contains('hidden')) closeDelete();
  });

  // slash to focus search
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.metaKey && !e.ctrlKey && document.activeElement !== el.q) {
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      e.preventDefault();
      el.q.focus();
    }
  });

  setInterval(updateAges, 60000);


  // ---- 账户面板 ----
  let accountsCache = [];
  let accountsDefaults = { retentionDays: 0, maxSizeMb: 50 };
  let accountsLoaded = false;

  const acctEl = {
    loading: $('acct-loading'),
    error: $('acct-error'),
    errorMsg: $('acct-error-msg'),
    empty: $('acct-empty'),
    grid: $('acct-grid'),
    stats: $('acct-stats'),
  };

  function showAcctOnly(which) {
    ['loading', 'error', 'empty', 'grid'].forEach((k) => {
      const node = acctEl[k];
      if (!node) return;
      node.classList.toggle('hidden', which !== k);
    });
  }

  function pctBar(used, limit) {
    if (!limit || limit <= 0) return '';
    const p = Math.min(100, Math.round((used / limit) * 100));
    const cls = p >= 95 ? 'danger' : p >= 80 ? 'warn' : '';
    return '<div class="bar ' + cls + '" title="' + p + '%"><i style="width:' + p + '%"></i></div>';
  }

  const PANEL_TITLE = { resources: '资源管理', accounts: '来源与账户' };
  function showPanel(which) {
    document.querySelectorAll('.tab').forEach((t) => {
      const on = t.dataset.panel === which;
      t.classList.toggle('active', on);
      if (on) t.setAttribute('aria-current', 'page');
      else t.removeAttribute('aria-current');
    });
    $('panel-resources').classList.toggle('hidden', which !== 'resources');
    $('panel-accounts').classList.toggle('hidden', which !== 'accounts');
    $('crumb-current').textContent = PANEL_TITLE[which];
    document.title = 'vibeview · ' + PANEL_TITLE[which];
    if (which === 'accounts') loadAccounts(false);
  }

  function filterByAccount(name) {
    showPanel('resources');
    history.replaceState(null, '', location.pathname);
    sourceFilter = name;
    el.sourceFilter.value = name;
    page = 1;
    load();
  }

  function renderAccounts() {
    const list = accountsCache;
    if (!list.length) {
      showAcctOnly('empty');
      acctEl.stats.textContent = '无账户';
      return;
    }
    acctEl.grid.replaceChildren();
    let totalBytes = 0;
    let totalCount = 0;
    for (const a of list) {
      totalBytes += a.bytes || 0;
      totalCount += a.count || 0;
      const card = document.createElement('div');
      card.className = 'card acct-card';

      const top = document.createElement('div');
      top.className = 'top';
      const name = document.createElement('div');
      name.className = 'name';
      const initial = document.createElement('span');
      initial.className = 'avatar';
      initial.textContent = (a.name || '?').slice(0, 1);
      name.append(initial, document.createTextNode(a.name));
      const badge = document.createElement('span');
      if (!a.configured) {
        badge.className = 'badge badge-orphan';
        badge.textContent = '已移除配置';
      } else if (a.disabled) {
        badge.className = 'badge badge-off';
        badge.textContent = '已停用';
      } else {
        badge.className = 'badge badge-ok';
        badge.textContent = '启用中';
      }
      top.appendChild(name);
      top.appendChild(badge);
      card.appendChild(top);

      const meta = document.createElement('div');
      meta.className = 'acct-meta';
      const lines = [];
      lines.push('资源 <strong>' + a.count + '</strong> 个 · <strong>' + fmtSize(a.bytes) + '</strong>');
      if (a.maxFiles != null) {
        lines.push('文件配额 ' + a.count + ' / ' + a.maxFiles);
        lines.push(pctBar(a.count, a.maxFiles));
      }
      if (a.maxStorageMb != null) {
        const lim = a.maxStorageMb * 1024 * 1024;
        lines.push('容量配额 ' + fmtSize(a.bytes) + ' / ' + a.maxStorageMb + ' MB');
        lines.push(pctBar(a.bytes, lim));
      }
      const ret = a.retentionDays != null ? a.retentionDays : accountsDefaults.retentionDays;
      lines.push('保留 ' + (ret === 0 ? '不清理' : ret + ' 天') +
        (a.retentionDays != null ? '（账户覆盖）' : '（全局）'));
      meta.innerHTML = lines.join('<br>');
      card.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'acct-actions';
      if (a.count > 0) {
        const btnFilter = document.createElement('button');
        btnFilter.type = 'button';
        btnFilter.className = 'btn btn-sm';
        btnFilter.textContent = '查看资源';
        btnFilter.onclick = () => filterByAccount(a.name);
        actions.appendChild(btnFilter);
      }
      if (a.configured) {
        const btnToggle = document.createElement('button');
        btnToggle.type = 'button';
        btnToggle.className = 'btn btn-sm ' + (a.disabled ? 'btn-accent' : 'btn-quiet');
        btnToggle.textContent = a.disabled ? '启用' : '停用';
        btnToggle.onclick = () => toggleAccount(a, btnToggle);
        actions.appendChild(btnToggle);
      }
      card.appendChild(actions);
      acctEl.grid.appendChild(card);
    }
    acctEl.stats.textContent = '每个上传 token 对应一个账户（来源）。共 ' +
      list.length + ' 个账户 · ' + totalCount + ' 项 · ' + fmtSize(totalBytes);
    showAcctOnly('grid');
  }

  async function toggleAccount(a, btn) {
    const enable = !!a.disabled;
    const path = '/admin/api/accounts/' + encodeURIComponent(a.name) + '/' + (enable ? 'enable' : 'disable');
    btn.disabled = true;
    try {
      const r = await fetch(path, { method: 'POST' });
      if (r.status === 401) {
        toast('登录已过期，请重新登录', 'err');
        setTimeout(() => { location.href = '/admin/login'; }, 800);
        return;
      }
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error(data.error || '操作失败');
      a.disabled = data.disabled;
      toast((enable ? '已启用 ' : '已停用 ') + a.name, 'ok');
      renderAccounts();
    } catch (e) {
      toast(e.message || '操作失败', 'err');
    } finally {
      btn.disabled = false;
    }
  }

  async function loadAccounts(force) {
    if (accountsLoaded && !force) {
      renderAccounts();
      return;
    }
    showAcctOnly('loading');
    try {
      const r = await fetch('/admin/api/accounts');
      if (r.status === 401) {
        location.href = '/admin/login';
        return;
      }
      if (!r.ok) throw new Error('请求失败 (' + r.status + ')');
      const data = await r.json();
      accountsCache = Array.isArray(data.accounts) ? data.accounts : [];
      accountsDefaults = data.defaults || accountsDefaults;
      accountsLoaded = true;
      // 补齐来源下拉（含尚无上传的已配置账户）
      const cur = el.sourceFilter.value;
      const fromItems = [...new Set(allItems.map((it) => it.source).filter(Boolean))];
      const fromAccts = accountsCache.map((a) => a.name);
      const sources = [...new Set(fromItems.concat(fromAccts))].sort((a, b) => a.localeCompare(b, 'zh'));
      el.sourceFilter.replaceChildren(new Option('全部', ''));
      for (const s of sources) el.sourceFilter.appendChild(new Option(s, s));
      if (sources.includes(cur)) el.sourceFilter.value = cur;
      renderAccounts();
    } catch (e) {
      acctEl.errorMsg.textContent = e.message || '加载失败';
      showAcctOnly('error');
    }
  }

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      showPanel(tab.dataset.panel);
      history.replaceState(null, '', tab.dataset.panel === 'accounts' ? '#accounts' : location.pathname);
    });
  });
  $('btn-acct-refresh').addEventListener('click', () => loadAccounts(true));
  $('btn-acct-retry').addEventListener('click', () => loadAccounts(true));

  // 统计页可带筛选跳转过来，例如 /admin#visit=never&project=vibeview
  if (location.hash.includes('=')) {
    const preset = new URLSearchParams(location.hash.slice(1));
    if (['never', 'stale30', 'recent7'].includes(preset.get('visit'))) {
      visitFilter = preset.get('visit');
      $('visit-filter').value = visitFilter;
    }
    for (const key of Object.keys(facetFilters)) if (preset.get(key)) facetFilters[key] = preset.get(key);
    history.replaceState(null, '', location.pathname);
  }

  load();
})();

function syncPanelFromHash() {
  document.querySelector('[data-panel=' + (location.hash === '#accounts' ? 'accounts' : 'resources') + ']').click();
}
if (location.hash === '#accounts') syncPanelFromHash();
window.addEventListener('hashchange', syncPanelFromHash);

// Apply before first paint; login and management share this browser preference.
(function () {
  'use strict';
  var key = 'vibeview-theme';
  var system = window.matchMedia('(prefers-color-scheme: dark)');
  var choice = 'light';
  function normalize(value) {
    return ['light', 'dark', 'system'].includes(value) ? value : 'light';
  }
  try { choice = normalize(localStorage.getItem(key)); } catch (_) {}

  var icons = {
    light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    dark: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
    system: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8m-4-4v4"/>'
  };

  function apply() {
    document.documentElement.dataset.theme = choice === 'system'
      ? (system.matches ? 'dark' : 'light') : choice;
    var select = document.getElementById('theme-select');
    if (select) select.value = choice;
    var icon = document.querySelector('.theme-picker .theme-icon');
    if (icon) {
      icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + icons[choice] + '</svg>';
    }
  }
  apply();
  system.addEventListener('change', apply);
  window.addEventListener('storage', function (event) {
    if (event.key === key || event.key === null) {
      choice = normalize(event.newValue);
      apply();
    }
  });
  document.addEventListener('DOMContentLoaded', function () {
    apply();
    var select = document.getElementById('theme-select');
    if (!select) return;
    select.addEventListener('change', function () {
      choice = normalize(select.value);
      try { localStorage.setItem(key, choice); } catch (_) {}
      apply();
    });
  });
})();

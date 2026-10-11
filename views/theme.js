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

  function apply() {
    document.documentElement.dataset.theme = choice === 'system'
      ? (system.matches ? 'dark' : 'light') : choice;
    var select = document.getElementById('theme-select');
    if (select) select.value = choice;
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

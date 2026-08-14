// Theme: system | light | dark, persisted in localStorage. Updates the
// data-theme attribute, the theme-color meta tag, and the .theme-opt buttons.

const STORAGE_KEY = 'webmcp-theme';

function resolveTheme(pref) {
  if (pref === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return pref;
}

export function applyTheme(pref) {
  localStorage.setItem(STORAGE_KEY, pref);
  const resolved = resolveTheme(pref);
  document.documentElement.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = resolved === 'light' ? '#e8ebf2' : '#0f1117';
  document.querySelectorAll('.theme-opt').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === pref);
  });
}

// Pre-paint hook: called from inline <script> in <head> to avoid theme flash.
// Returns the resolved theme name; caller sets data-theme.
export function readInitialTheme() {
  const stored = localStorage.getItem(STORAGE_KEY) || 'system';
  return resolveTheme(stored);
}

export function initTheme() {
  document.querySelectorAll('.theme-opt').forEach(btn => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (localStorage.getItem(STORAGE_KEY) === 'system') applyTheme('system');
  });
  applyTheme(localStorage.getItem(STORAGE_KEY) || 'system');
}

// Model picker and local-agent availability.
//
// There is nothing to authenticate here any more. The hosted providers are
// gone, so no key is typed into the page, none is stored, and this file no
// longer touches a credential — the daemon holds whatever auth the model needs,
// on the operator's machine. What is left is which local model to run and
// whether the daemon is actually up.

import { checkTermd } from './providers.js';

const STORAGE = { model: 'webmcp-model' };

// Credentials these pages used to hold. A returning visitor still has them in
// localStorage, where nothing reads them any more — a live API key sitting in
// origin storage with no reader is a liability, not a leftover. Drop on load.
const RETIRED_KEYS = [
  'webmcp-api-key',        // Anthropic
  'webmcp-openai-key',     // OpenAI
  'webmcp-gh-auth',        // GitHub Models (provider retired 2026-07-30)
  'webmcp-github-notice-dismissed',
  'webmcp-transport',      // the API/local toggle; only one transport now
];

let listeners = { onProviderChange: () => {} };

export function getSelectedModel() { return document.getElementById('model-select')?.value || ''; }
export function getSelectedModelName() {
  return getSelectedModel().split(':').slice(1).join(':');
}

/* The only failure mode a visitor can hit, so it gets a real message and the
 * install link rather than a silent dead Send button. */
export function isAgentReachable() { return document.body.dataset.termd === 'up'; }

export function initAuth({ onProviderChange, defaultModel = 'termd:default' }) {
  listeners.onProviderChange = onProviderChange;
  for (const k of RETIRED_KEYS) localStorage.removeItem(k);

  const modelSelect = document.getElementById('model-select');
  if (!modelSelect) return;

  checkTermd().then(up => {
    document.body.dataset.termd = up ? 'up' : 'down';
    // Static copy — it lives in the HTML so this stays a visibility toggle.
    const banner = document.getElementById('termd-status');
    if (banner) banner.hidden = up;

    // A stored id that no longer exists as an option (a retired model, or one
    // that lost its date suffix) would leave the select blank. Fall back.
    const saved = localStorage.getItem(STORAGE.model) || defaultModel;
    const known = [...modelSelect.options].some(o => o.value === saved);
    const value = known ? saved : defaultModel;
    modelSelect.value = value;
    localStorage.setItem(STORAGE.model, value);
    updateModelLabel();
    listeners.onProviderChange();
  });

  modelSelect.addEventListener('change', () => {
    localStorage.setItem(STORAGE.model, modelSelect.value);
    updateModelLabel();
    listeners.onProviderChange();
  });
}

function updateModelLabel() {
  const label = document.getElementById('chat-model-label');
  const modelSelect = document.getElementById('model-select');
  if (!label || !modelSelect) return;
  label.textContent = modelSelect.options[modelSelect.selectedIndex]?.text || '';
}

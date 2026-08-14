// WebMCP runtime — single entry. Demos call mount(config) with their
// tool definitions, system prompt, and page-context hooks; the runtime
// handles the chat panel, agent loop, providers, and trust gating.
//
// What lives where:
//   ui.js        — toast, dialogs, markdown
//   theme.js     — light/dark/system theme
//   providers.js — termd transport (bridge extension or same-origin)
//   chat.js      — message rendering, tool cards, spinner
//   auth.js      — model picker, local-agent reachability
//   tools.js     — navigator.modelContext polyfill, tools-panel sidebar
//   loop.js      — agent loop, trust gating, tool dispatch
//   source.js    — data provenance: the source bar and its system-prompt block
//
// Per-demo: HTML structure, dataset, TOOL_DEFS, render functions,
//           hash routing, init.

import { initTheme } from './theme.js';
import { initChatRefs, getChatInputEl, clearChatMessages,
         renderQuickActions, renderFollowupSuggestions, clearFollowupSuggestions,
         clearQuickActions, appendMessage, showSpinner, setInputEnabled,
         getChatMessagesEl } from './chat.js';
import { initAuth, isAgentReachable } from './auth.js';
import { registerTools, listTools, syncToolsPanel, initToolsToggle } from './tools.js';
import { runConversation } from './loop.js';
import { renderSourceBar, sourcePromptBlock } from './source.js';
import { dismissToast } from './ui.js';

/**
 * Mount the runtime against the page's chat panel.
 *
 * @param {object} cfg
 * @param {Array}  cfg.tools                 Tool definitions (registered via navigator.modelContext)
 * @param {()=>Array} [cfg.getDynamicTools]  Optional: extra tools that depend on app state
 * @param {(tool)=>tool} [cfg.adjustTool]    Optional: rewrite a tool's schema based on current view
 * @param {()=>string} cfg.getSystemPrompt   Returns the full system prompt for this turn
 * @param {()=>object} [cfg.dataSource]      Provenance of the loaded data — see source.js. Rendered
 *                                           under the header and appended to every system prompt,
 *                                           so the page and the model describe one source.
 * @param {()=>string[]} cfg.getDividerContext  Short labels shown on the in-chat divider after a tool render
 * @param {string[]} cfg.quickActions        Initial chip labels
 * @param {(label:string)=>string} [cfg.promptFor]  Expand a quick-action label to the full prompt
 * @param {()=>string[]} [cfg.getFollowupSuggestions]  Chips shown after a turn completes
 * @param {string} [cfg.defaultModel]        Override for default model select value
 */
export function mount(cfg) {
  initChatRefs();
  initTheme();
  initSettingsPopover();

  registerTools(cfg.tools);

  // Tools refresh hook — call this from your code after page state changes
  // that should affect what tools are exposed. We do an initial render here.
  const refresh = () => {
    let snapshot = listTools();
    if (cfg.adjustTool) snapshot = snapshot.map(cfg.adjustTool);
    if (cfg.getDynamicTools) snapshot = [...snapshot, ...cfg.getDynamicTools()];
    syncToolsPanel(snapshot);
    // Same hook the demos already call after every render, so the bar fills in
    // when the fetch lands and its relative timestamp stays honest afterwards.
    renderSourceBar(cfg.dataSource);
  };
  refresh();
  initToolsToggle();

  // The demo writes its prompt; the runtime appends the provenance. Neither
  // half can drift from the bar on screen, because both read one descriptor.
  const getSystemPrompt = () => {
    const block = sourcePromptBlock(cfg.dataSource);
    return block ? `${cfg.getSystemPrompt()}\n\n${block}` : cfg.getSystemPrompt();
  };
  const getDividerContext = cfg.getDividerContext;

  // Conversation state — one log shared between providers. The Anthropic
  // adapter sees content-block objects; the OpenAI adapter sees flat
  // {role, content[, tool_calls]} entries. They share a list, but each
  // provider pushes its own message format on its turn.
  let convo = [];

  const reset = () => { convo = []; clearChatMessages(); renderActions(); };

  const renderActions = () => {
    renderQuickActions({
      labels: cfg.quickActions,
      onClick: (label) => sendUserMessage(label, cfg.promptFor?.(label) ?? label),
    });
  };

  const renderFollowups = () => {
    if (!cfg.getFollowupSuggestions) return;
    const labels = cfg.getFollowupSuggestions().slice(0, 2);
    renderFollowupSuggestions({
      labels,
      onClick: (label) => sendUserMessage(label, label),
    });
  };

  let busy = false;
  let abort = null;

  async function sendUserMessage(displayText, fullPrompt) {
    if (busy) return;
    const text = (fullPrompt ?? '').trim();
    if (!text) return;

    // No credential to check any more — the daemon holds whatever auth the
    // model needs. The one thing that can be missing is the daemon itself.
    if (!isAgentReachable()) {
      appendMessage('error',
        'Local agent not reachable. Install and start termd (jonasneves.com/termd), then reload.');
      return;
    }

    clearQuickActions();
    clearFollowupSuggestions();
    appendMessage('user', displayText);

    convo.push({ role: 'user', content: text });

    busy = true;
    abort = new AbortController();
    setInputEnabled(false);
    showSpinner();

    await runConversation(convo, {
      signal: abort.signal,
      getSystemPrompt,
      getDividerContext,
      onComplete: renderFollowups,
    });

    abort = null;
    busy = false;
    setInputEnabled(true);
    getChatInputEl().focus();
  }

  // Wire chat input + buttons.
  const input = getChatInputEl();
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendUserMessage(input.value.trim(), input.value.trim());
      input.value = '';
      input.style.height = 'auto';
    }
  });
  document.getElementById('chat-send').addEventListener('click', () => {
    const v = input.value.trim();
    sendUserMessage(v, v);
    input.value = '';
    input.style.height = 'auto';
  });
  document.getElementById('chat-abort').addEventListener('click', () => abort?.abort());
  document.getElementById('chat-reset')?.addEventListener('click', reset);

  initAuth({
    defaultModel: cfg.defaultModel,
    onProviderChange: () => reset(),
  });

  document.addEventListener('keydown', (e) => {
    // `/` to focus chat — same accelerator GitHub uses. Don't steal every
    // printable keystroke (was breaking screen-reader and browser shortcuts).
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.target.matches('input, textarea')) {
      e.preventDefault();
      input.focus();
      return;
    }
    if (e.key === 'Escape') {
      const sp = document.getElementById('settings-popover');
      const sb = document.getElementById('settings-btn');
      if (sp && !sp.hidden) {
        sp.hidden = true;
        sb?.setAttribute('aria-expanded', 'false');
        sb?.focus();
        return;
      }
      const panel = document.getElementById('tools-panel');
      if (panel?.dataset.collapsed === 'false') {
        document.getElementById('tools-toggle').click();
        return;
      }
      dismissToast();
    }
  });

  renderActions();
  return { refresh, reset, sendUserMessage };
}

function initSettingsPopover() {
  const btn = document.getElementById('settings-btn');
  const popover = document.getElementById('settings-popover');
  if (!btn || !popover) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = popover.hidden;
    popover.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (e) => {
    if (!popover.hidden && !popover.contains(e.target) && e.target !== btn) {
      popover.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    }
  });
}

// Re-exports for demos that want individual primitives.
export { readInitialTheme } from './theme.js';
export { showToast, showConfirmDialog, showPromptDialog } from './ui.js';
export { appendMessage, appendDivider } from './chat.js';

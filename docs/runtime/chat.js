// Chat panel UI: message rendering, tool cards, spinner, input wiring.
// The agent loop owns conversation state; this module only renders.

import { renderMarkdown } from './ui.js';

let chatMessages, chatInput, chatSend, chatAbort;

export function initChatRefs() {
  chatMessages = document.getElementById('chat-messages');
  chatInput = document.getElementById('chat-input');
  chatSend = document.getElementById('chat-send');
  chatAbort = document.getElementById('chat-abort');
}

export function getChatMessagesEl() { return chatMessages; }
export function getChatInputEl() { return chatInput; }

function removeEmptyState() {
  const empty = chatMessages.querySelector('.chat-empty');
  if (empty) empty.remove();
}

function scrollToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

export function appendMessage(type, content) {
  removeEmptyState();
  const el = document.createElement('div');
  el.className = `msg msg-${type}`;
  if (type === 'assistant') {
    el.innerHTML = renderMarkdown(content);
  } else {
    el.textContent = content;
  }
  chatMessages.appendChild(el);
  scrollToBottom();
  return el;
}

export function appendDivider(text) {
  const el = document.createElement('div');
  el.className = 'chat-divider';
  el.textContent = text;
  chatMessages.appendChild(el);
}

export function showSpinner() {
  if (document.getElementById('chat-spinner')) return;
  const el = document.createElement('div');
  el.className = 'chat-spinner';
  el.id = 'chat-spinner';
  el.innerHTML = '<span></span><span></span><span></span>';
  chatMessages.appendChild(el);
  scrollToBottom();
}

export function hideSpinner() {
  document.getElementById('chat-spinner')?.remove();
}

export function setInputEnabled(enabled) {
  chatInput.disabled = !enabled;
  chatSend.hidden = !enabled;
  chatAbort.hidden = enabled;
}

// One builder for both pending and resolved cards. The card is mutated in
// place when the result lands, so the DOM node identity stays stable
// (avoiding flicker / scroll jumps).
export function createPendingToolCard(toolName) {
  removeEmptyState();
  const el = document.createElement('div');
  el.className = 'msg-tool-card pending';
  renderToolCardBody(el, toolName, null, null, false, true);
  chatMessages.appendChild(el);
  scrollToBottom();
  return el;
}

export function resolveToolCard(el, toolName, args, result, isError) {
  el.className = 'msg-tool-card' + (isError ? ' error' : '');
  renderToolCardBody(el, toolName, args, result, isError, false);
  scrollToBottom();
}

// Synchronous fallback when no pending card was created (rare, GH path only).
export function appendToolMsg(toolName, args, result, isError) {
  removeEmptyState();
  const el = document.createElement('div');
  el.className = 'msg-tool-card' + (isError ? ' error' : '');
  renderToolCardBody(el, toolName, args, result, isError, false);
  chatMessages.appendChild(el);
  scrollToBottom();
}

function renderToolCardBody(el, toolName, args, result, isError, pending) {
  el.innerHTML = '';
  const resultStr = typeof result === 'string' ? result : '';
  const summary = resultStr.length > 50 ? resultStr.slice(0, 50) + '...' : resultStr;

  const header = document.createElement('div');
  header.className = 'msg-tool-header';

  const status = document.createElement('span');
  status.className = 'msg-tool-status' + (pending ? '' : (isError ? ' error' : ' success'));
  status.textContent = pending ? '\u22ef' : (isError ? '\u2717' : '\u2713');

  const label = document.createElement('span');
  label.className = 'msg-tool-label';
  const nameStrong = document.createElement('strong');
  nameStrong.className = 'msg-tool-name';
  nameStrong.textContent = toolName;
  label.append(nameStrong, summary ? ' \u2014 ' + summary : '');

  header.append(status, label);

  if (!pending) {
    const chevron = document.createElement('span');
    chevron.className = 'msg-tool-chevron';
    chevron.textContent = '\u25BE';
    header.appendChild(chevron);

    // Header is interactive — make it focusable + accessible.
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');
    header.setAttribute('aria-expanded', 'false');
    const toggle = () => {
      const expanded = el.classList.toggle('expanded');
      header.setAttribute('aria-expanded', String(expanded));
    };
    header.addEventListener('click', toggle);
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  }

  el.appendChild(header);

  if (!pending) {
    const body = document.createElement('div');
    body.className = 'msg-tool-body';
    const argsEl = document.createElement('div');
    argsEl.className = 'msg-tool-args';
    argsEl.textContent = JSON.stringify(args, null, 2);
    body.appendChild(argsEl);
    if (resultStr) {
      const resultEl = document.createElement('div');
      resultEl.className = 'msg-tool-result';
      resultEl.textContent = '\u2192 ' + resultStr;
      body.appendChild(resultEl);
    }
    el.appendChild(body);
  }
}

export function renderQuickActions({ labels, onClick }) {
  const container = document.createElement('div');
  container.className = 'chat-quick-actions';
  container.id = 'quick-actions';
  labels.forEach(label => {
    const btn = document.createElement('button');
    btn.className = 'suggestion-chip quick-action-chip';
    btn.textContent = label;
    btn.addEventListener('click', () => onClick(label));
    container.appendChild(btn);
  });
  chatMessages.appendChild(container);
}

export function renderFollowupSuggestions({ labels, onClick }) {
  clearFollowupSuggestions();
  if (!labels.length) return;
  const container = document.createElement('div');
  container.className = 'followup-suggestions';
  container.id = 'followup-suggestions';
  labels.forEach(text => {
    const btn = document.createElement('button');
    btn.className = 'suggestion-chip followup-chip';
    btn.textContent = text;
    btn.addEventListener('click', () => onClick(text));
    container.appendChild(btn);
  });
  chatMessages.appendChild(container);
}

export function clearFollowupSuggestions() {
  document.getElementById('followup-suggestions')?.remove();
}

export function clearQuickActions() {
  document.getElementById('quick-actions')?.remove();
}

export function clearChatMessages() {
  chatMessages.innerHTML = '';
}

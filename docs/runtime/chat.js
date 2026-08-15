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

// ── Question cards (AskUserQuestion permission requests) ────────────────
//
// termd parks the turn on a permission_request when the embedded agent calls
// AskUserQuestion. Same mutate-in-place shape as the tool cards above: one
// DOM node, built interactive, then rewritten in place once the person
// answers so scroll position and node identity survive the swap.
export function createQuestionCard(questions, { onSubmit, onSkip, expiresAt } = {}) {
  removeEmptyState();
  const el = document.createElement('div');
  el.className = 'msg-question-card';

  // One { picks: Set<label>, other: string } per question. Picking an
  // option clears that question's free text and vice versa (enforced in
  // the two listeners below), so at most one of the two is ever non-empty.
  const state = questions.map(() => ({ picks: new Set(), other: '' }));
  let settled = false;
  let countdownTimer = null;

  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'msg-question-btn msg-question-submit';
  submitBtn.textContent = 'Submit';

  const skipBtn = document.createElement('button');
  skipBtn.type = 'button';
  skipBtn.className = 'msg-question-btn msg-question-skip';
  skipBtn.textContent = 'Skip';

  const countdownEl = document.createElement('span');
  countdownEl.className = 'msg-question-countdown';

  function refreshSubmit() {
    const ready = state.every(s => s.picks.size > 0 || s.other.trim());
    submitBtn.disabled = !ready;
  }

  const list = document.createElement('div');
  list.className = 'msg-question-list';

  questions.forEach((q, i) => {
    const qEl = document.createElement('div');
    qEl.className = 'msg-question';

    const head = document.createElement('div');
    head.className = 'msg-question-head';
    if (q.header) {
      const chip = document.createElement('span');
      chip.className = 'msg-question-chip';
      chip.textContent = q.header;
      head.appendChild(chip);
    }
    const qText = document.createElement('span');
    qText.className = 'msg-question-text';
    qText.textContent = q.question;
    head.appendChild(qText);
    qEl.appendChild(head);

    const opts = document.createElement('div');
    opts.className = 'msg-question-options';
    const optionEls = [];

    const otherInput = document.createElement('input');
    otherInput.type = 'text';
    otherInput.className = 'msg-question-other';
    otherInput.placeholder = 'Other…';

    (q.options || []).forEach(opt => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'msg-question-option';
      btn.setAttribute('aria-pressed', 'false');

      const labelEl = document.createElement('span');
      labelEl.className = 'msg-question-option-label';
      labelEl.textContent = opt.label;
      btn.appendChild(labelEl);
      if (opt.description) {
        const descEl = document.createElement('span');
        descEl.className = 'msg-question-option-desc';
        descEl.textContent = opt.description;
        btn.appendChild(descEl);
      }

      btn.addEventListener('click', () => {
        const s = state[i];
        if (q.multiSelect) {
          if (s.picks.has(opt.label)) s.picks.delete(opt.label);
          else s.picks.add(opt.label);
        } else {
          // Radio behaviour: picking a second option replaces the first;
          // re-picking the only selected one clears it (still a toggle).
          s.picks = (s.picks.has(opt.label) && s.picks.size === 1) ? new Set() : new Set([opt.label]);
        }
        // Picking clears this question's free text.
        if (s.picks.size > 0 && s.other) { s.other = ''; otherInput.value = ''; }
        optionEls.forEach(({ el: oEl, label }) => {
          const selected = s.picks.has(label);
          oEl.classList.toggle('selected', selected);
          oEl.setAttribute('aria-pressed', String(selected));
        });
        refreshSubmit();
      });

      optionEls.push({ el: btn, label: opt.label });
      opts.appendChild(btn);
    });
    qEl.appendChild(opts);

    otherInput.addEventListener('input', () => {
      const s = state[i];
      s.other = otherInput.value;
      // Typing deselects this question's picks.
      if (otherInput.value && s.picks.size > 0) {
        s.picks.clear();
        optionEls.forEach(({ el: oEl }) => { oEl.classList.remove('selected'); oEl.setAttribute('aria-pressed', 'false'); });
      }
      refreshSubmit();
    });
    qEl.appendChild(otherInput);

    list.appendChild(qEl);
  });
  el.appendChild(list);

  const footer = document.createElement('div');
  footer.className = 'msg-question-footer';
  if (expiresAt) footer.appendChild(countdownEl);
  const actions = document.createElement('div');
  actions.className = 'msg-question-actions';
  actions.append(skipBtn, submitBtn);
  footer.appendChild(actions);
  el.appendChild(footer);

  refreshSubmit();

  // Collapse to a quiet settled summary — one line per question, like a
  // resolved tool card — and stop the countdown, if any.
  function settleToSummary(rows, extraClass) {
    settled = true;
    if (countdownTimer) clearInterval(countdownTimer);
    el.className = 'msg-question-card settled' + (extraClass ? ' ' + extraClass : '');
    el.innerHTML = '';
    rows.forEach(({ q, a }) => {
      const row = document.createElement('div');
      row.className = 'msg-question-summary-row';
      const qEl = document.createElement('span');
      qEl.className = 'msg-question-summary-q';
      qEl.textContent = q;
      const arrow = document.createElement('span');
      arrow.className = 'msg-question-summary-arrow';
      arrow.textContent = '→';
      const aEl = document.createElement('span');
      aEl.className = 'msg-question-summary-a';
      aEl.textContent = a;
      row.append(qEl, arrow, aEl);
      el.appendChild(row);
    });
    scrollToBottom();
  }

  submitBtn.addEventListener('click', () => {
    if (settled) return;
    const answers = {};
    // Track which answers came from "Other…" rather than a pick — the SDK's
    // AskUserQuestionOutput carries those separately as `response`, verbatim
    // for a single free-text answer or as "question: answer" lines for more
    // than one. Answers still land in `answers` either way.
    const freeText = [];
    const rows = questions.map((q, i) => {
      const s = state[i];
      const typed = s.other.trim();
      const answer = typed || [...s.picks].join(', ');
      answers[q.question] = answer;
      if (typed) freeText.push({ q: q.question, a: typed });
      return { q: q.question, a: answer };
    });
    settleToSummary(rows);
    const response = freeText.length === 0 ? undefined
      : freeText.length === 1 ? freeText[0].a
      : freeText.map(r => `${r.q}: ${r.a}`).join('\n');
    onSubmit?.(answers, response);
  });

  skipBtn.addEventListener('click', () => {
    if (settled) return;
    settleToSummary(questions.map(q => ({ q: q.question, a: 'Skipped' })));
    onSkip?.();
  });

  if (expiresAt) {
    const tick = () => {
      const msLeft = expiresAt - Date.now();
      if (msLeft <= 0) {
        clearInterval(countdownTimer);
        if (!settled) {
          // termd denies-and-interrupts the whole turn once its own timeout
          // passes; resolve as a skip here too, so this card doesn't sit
          // waiting for a response that can no longer land.
          settleToSummary(questions.map(q => ({ q: q.question, a: 'Expired' })), 'expired');
          onSkip?.();
        }
        return;
      }
      const s = Math.ceil(msLeft / 1000);
      countdownEl.textContent = `expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  chatMessages.appendChild(el);
  scrollToBottom();
  return el;
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

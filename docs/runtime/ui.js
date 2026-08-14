// UI primitives — toast, dialogs, markdown. Used by the chat loop and tools.

export function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(text));
}

export function scrollDisplayIntoView() {
  const display = document.getElementById('display');
  if (!display) return;
  if (window.matchMedia('(max-width: 900px)').matches) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else {
    display.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

let currentToastTimeout = null;
export function showToast(message, onUndo) {
  dismissToast();
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast';

  const msgSpan = document.createElement('span');
  msgSpan.className = 'toast-message';
  msgSpan.textContent = message;
  toast.appendChild(msgSpan);

  if (onUndo) {
    const undoBtn = document.createElement('button');
    undoBtn.className = 'toast-undo';
    undoBtn.textContent = 'Undo';
    undoBtn.addEventListener('click', () => { dismissToast(); onUndo(); });
    toast.appendChild(undoBtn);
  }

  container.appendChild(toast);
  currentToastTimeout = setTimeout(dismissToast, 5000);
}

export function dismissToast() {
  if (currentToastTimeout) { clearTimeout(currentToastTimeout); currentToastTimeout = null; }
  const c = document.getElementById('toast-container');
  if (c) c.innerHTML = '';
}

// Dialog focus management: remember the element that opened the dialog so we
// can restore focus on close. Without this, keyboard users land on <body>
// after closing — a regression flagged in the project audit.
function openDialog(dialog, focusTarget) {
  const opener = document.activeElement;
  dialog.returnValue = '';
  dialog.showModal();
  // Defer focus so the dialog's native focus-trap has settled.
  queueMicrotask(() => focusTarget?.focus());
  return new Promise(resolve => {
    dialog.addEventListener('close', () => {
      opener?.focus?.();
      resolve(dialog.returnValue);
    }, { once: true });
  });
}

export async function showConfirmDialog(toolName, args) {
  const dialog = document.getElementById('confirm-dialog');
  document.getElementById('confirm-tool').textContent = toolName;
  document.getElementById('confirm-args').textContent = JSON.stringify(args, null, 2);
  // Default focus to cancel — destructive actions shouldn't be one Enter away.
  const cancelBtn = dialog.querySelector('.btn-cancel');
  const result = await openDialog(dialog, cancelBtn);
  return result === 'confirm';
}

export async function showPromptDialog(message) {
  const dialog = document.getElementById('prompt-dialog');
  const input = document.getElementById('prompt-input');
  document.getElementById('prompt-title').textContent = message;
  input.value = '';
  const onEnter = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); dialog.close('confirm'); }
  };
  input.addEventListener('keydown', onEnter);
  const result = await openDialog(dialog, input);
  input.removeEventListener('keydown', onEnter);
  return result === 'confirm' ? (input.value || null) : null;
}

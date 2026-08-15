// Transport to termd — the only provider these demos use.
//
// There is deliberately no hosted-API path here any more. Every one of them
// needed a key pasted into the page and held in localStorage, and the claim
// worth demonstrating was never "a browser can call a model API". It is that
// the agent runs on your own machine and calls back into the page for each
// tool. Dropping the keys drops the whole secret-handling surface with them.
//
// termd cannot be reached by this page directly, and the reason is CORS rather
// than mixed content: loopback is a potentially-trustworthy origin, so an https
// page is allowed to reach http://127.0.0.1 — but termd sends no CORS headers on
// purpose. It has no authentication, so anything that reaches its port gets a
// shell as the operator, and the same-origin policy is the only gate. Don't
// "fix" that by loosening CORS on the daemon. The bridge extension runs on its
// own origin with host_permissions and relays; its externally_connectable
// allowlist is the access control.
//
// Install the daemon and the extension: https://jonasneves.com/termd/

export const TERMD_INSTALL_URL = 'https://jonasneves.com/termd/';

// Overridable so a second daemon (a dev build on another port) can be pointed
// at without editing source: localStorage['webmcp-termd-url'].
export const TERMD_URL = (() => {
  try { return localStorage.getItem('webmcp-termd-url') || 'http://127.0.0.1:5000'; }
  catch { return 'http://127.0.0.1:5000'; }
})();

export const TERMD_EXTENSION_ID = 'mgcgjhbjenjaboahijedcngmgigofkhh';

let termdPort = null;
function getTermdPort() {
  if (termdPort) return termdPort;
  if (typeof chrome === 'undefined' || !chrome.runtime?.connect) return null;
  try {
    termdPort = chrome.runtime.connect(TERMD_EXTENSION_ID);
    termdPort.onDisconnect.addListener(() => { termdPort = null; });
  } catch { termdPort = null; }
  return termdPort;
}

function bridgeSend(msg, { onChunk } = {}) {
  return new Promise((resolve, reject) => {
    const port = getTermdPort();
    if (!port) return reject(new Error('no bridge'));
    const id = Math.random().toString(36).slice(2);
    const onMessage = (m) => {
      if (m.id !== id) return;
      if (m.type === 'chunk') return onChunk?.(m.text);
      port.onMessage.removeListener(onMessage);
      if (m.type === 'error') reject(new Error(m.status ? `termd ${m.status}: ${(m.body || '').slice(0, 200)}` : m.error));
      else resolve(m);
    };
    port.onMessage.addListener(onMessage);
    // The bridge defaults to :5000; forward the override so a dev daemon on
    // another port is reachable through the bridge and not only directly.
    port.postMessage({ ...msg, id, base: TERMD_URL });
  });
}

export async function checkTermd() {
  // Bridge first: it is the only path that works from an https page. Ask the
  // daemon, not the bridge — the bridge answers nothing on its own behalf, so
  // this fails when termd is down even though the extension is installed.
  try {
    const res = await Promise.race([
      bridgeSend({ path: '/health', method: 'GET' }),
      new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 1500)),
    ]);
    if (res?.type === 'done') return true;
  } catch { /* fall through to the direct probe */ }
  // Direct works only when the daemon is serving this page itself. Any other
  // origin — including another port on localhost — is cross-origin, and termd
  // sends no CORS headers; probing anyway just fills the console with errors.
  if (location.origin !== new URL(TERMD_URL).origin) return false;
  try {
    const res = await fetch(`${TERMD_URL}/health`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch { return false; }
}

/* Unlike a model API, termd owns the conversation, the history and the agent
 * loop; we hand it a prompt plus the page's tool definitions and answer the
 * tool calls it streams back. */
export async function streamTermdAgent({ prompt, tools, cwd, model, signal, settingSources }) {
  // 'default' lets the daemon's own TERMD_MODEL decide.
  // settingSources is omitted unless the caller named one — `[]` (SDK isolation: no
  // ~/.claude/settings.json, no CLAUDE.md, no project/local settings) is a real,
  // caller-named value and must reach termd as one, not collapse to "unset".
  const body = {
    prompt, tools, cwd, maxTurns: 24,
    ...(model && model !== 'default' ? { model } : {}),
    ...(settingSources !== undefined ? { settingSources } : {}),
  };
  if (getTermdPort()) {
    // Re-expose the bridge's chunks as a ReadableStream so the SSE parser does
    // not care which transport delivered them.
    let controller = null;
    const stream = new ReadableStream({ start(c) { controller = c; } });
    const enc = new TextEncoder();
    bridgeSend({ path: '/agent/stream', body },
               { onChunk: (t) => controller?.enqueue(enc.encode(t)) })
      .then(() => { try { controller?.close(); } catch {} })
      .catch((e) => { try { controller?.error(e); } catch {} });
    signal?.addEventListener('abort', () => { try { controller?.close(); } catch {} }, { once: true });
    return stream;
  }
  // Same-origin only — i.e. when the daemon is serving this page itself.
  const res = await fetch(`${TERMD_URL}/agent/stream`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`termd ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.body;
}

/* Answer a parked tool call. A 404 means the call already settled — it timed
 * out, or the turn ended — so the caller should stop rather than retry. */
export async function answerTermdTool(token, result) {
  const path = `/agent/tool/${encodeURIComponent(token)}`;
  if (getTermdPort()) {
    try { await bridgeSend({ path, body: result }); return true; }
    catch { return false; }
  }
  const res = await fetch(`${TERMD_URL}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(result),
  });
  return res.ok;
}

/* Answer a parked permission request — termd emits one of these when the
 * embedded agent calls a tool that needs a human in the loop (AskUserQuestion
 * being the one this runtime renders; anything else gets an automatic deny —
 * see loop.js). Same dual bridge/fetch path as answerTermdTool, different
 * endpoint: /fleet/blocked rather than /agent/tool. optionId is 'allow' or
 * 'deny'; updatedInput carries the answers and is only sent on allow. */
export async function answerTermdPermission(token, optionId, updatedInput) {
  const path = `/fleet/blocked/${encodeURIComponent(token)}`;
  const body = updatedInput !== undefined ? { optionId, updatedInput } : { optionId };
  if (getTermdPort()) {
    try { await bridgeSend({ path, body }); return true; }
    catch { return false; }
  }
  const res = await fetch(`${TERMD_URL}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.ok;
}

async function* readStreamLines(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) yield line;
    }
  } finally {
    reader.releaseLock();
  }
}

/* termd's stream is bare `data:` lines of JSON with no event names — the type
 * is a field inside the payload. Bad JSON shouldn't kill the stream, but it
 * shouldn't be silent either. */
export async function* parseTermdStream(body) {
  for await (const line of readStreamLines(body)) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') return;
    try { yield JSON.parse(payload); }
    catch (err) { console.warn('[providers] dropped malformed termd chunk:', err); }
  }
}

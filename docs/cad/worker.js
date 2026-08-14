// CSG worker. Runs authored scripts off the main thread so a heavy boolean
// op (or a pathological infinite loop in generated code) can't freeze the
// chat/editor UI. Isolation here is for responsiveness and crash
// containment, not a hard security sandbox — the script still runs with the
// worker's own JS capabilities (postMessage, fetch, etc. minus the DOM).
// main.js pairs this with a wall-clock timeout that terminates and respawns
// the worker if a script never responds.
//
// `new Function` below executes arbitrary author-supplied JS BY DESIGN —
// that is the product (parametric CSG authoring), not code-injection risk
// smuggled in. Same trust model as CodePen/Shadertoy/ObservableHQ/
// manifoldcad.org: no server, no credentials, no cross-origin reach beyond
// what a Worker already has, and the author is the operator's own local
// agent (termd), not a remote or untrusted party.

import { loadManifold, buildAPI, reportFor, extractMesh } from './kernel.js';

let Manifold = null;
let api = null;

async function ensureReady() {
  if (api) return;
  Manifold = await loadManifold();
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type !== 'run') return;
  const { requestId, code } = msg;

  try {
    await ensureReady();
  } catch (err) {
    self.postMessage({ type: 'run-result', requestId, ok: false, error: 'manifold-3d failed to load: ' + (err.message || String(err)) });
    return;
  }

  const tracked = new Set();
  try {
    api = buildAPI(Manifold, (m) => tracked.add(m));
    const keys = Object.keys(api);
    const values = keys.map(k => api[k]);
    // eslint-disable-next-line no-new-func
    const run = new Function(...keys, `"use strict";\n${code}\n`);
    const shape = run(...values);

    if (!shape || typeof shape.getMesh !== 'function') {
      const got = shape === undefined ? 'undefined — did you forget `return`?' : typeof shape;
      throw new Error(`Script must end with \`return <shape>\`. Got: ${got}`);
    }

    const report = reportFor(shape);
    const mesh = extractMesh(shape);
    self.postMessage(
      { type: 'run-result', requestId, ok: true, mesh, report },
      [mesh.vertProperties.buffer, mesh.triVerts.buffer],
    );
  } catch (err) {
    self.postMessage({ type: 'run-result', requestId, ok: false, error: err.message || String(err) });
  } finally {
    for (const m of tracked) { try { m.delete?.(); } catch { /* not disposable, ignore */ } }
  }
};

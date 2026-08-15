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

import { loadManifold, buildAPI, reportFor, extractMesh, importMesh } from './kernel.js';

let Manifold = null;
let Mesh = null;

// The currently-imported reference, as a Manifold — persists across `run`
// calls (unlike everything a script itself creates, which is disposed when
// that run ends) until replaced by a new import or explicitly cleared.
// NEVER passed through the per-run `track()` set below, or it would get
// .delete()'d the first time a script that calls imported() finishes.
let importedManifold = null;

// Safe to call concurrently even though this itself is check-then-act on
// Manifold: loadManifold() caches its own in-flight promise, so N calls that
// all see Manifold===null before the first resolves still share one WASM
// instantiation and end up assigning the same values here.
async function ensureReady() {
  if (Manifold) return;
  ({ Manifold, Mesh } = await loadManifold());
}

function disposeImported() {
  if (importedManifold) { try { importedManifold.delete?.(); } catch { /* not disposable, ignore */ } }
  importedManifold = null;
}

self.onmessage = async (e) => {
  const msg = e.data;

  try {
    await ensureReady();
  } catch (err) {
    self.postMessage({ type: `${msg.type}-result`, requestId: msg.requestId, ok: false, error: 'manifold-3d failed to load: ' + (err.message || String(err)) });
    return;
  }

  if (msg.type === 'run') {
    const { requestId, code } = msg;
    const tracked = new Set();
    try {
      const api = buildAPI(Manifold, (m) => tracked.add(m));
      api.imported = () => {
        if (!importedManifold) throw new Error('imported() called but nothing has been imported yet — use "Import…" to load a reference STL first.');
        return importedManifold; // persistent base object — deliberately not tracked/disposed here
      };
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
    return;
  }

  if (msg.type === 'import') {
    // Welded (indexed) mesh data — main.js runs three's mergeVertices before
    // sending this; a raw STL triangle soup (no shared vertices at all) reads
    // as non-manifold to the constructor below regardless of the real shape.
    const { requestId, vertProperties, triVerts, numProp } = msg;
    disposeImported(); // drop the previous import's WASM memory before replacing it
    try {
      const shape = importMesh(Manifold, Mesh, { vertProperties, triVerts, numProp });
      const report = reportFor(shape);
      importedManifold = shape;
      self.postMessage({ type: 'import-result', requestId, ok: true, report });
    } catch (err) {
      // Per kernel.js: the constructor throws for non-oriented-2-manifold
      // input — common for scanned/sculpted STLs. Not a bug to hide: report
      // it so main.js can say the reference is view-only, and why.
      self.postMessage({ type: 'import-result', requestId, ok: false, error: err.message || String(err) });
    }
    return;
  }

  if (msg.type === 'clear-import') {
    disposeImported();
    self.postMessage({ type: 'clear-import-result', requestId: msg.requestId, ok: true });
  }
};

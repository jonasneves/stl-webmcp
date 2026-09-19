import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { meshToSTL } from './cad/stl-export.js';
import { API_REFERENCE } from './cad/kernel.js';

// Renders on load (see the auto-run call near the bottom of this file) so the
// viewport never opens empty — a plate with 4 mounting holes exercises more of
// the DSL (translate, a boolean, a loop) than a bare primitive would.
const DEFAULT_SCRIPT = `// A plate with 4 mounting holes — edit this and hit Run (⌘⏎), or write your own.
// cube({size,center}) · cylinder({height,radius,radiusTop,segments,center}) · sphere({radius,segments})
// union/subtract/intersect(...) · translate/rotate/scale/mirror(shape, v)

const plate = cube({ size: [60, 40, 6], center: true });
const hole = (x, y) => translate(cylinder({ height: 10, radius: 3, segments: 32, center: true }), [x, y, 0]);
let bracket = plate;
for (const [x, y] of [[-25, -15], [25, -15], [-25, 15], [25, 15]]) {
  bracket = subtract(bracket, hole(x, y));
}
return bracket;
`;

// ---------- DOM refs ----------
const canvas = document.getElementById('gl');
const wireframeBtn = document.getElementById('vp-wireframe');
const gridBtn = document.getElementById('vp-grid');
const resetBtn = document.getElementById('vp-reset');
const openBtn = document.getElementById('vp-open');
const fileInput = document.getElementById('vp-file');
const exportBtn = document.getElementById('vp-export');
const emptyEl = document.getElementById('vp-empty');
const DEFAULT_EMPTY_HINT = emptyEl.textContent; // restored whenever a non-empty geometry lands, or on reset — see the empty-result branch in runScript
const reportEl = document.getElementById('vp-report');
const dropIndicatorEl = document.getElementById('drop-indicator');
const editorEl = document.getElementById('editor');
const runBtn = document.getElementById('editor-run');
const statusEl = document.getElementById('editor-status');
const historySelect = document.getElementById('editor-history');

editorEl.value = DEFAULT_SCRIPT;

// ---------- Three.js viewer (same setup as the original stl-viewer) ----------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161c);

const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 100);
camera.position.set(2, 1.6, 2);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoftShadowMap is deprecated as of three@0.183

// Dirty-flag render gate: every place that can make the canvas look
// different — camera motion, new geometry, a material/visibility toggle
// that doesn't emit its own event — must call requestRender(). tick() below
// is the only place needsRender gets cleared; a missed call site here means
// a permanently stale canvas on that path.
let needsRender = true;
function requestRender() { needsRender = true; }

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.addEventListener('change', requestRender); // user drag/zoom/pan

const hemi = new THREE.HemisphereLight(0xdfe6f5, 0x14161c, 1.1);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(3, 4, 2);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
scene.add(key);
const fill = new THREE.DirectionalLight(0xaac4ff, 0.5);
fill.position.set(-3, 1, -2);
scene.add(fill);

const material = new THREE.MeshStandardMaterial({ color: 0xc7cbd6, roughness: 0.75, metalness: 0.05 });

let mesh = null, grid = null, ground = null, lastRadius = 1;

function resizeRenderer() {
  const { clientWidth, clientHeight } = canvas.parentElement;
  camera.aspect = clientWidth / Math.max(clientHeight, 1);
  camera.updateProjectionMatrix();
  renderer.setSize(clientWidth, clientHeight, false);
  requestRender();
}
// canvas.parentElement (.viewport-pane) is `position:absolute; inset:0`
// inside `main`, which fills the full body (cad.css) — a window resize
// changes its layout box just like any other resize, so the observer alone
// covers it; no separate window 'resize' listener needed.
new ResizeObserver(resizeRenderer).observe(canvas.parentElement);
resizeRenderer();

function clearModel() {
  if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); mesh = null; }
  if (grid) { scene.remove(grid); grid = null; }
  if (ground) { scene.remove(ground); ground = null; }
  requestRender(); // reset_script calls this standalone (no applyGeometry after) — must repaint the now-empty scene itself
}

function frameCamera(radius, center) {
  const dist = Math.max(radius * 2.6, radius + 0.05);
  const dir = new THREE.Vector3(1, 0.8, 1).normalize();
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.near = Math.max(radius / 100, 1e-4);
  camera.far = Math.max(radius * 50, 10);
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.minDistance = radius * 0.05;
  controls.maxDistance = radius * 20;
  controls.update();
}

// Shared by authored (worker-built) and reference (STLLoader-parsed)
// geometry: center it, drop it in, frame the camera, size the grid to it.
function applyGeometry(geometry) {
  clearModel();
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const size = new THREE.Vector3(); box.getSize(size);
  const center = new THREE.Vector3(); box.getCenter(center);
  // Capture the pre-translate bottom edge as a plain number NOW: .translate()
  // below updates geometry.boundingBox (== box, same object) IN PLACE, so
  // reading box.min.y after it runs returns the already-centered value —
  // subtracting center.y from that a second time double-counts it. Bug only
  // showed up on a mesh authored far from its own local origin (this one:
  // center ~[128,128,4.5]); anything built/exported near-centered (most
  // center:true CSG primitives, most URDF parts) has center.y≈0 and the
  // double-subtraction was invisible.
  // An empty result (0 triangles — e.g. intersect() of non-overlapping
  // shapes) still reports NoError, but Box3's min/max default to
  // +/-Infinity when empty (unlike getSize/getCenter above, which guard
  // internally), so box.min.y here would otherwise be Infinity.
  const groundY = box.isEmpty() ? 0 : box.min.y - center.y;
  geometry.translate(-center.x, -center.y, -center.z);

  mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);

  const radius = Math.max(size.length() / 2, 1e-4);
  lastRadius = radius;

  ground = new THREE.Mesh(new THREE.PlaneGeometry(radius * 20, radius * 20), new THREE.ShadowMaterial({ opacity: 0.25 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = groundY - 1e-4;
  ground.receiveShadow = true;
  scene.add(ground);

  grid = new THREE.GridHelper(radius * 8, 16, 0x4a5170, 0x2c3040);
  grid.position.y = ground.position.y;
  grid.visible = gridBtn.classList.contains('on');
  scene.add(grid);

  frameCamera(radius, new THREE.Vector3(0, 0, 0));
  emptyEl.hidden = true;
  resetBtn.disabled = false;
  requestRender();
  return { size, box };
}

wireframeBtn.addEventListener('click', () => {
  material.wireframe = !material.wireframe;
  wireframeBtn.textContent = `Wireframe: ${material.wireframe ? 'on' : 'off'}`;
  wireframeBtn.classList.toggle('on', material.wireframe);
  wireframeBtn.setAttribute('aria-pressed', String(material.wireframe));
  requestRender(); // material.wireframe flips silently — no three.js event for it
});
gridBtn.addEventListener('click', () => {
  const on = !gridBtn.classList.contains('on');
  gridBtn.classList.toggle('on', on);
  gridBtn.setAttribute('aria-pressed', String(on));
  if (grid) grid.visible = on;
  requestRender(); // grid.visible flips silently — no three.js event for it
});
resetBtn.addEventListener('click', () => {
  if (!mesh) return;
  frameCamera(lastRadius, new THREE.Vector3(0, 0, 0));
  requestRender();
});

(function tick() {
  const moved = controls.update(); // true when damping is still settling the camera
  if (moved) needsRender = true;
  if (needsRender) {
    renderer.render(scene, camera);
    needsRender = false;
  }
  requestAnimationFrame(tick);
})();

// ---------- Import: load an STL for viewing AND, if it's a valid manifold
// once welded, as a usable CSG operand (imported() in scripts). ----------
function updateReferenceReportPanel() {
  const r = state.referenceInfo;
  if (!r) return;
  const usable = r.importStatus === 'ok';
  reportEl.innerHTML =
    `<div class="vp-report-dim">import: ${escapeHtml(r.filename)}</div>` +
    `<div class="vp-report-dim">${r.numTri.toLocaleString()} tri · ${fmt(r.size.x)}×${fmt(r.size.y)}×${fmt(r.size.z)}</div>` +
    `<div class="${usable ? 'vp-report-good' : 'vp-report-bad'}">${usable ? '✓ usable as imported()' : r.importStatus === 'pending' ? 'checking…' : '✗ view-only: ' + escapeHtml(r.importError || 'not a valid manifold')}</div>`;
  reportEl.hidden = false;
}

function handleReferenceFile(file, importingSuffix = '…') {
  if (!file) return;
  if (!/\.stl$/i.test(file.name)) { setStatus(`"${file.name}" isn't a .stl file.`, 'bad'); return; }
  const reader = new FileReader();
  reader.onerror = () => setStatus(`Couldn't read "${file.name}".`, 'bad');
  reader.onload = async () => {
    let geometry;
    try { geometry = new STLLoader().parse(reader.result); }
    catch { setStatus(`Couldn't parse "${file.name}" as STL.`, 'bad'); return; }
    geometry.computeVertexNormals();
    const { size } = applyGeometry(geometry);
    state.mode = 'reference';
    state.referenceInfo = {
      filename: file.name,
      numTri: geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3,
      size: { x: size.x, y: size.y, z: size.z },
      importStatus: 'pending', importError: null,
    };
    exportBtn.disabled = true;
    updateReferenceReportPanel();
    setStatus(`Importing "${file.name}"${importingSuffix}`, 'busy');

    // manifold-3d's import constructor needs real shared-vertex topology at
    // triangle edges to read as a 2-manifold — a raw STL has none at all
    // (the format stores independent triangles, no connectivity), so it
    // reads as "all boundary edges" regardless of whether the real shape is
    // watertight. Weld coincident vertices into an indexed mesh first.
    //
    // Weld on a POSITION-ONLY clone: mergeVertices compares every enabled
    // attribute, and per-face normals — which legitimately differ at a
    // "shared" corner between two differently-oriented faces — silently
    // block the cross-face merge a manifold check needs. Verified: a plain
    // cube welds to its correct 8 vertices with normals stripped first, but
    // only to 24 (6 faces × 4 corners, merged per-face only) if they ride
    // along — the exact shape of "why did a known-good cube fail to import."
    let positions, triVerts;
    try {
      const weldGeometry = geometry.clone();
      weldGeometry.deleteAttribute('normal');
      const welded = mergeVertices(weldGeometry);
      positions = welded.attributes.position.array;
      const rawIndex = welded.index.array;
      triVerts = rawIndex instanceof Uint32Array ? rawIndex : Uint32Array.from(rawIndex);
    } catch (err) {
      // Unguarded, this throw used to leave importStatus stuck at 'pending'
      // ("checking…") forever, plus an unhandled rejection — route it
      // through the same failed-import outcome as a worker-side rejection.
      if (state.referenceInfo) {
        state.referenceInfo.importStatus = 'failed';
        state.referenceInfo.importError = err.message || String(err);
      }
      if (state.mode === 'reference') {
        updateReferenceReportPanel();
        setStatus(`"${file.name}" loaded for viewing — not usable in scripts: ${err.message || String(err)}`, 'bad');
      }
      return;
    }

    try {
      const result = await cadWorker.import({ vertProperties: positions, triVerts, numProp: 3 });
      // referenceInfo can be null by the time this await resolves —
      // reset_script clears it mid-flight — which used to throw here.
      if (state.referenceInfo) state.referenceInfo.importStatus = 'ok';
      // mode-gated: this import check can still be pending when a script run
      // finishes and flips mode back to 'authored' — without this, the late
      // import completion would overwrite that run's report/status.
      if (state.mode === 'reference') {
        updateReferenceReportPanel();
        setStatus(`Imported "${file.name}" — usable in scripts as imported(). ${formatReportLine(result.report)}`, 'ok');
      }
    } catch (err) {
      // Not a bug — common for scanned/sculpted meshes. Still shown for
      // viewing; just not usable as a CSG operand.
      if (state.referenceInfo) {
        state.referenceInfo.importStatus = 'failed';
        state.referenceInfo.importError = err.message || String(err);
      }
      if (state.mode === 'reference') {
        updateReferenceReportPanel();
        setStatus(`"${file.name}" loaded for viewing — not usable in scripts: ${err.message || String(err)}`, '');
      }
    }
  };
  reader.readAsArrayBuffer(file);
}
openBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => handleReferenceFile(fileInput.files[0]));
// dragDepth counts nested dragenter/dragleave pairs — a dragleave fires for
// every child element the pointer crosses, not just when it truly exits the
// window, so only hide the indicator once depth returns to 0.
let dragDepth = 0;
window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; dropIndicatorEl.hidden = false; });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropIndicatorEl.hidden = true;
});
window.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  dropIndicatorEl.hidden = true;
  const files = e.dataTransfer.files;
  const extra = files.length - 1;
  // Only one file imports at a time (cadWorker holds a single persistent
  // import slot) — say so instead of silently dropping the rest on the floor.
  const suffix = extra > 0 ? ` — ${extra} more file${extra === 1 ? '' : 's'} ignored (one at a time).` : '…';
  handleReferenceFile(files[0], suffix);
});

// ---------- CSG worker client ----------
// A worker respawn (script timeout, or a fatal WASM trap reported by
// worker.js's run handler — see its catch there) drops the persistent
// imported-reference state worker.js holds. cadWorker.onRestart (wired
// below, once state exists) is the recovery path: it flips referenceInfo to
// 'failed' so get_render_report and the report panel stop claiming
// imported() still works, instead of an agent finding out only when the
// next imported() call throws.
class CadWorker {
  constructor() { this.pending = new Map(); this.reqId = 0; this._spawn(); }
  _spawn() {
    this.worker = new Worker(new URL('./cad/worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this._onMessage(e.data);
    this.worker.onerror = (e) => this._failAll('Worker error: ' + (e.message || 'unknown'));
  }
  _onMessage(msg) {
    if (!msg.type?.endsWith('-result')) return;
    const p = this.pending.get(msg.requestId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.requestId);
    msg.ok ? p.resolve(msg) : p.reject(new Error(msg.error));
    // fatal: worker.js caught a WASM trap — its cached Manifold/Mesh
    // instance is corrupt, so even a valid NEXT run would hang instead of
    // erroring. This request already got its own real error above; restart
    // for everything still queued behind it.
    if (!msg.ok && msg.fatal) this._restart('worker restarted after a fatal WASM error.');
  }
  // Shared by worker onerror (every pending request fails alike) and
  // _call's timeout (one culprit request plus N collateral ones sharing its
  // worker, which each need a different message). messageFor may be a
  // string for the uniform case or (requestId) => string for the split one.
  _failAll(messageFor) {
    const toMessage = typeof messageFor === 'function' ? messageFor : () => messageFor;
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(toMessage(id))); }
    this.pending.clear();
  }
  // Shared by a script timeout (worker never responds) and a fatal WASM trap
  // (worker responds, but its cached kernel state is corrupt either way) —
  // both mean the worker itself is unusable, not just one request, so fail
  // the whole map before terminating; otherwise their still-scheduled
  // timers would each later fire and terminate the NEW healthy worker in
  // turn. onRestart is page-level cleanup wired in below, keeping this
  // class itself state-agnostic.
  _restart(messageFor) {
    this._failAll(messageFor);
    this.worker.terminate();
    this._spawn();
    this.onRestart?.();
  }
  _call(type, payload, timeoutMs, transfer) {
    const requestId = ++this.reqId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._restart((id) => id === requestId
          ? `${type} timed out after ${timeoutMs}ms (possible infinite loop) — worker restarted.`
          : 'worker restarted after another request timed out.');
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.worker.postMessage({ type, requestId, ...payload }, transfer || []);
    });
  }
  run(code, timeoutMs = 15000) { return this._call('run', { code }, timeoutMs); }
  // Not transferred (unlike run's result) — main.js keeps its own copy of
  // the welded arrays around for the report panel and re-export, so a
  // structured-clone copy here (one-time, per import) is the safe choice.
  import(meshData, timeoutMs = 15000) { return this._call('import', meshData, timeoutMs); }
  clearImport(timeoutMs = 5000) { return this._call('clear-import', {}, timeoutMs); }
}
const cadWorker = new CadWorker();

// ---------- App state + run loop ----------
const state = {
  code: DEFAULT_SCRIPT,
  lastMesh: null,
  lastReport: null,
  lastError: null,
  busy: false,
  history: [],
  mode: 'authored',
  referenceInfo: null, // {filename, numTri, size} — set only in 'reference' mode; see handleReferenceFile
};
// See the CadWorker comment above: a respawn drops worker.js's persistent
// import, but leaves this state believing it's still 'ok' unless told
// otherwise.
cadWorker.onRestart = () => {
  if (state.referenceInfo?.importStatus === 'ok') {
    state.referenceInfo.importStatus = 'failed';
    state.referenceInfo.importError = 'lost when the CSG worker restarted — re-import the file';
    if (state.mode === 'reference') updateReferenceReportPanel();
  }
};
function formatReferenceLine(r) {
  return `imported "${r.filename}" · ${r.numTri.toLocaleString()} tri · ${fmt(r.size.x)}×${fmt(r.size.y)}×${fmt(r.size.z)}`;
}

function fmt(n, d = 2) { return Number(n).toFixed(d); }
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = 'editor-status' + (kind ? ` ${kind}` : '');
}
// A 0-triangle result reports manifold:true (NoError) — "empty" is its own
// not-ok state (almost always a mistake, per the subtract-no-op warning in
// kernel.js's API_REFERENCE), so callers gate on this instead of `manifold`
// alone.
function reportOk(r) { return r.manifold && !r.empty; }
function formatReportLine(r) {
  if (r.empty) return '⚠ empty result · 0 tri — shapes may not overlap';
  const [sx, sy, sz] = r.bbox.size;
  const flag = r.manifold ? '✓ manifold' : `✗ ${r.status}`;
  return `${flag} · ${r.numTri.toLocaleString()} tri · ${fmt(sx)}×${fmt(sy)}×${fmt(sz)}`;
}
function updateReportPanel(r) {
  const [sx, sy, sz] = r.bbox.size;
  const flagLine = r.empty
    ? `<div class="vp-report-bad">⚠ empty result — shapes may not overlap</div>`
    : `<div class="${r.manifold ? 'vp-report-good' : 'vp-report-bad'}">${r.manifold ? '✓ manifold' : '✗ ' + escapeHtml(r.status)}</div>`;
  reportEl.innerHTML =
    flagLine +
    `<div class="vp-report-dim">${r.numTri.toLocaleString()} triangles</div>` +
    `<div class="vp-report-dim">${fmt(sx)} × ${fmt(sy)} × ${fmt(sz)}</div>`;
  reportEl.hidden = false;
}
// runScript's catch calls this instead of leaving the report card showing
// the previous run's (possibly green) result while the editor status turns
// red — the card is the viewport's status surface, so it has to agree.
function updateReportPanelError(message) {
  const snippet = message.length > 140 ? message.slice(0, 140) + '…' : message;
  reportEl.innerHTML =
    `<div class="vp-report-bad">✗ run failed</div>` +
    `<div class="vp-report-dim">${escapeHtml(snippet)}</div>`;
  reportEl.hidden = false;
}

function applyManifoldMesh(meshData) {
  const { vertProperties, triVerts, numProp } = meshData;
  let positions;
  if (numProp === 3) {
    positions = vertProperties;
  } else {
    const vertCount = vertProperties.length / numProp;
    positions = new Float32Array(vertCount * 3);
    for (let i = 0; i < vertCount; i++) {
      positions[i * 3] = vertProperties[i * numProp];
      positions[i * 3 + 1] = vertProperties[i * numProp + 1];
      positions[i * 3 + 2] = vertProperties[i * numProp + 2];
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(triVerts, 1));
  geometry.computeVertexNormals();
  applyGeometry(geometry);
}

const HISTORY_KEY = 'stl-webmcp-history';

// Shared by pushHistory and the on-load restore below, so the dropdown is
// always built the same way regardless of where state.history came from.
function renderHistorySelect() {
  historySelect.innerHTML = '<option value="">History…</option>' + state.history.map((h, i) => {
    const t = new Date(h.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const mark = h.ok ? '✓' : '✗';
    const snippet = h.code.trim().split('\n').find(l => l.trim() && !l.trim().startsWith('//')) || h.code.trim().slice(0, 40);
    return `<option value="${i}">${mark} ${t} — ${escapeHtml(snippet.slice(0, 40))}</option>`;
  }).join('');
}
function pushHistory(code, ok) {
  state.history.unshift({ code, ok, ts: Date.now() });
  state.history = state.history.slice(0, 20);
  renderHistorySelect();
  try {
    const serialized = JSON.stringify(state.history);
    // Defensive cap on top of the 20-entry bound above: guards against a
    // corrupted/oversized quota situation rather than any realistic script.
    if (serialized.length <= 200_000) localStorage.setItem(HISTORY_KEY, serialized);
  } catch { /* private mode, ignore */ }
}
historySelect.addEventListener('change', () => {
  const i = Number(historySelect.value);
  if (Number.isInteger(i) && state.history[i]) {
    editorEl.value = state.history[i].code;
    editorEl.focus();
  }
  historySelect.value = '';
});
// Restore past runs across reloads. Only ever touches state.history + the
// dropdown — editorEl.value keeps whatever DEFAULT_SCRIPT set it to above,
// so a reload never silently swaps in an old script underneath the user.
(function restoreHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    state.history = parsed.filter(h => h && typeof h.code === 'string').slice(0, 20);
    renderHistorySelect();
  } catch { /* private mode or corrupted entry, ignore */ }
})();

async function runScript(code, { record = true } = {}) {
  if (state.busy) return { ok: false, error: 'Already running.' };
  state.busy = true;
  runBtn.disabled = true;
  setStatus('Running…', 'busy');
  try {
    const msg = await cadWorker.run(code);
    state.lastMesh = msg.mesh;
    state.lastReport = msg.report;
    state.lastError = null;
    state.mode = 'authored'; // just which one is ON SCREEN — an imported reference
    // (state.referenceInfo, the worker's persistent Manifold) is deliberately left
    // alone here: that's the whole point of imported(), staying usable across runs.
    applyManifoldMesh(msg.mesh);
    updateReportPanel(msg.report);
    // applyManifoldMesh -> applyGeometry always hides emptyEl, even for a
    // 0-triangle result (empty geometry is still "a geometry") — an empty
    // result needs its own on-canvas explanation instead of a bare grid.
    if (msg.report.empty) {
      emptyEl.textContent = 'Empty result — the shapes may not overlap. Adjust the script and re-run.';
      emptyEl.hidden = false;
    } else {
      emptyEl.textContent = DEFAULT_EMPTY_HINT;
    }
    // A non-manifold (or NonFiniteVertex) result can still serialize to STL
    // bytes containing NaN/Infinity, and an empty (0-tri) one has nothing
    // to write at all — Export stays off until reportOk() says otherwise.
    exportBtn.disabled = !reportOk(msg.report);
    setStatus(formatReportLine(msg.report), reportOk(msg.report) ? 'ok' : 'bad');
    // reportOk, not bare success: an empty (0-tri) result still resolves —
    // manifold-3d reports NoError for it — so history would otherwise mark
    // an almost-certainly-wrong run with the same ✓ as a real one.
    if (record) pushHistory(code, reportOk(msg.report));
    return { ok: true, report: msg.report };
  } catch (err) {
    state.lastError = err.message;
    setStatus(err.message, 'bad');
    updateReportPanelError(err.message); // else the card keeps showing the previous (possibly green) run
    if (record) pushHistory(code, false);
    return { ok: false, error: err.message };
  } finally {
    state.busy = false;
    runBtn.disabled = false;
  }
}

function runCurrentScript() {
  state.code = editorEl.value;
  return runScript(state.code);
}
runBtn.addEventListener('click', runCurrentScript);
editorEl.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); runCurrentScript(); }
});

function doExport(filename) {
  const buffer = meshToSTL(state.lastMesh);
  const base = (filename || 'part').trim().replace(/\.stl$/i, '').replace(/[^\w.-]+/g, '_') || 'part';
  const name = `${base}.stl`;
  const blob = new Blob([buffer], { type: 'model/stl' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  return { filename: name, bytes: buffer.byteLength };
}
exportBtn.addEventListener('click', () => {
  if (!state.lastMesh || state.mode !== 'authored') return;
  if (!state.lastReport?.manifold) {
    setStatus(`Not manifold (${state.lastReport?.status ?? 'unknown'}) — fix the script before exporting.`, 'bad');
    return;
  }
  if (state.lastReport.empty) {
    setStatus('Nothing to export — result has 0 triangles.', 'bad');
    return;
  }
  doExport('part');
});

// ---------- WebMCP tool surface ----------
// Exposes the app's operations to any WebMCP-aware agent sharing this tab, via
// document.modelContext.registerTool() — an in-progress W3C Web Machine Learning CG
// proposal (github.com/webmachinelearning/webmcp). This replaced stl-webmcp's embedded
// first-party chat: no agent ships with the page anymore, so every call below comes from
// whatever browser-integrated agent the visitor brought. As of 2026 that's narrow — the
// ChatGPT desktop app's built-in browser supports it, but its own Chrome extension does
// not, nor does stock Chrome without an experimental flag/origin trial.
//
// capture_view from the old chat tool set is deliberately NOT ported: execute() may
// return any JSON-serializable value, but the spec has no defined shape for image/binary
// tool output yet ("multimodal input/output" is still open — see the explainer's Future
// Explorations section) — there is currently no way to hand an agent the PNG this tool
// used to return for visual verification. Re-add once a shape for that exists.
function registerWebMcpTools() {
  if (!('modelContext' in document)) return; // no WebMCP support in this browser — silent no-op, per the spec's own feature-detect guidance
  const tools = [
    {
      name: 'write_script',
      title: 'Write script',
      description: 'Replace the current CSG script and render it. Returns the render report (manifold check, triangle count, bbox) or a caught error to fix.',
      inputSchema: {
        type: 'object',
        properties: { code: { type: 'string', description: 'JS function body using the CSG API; must end with `return <shape>`.' } },
        required: ['code'],
      },
      annotations: { readOnlyHint: false },
      async execute({ code }) {
        editorEl.value = code;
        const result = await runScript(code);
        if (!result.ok) return { error: result.error };
        return { summary: formatReportLine(result.report), ...result.report };
      },
    },
    {
      name: 'get_render_report',
      title: 'Get render report',
      description: 'Current shape stats without re-rendering: manifold check, triangle/vertex count, bounding box, volume. If an imported file is open instead of an authored shape, returns its filename/triangle count/dimensions and whether it imported as a usable manifold (usable via imported() in scripts) or view-only (common for scanned/sculpted meshes) — this is the only way to learn that; raw geometry isn\'t readable, only what this reports. Also reports an imported file that exists but isn\'t currently on screen.',
      annotations: { readOnlyHint: true },
      async execute() {
        const result = {};
        if (state.mode === 'reference' && state.referenceInfo) {
          result.viewing = { mode: 'reference', ...state.referenceInfo };
        } else if (state.lastError) {
          return { error: state.lastError };
        } else if (state.lastReport) {
          result.viewing = { mode: 'authored', ...state.lastReport };
        } else {
          result.viewing = { mode: 'none' };
        }
        if (state.referenceInfo && state.mode !== 'reference') {
          result.alsoAvailable = { mode: 'reference', ...state.referenceInfo };
        }
        result.summary = result.viewing.mode === 'reference' ? formatReferenceLine(state.referenceInfo)
          : result.viewing.mode === 'authored' ? formatReportLine(state.lastReport) : 'No shape yet.';
        return result;
      },
    },
    {
      name: 'read_script',
      title: 'Read current script',
      description: 'Return the exact script currently loaded in the editor, in case a human edited it or the agent needs to patch it incrementally instead of rewriting from memory.',
      annotations: { readOnlyHint: true },
      async execute() { return { summary: `${editorEl.value.length} chars`, code: editorEl.value }; },
    },
    {
      name: 'export_stl',
      title: 'Export STL',
      description: 'Serialize the current authored shape to binary STL and download it. Only works for the authored shape, not an imported file opened for comparison.',
      inputSchema: { type: 'object', properties: { filename: { type: 'string', description: 'Base filename; .stl is added if missing.' } } },
      annotations: { readOnlyHint: false },
      async execute({ filename } = {}) {
        if (state.mode !== 'authored' || !state.lastMesh) return { error: 'No authored shape to export yet — run a script first.' };
        if (!state.lastReport?.manifold) return { error: `Not manifold (${state.lastReport?.status ?? 'unknown'}) — fix the script before exporting.` };
        if (state.lastReport.empty) return { error: 'Nothing to export — result has 0 triangles.' };
        const r = doExport(filename);
        return { summary: `Exported ${r.filename} (${r.bytes.toLocaleString()} bytes)` };
      },
    },
    {
      name: 'reset_script',
      title: 'Reset script',
      description: 'Clear the editor back to the starter template, remove the current shape, and drop the imported file (imported() stops working). Wipes in-progress work.',
      annotations: { readOnlyHint: false },
      async execute() {
        editorEl.value = DEFAULT_SCRIPT;
        state.code = DEFAULT_SCRIPT;
        clearModel();
        state.lastMesh = null; state.lastReport = null; state.lastError = null;
        state.mode = 'authored'; state.referenceInfo = null;
        emptyEl.textContent = DEFAULT_EMPTY_HINT;
        emptyEl.hidden = false; resetBtn.disabled = true; exportBtn.disabled = true;
        reportEl.hidden = true; setStatus('', '');
        try { await cadWorker.clearImport(); } catch { /* best-effort */ }
        return { summary: 'Script reset.' };
      },
    },
  ];
  for (const tool of tools) {
    document.modelContext.registerTool(tool).catch(err => {
      console.warn(`WebMCP: couldn't register tool "${tool.name}":`, err);
    });
  }
}
registerWebMcpTools();

// Not recorded to history: this fires on every load/reload, and history is
// for runs a human (or agent) actually chose, not the starter template
// re-appearing each time.
runScript(DEFAULT_SCRIPT, { record: false });

// ---------- Floating panel toggle ----------
// The editor pane is a position:fixed overlay (cad.css) — toggling it only
// slides a transform, it never resizes the canvas underneath. aria-expanded
// marks whether the panel is currently open (cad.css keys off the
// attribute, not a class); the panel used to also carry its own '✕' close
// button, redundant with the edge toggle that already opens/closes it —
// removed, so toggleBtn is the only way in or out.
function wirePanelToggle(toggleBtn, panelEl, storageKey) {
  const setOpen = (open) => {
    panelEl.dataset.open = String(open);
    toggleBtn.setAttribute('aria-expanded', String(open)); // styling keys off this, not a class — see cad.css
    try { localStorage.setItem(storageKey, open ? '1' : '0'); } catch { /* private mode, ignore */ }
  };
  toggleBtn.addEventListener('click', () => setOpen(panelEl.dataset.open !== 'true'));
  let stored = '1';
  try { stored = localStorage.getItem(storageKey) ?? '1'; } catch { /* private mode, ignore */ }
  setOpen(stored !== '0');
}
wirePanelToggle(
  document.getElementById('panel-toggle-left'),
  document.getElementById('editor-pane'), 'stl-webmcp-editor-open',
);

// ---------- App menu (the wordmark) ----------
// Disclosure, not role="menu" — see index.html for why. Dismiss grammar is
// the menu half of AGENTS.md § UI/UX principles (outside-click + Escape).
const appMenuBtn = document.getElementById('app-menu-btn');
const appMenuEl = document.getElementById('app-menu');
const historyCountEl = document.getElementById('menu-history-count');
const clearHistoryBtn = document.getElementById('menu-clear-history');

// The row states what it will discard rather than asking to confirm it: a
// count is cheaper to read than a modal is to dismiss, and at zero there's
// nothing to warn about, so the row just goes inert.
function syncHistoryMenuItem() {
  const n = state.history.length;
  historyCountEl.textContent = n ? String(n) : '';
  clearHistoryBtn.disabled = n === 0;
}
function setAppMenuOpen(open) {
  appMenuEl.hidden = !open;
  appMenuBtn.setAttribute('aria-expanded', String(open)); // cad.css keys the caret flip + accent off this, not a class
  if (open) syncHistoryMenuItem(); // history grows on every run — recount at open, not once at wire-up
}
appMenuBtn.addEventListener('click', () => setAppMenuOpen(appMenuEl.hidden));
document.addEventListener('click', (e) => {
  if (appMenuEl.hidden || appMenuEl.contains(e.target) || appMenuBtn.contains(e.target)) return;
  setAppMenuOpen(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || appMenuEl.hidden) return;
  setAppMenuOpen(false);
  appMenuBtn.focus(); // Escape hands focus back to whatever opened the menu
});

clearHistoryBtn.addEventListener('click', () => {
  state.history = [];
  renderHistorySelect();
  try { localStorage.removeItem(HISTORY_KEY); } catch { /* private mode, ignore */ }
  syncHistoryMenuItem();
});

// API_REFERENCE is kernel.js's CSG DSL reference; humans writing scripts by
// hand had no other way to read it, and each WebMCP tool's own description
// only documents that tool, not the whole DSL. textContent, not innerHTML —
// it's a plain string shown as-is, so there's no markup to sanitize and no
// markdown to parse.
const apiDialog = document.getElementById('api-dialog');
document.getElementById('api-dialog-body').textContent = API_REFERENCE.trim();
document.getElementById('menu-api').addEventListener('click', () => {
  setAppMenuOpen(false);
  apiDialog.showModal();
});
document.getElementById('api-dialog-close').addEventListener('click', () => apiDialog.close());

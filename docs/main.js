import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { mount } from './runtime/index.js';
import { meshToSTL } from './cad/stl-export.js';
import { API_REFERENCE } from './cad/kernel.js';

const DEFAULT_SCRIPT = `// Describe a part in chat, or write CSG here and hit Run (⌘⏎).
// cube({size,center}) · cylinder({height,radius,radiusTop,segments,center}) · sphere({radius,segments})
// union/subtract/intersect(...) · translate/rotate/scale/mirror(shape, v)

return cube({ size: [30, 20, 10], center: true });
`;

const VIEW_PRESETS = {
  iso: [1, 0.8, 1],
  front: [0, 0, 1],
  back: [0, 0, -1],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, 1, 1e-6],
  bottom: [0, -1, 1e-6],
};

// ---------- DOM refs ----------
const canvas = document.getElementById('gl');
const wireframeBtn = document.getElementById('vp-wireframe');
const gridBtn = document.getElementById('vp-grid');
const resetBtn = document.getElementById('vp-reset');
const openBtn = document.getElementById('vp-open');
const fileInput = document.getElementById('vp-file');
const exportBtn = document.getElementById('vp-export');
const emptyEl = document.getElementById('vp-empty');
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

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

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
  const groundY = box.min.y - center.y;
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
  return { size, box };
}

function captureView(preset = 'iso') {
  if (!mesh) throw new Error('No shape to view yet — run a script first.');
  const dir = VIEW_PRESETS[preset] || VIEW_PRESETS.iso;
  const v = new THREE.Vector3(...dir).normalize();
  camera.position.copy(v).multiplyScalar(Math.max(lastRadius * 2.6, lastRadius + 0.05));
  camera.near = Math.max(lastRadius / 100, 1e-4);
  camera.far = Math.max(lastRadius * 50, 10);
  camera.updateProjectionMatrix();
  controls.target.set(0, 0, 0);
  controls.update();
  renderer.render(scene, camera);
  const dataUrl = renderer.domElement.toDataURL('image/png');
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

wireframeBtn.addEventListener('click', () => {
  material.wireframe = !material.wireframe;
  wireframeBtn.textContent = `Wireframe: ${material.wireframe ? 'on' : 'off'}`;
  wireframeBtn.classList.toggle('on', material.wireframe);
  wireframeBtn.setAttribute('aria-pressed', String(material.wireframe));
});
gridBtn.addEventListener('click', () => {
  const on = !gridBtn.classList.contains('on');
  gridBtn.classList.toggle('on', on);
  gridBtn.setAttribute('aria-pressed', String(on));
  if (grid) grid.visible = on;
});
resetBtn.addEventListener('click', () => {
  if (!mesh) return;
  frameCamera(lastRadius, new THREE.Vector3(0, 0, 0));
});

(function tick() {
  controls.update();
  renderer.render(scene, camera);
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
    `<div class="${usable ? '' : 'vp-report-bad'}">${usable ? '✓ usable as imported()' : r.importStatus === 'pending' ? 'checking…' : '✗ view-only: ' + escapeHtml(r.importError || 'not a valid manifold')}</div>`;
  reportEl.hidden = false;
}

function handleReferenceFile(file) {
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
    setStatus(`Importing "${file.name}"…`, 'busy');

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
    const weldGeometry = geometry.clone();
    weldGeometry.deleteAttribute('normal');
    const welded = mergeVertices(weldGeometry);
    const positions = welded.attributes.position.array;
    const rawIndex = welded.index.array;
    const triVerts = rawIndex instanceof Uint32Array ? rawIndex : Uint32Array.from(rawIndex);

    try {
      const result = await cadWorker.import({ vertProperties: positions, triVerts, numProp: 3 });
      state.referenceInfo.importStatus = 'ok';
      updateReferenceReportPanel();
      setStatus(`Imported "${file.name}" — usable in scripts as imported(). ${formatReportLine(result.report)}`, 'ok');
    } catch (err) {
      // Not a bug — common for scanned/sculpted meshes. Still shown for
      // viewing; just not usable as a CSG operand.
      state.referenceInfo.importStatus = 'failed';
      state.referenceInfo.importError = err.message || String(err);
      updateReferenceReportPanel();
      setStatus(`"${file.name}" loaded for viewing — not usable in scripts: ${state.referenceInfo.importError}`, '');
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
  handleReferenceFile(e.dataTransfer.files[0]);
});

// ---------- CSG worker client ----------
// Note: a worker respawn (script timeout below) drops the persistent
// imported-reference state worker.js holds — the next imported() call
// throws its own clear "nothing imported yet" error rather than silently
// using stale data, so this degrades honestly rather than needing its own
// recovery path.
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
  }
  _failAll(message) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); }
    this.pending.clear();
  }
  _call(type, payload, timeoutMs, transfer) {
    const requestId = ++this.reqId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.worker.terminate();
        this._spawn();
        reject(new Error(`${type} timed out after ${timeoutMs}ms (possible infinite loop) — worker restarted.`));
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
function formatReferenceLine(r) {
  return `reference "${r.filename}" · ${r.numTri.toLocaleString()} tri · ${fmt(r.size.x)}×${fmt(r.size.y)}×${fmt(r.size.z)}`;
}

function fmt(n, d = 2) { return Number(n).toFixed(d); }
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = 'editor-status' + (kind ? ` ${kind}` : '');
}
function formatReportLine(r) {
  const [sx, sy, sz] = r.bbox.size;
  const flag = r.manifold ? '✓ manifold' : `✗ ${r.status}`;
  return `${flag} · ${r.numTri.toLocaleString()} tri · ${fmt(sx)}×${fmt(sy)}×${fmt(sz)}`;
}
function updateReportPanel(r) {
  const [sx, sy, sz] = r.bbox.size;
  reportEl.innerHTML =
    `<div class="${r.manifold ? '' : 'vp-report-bad'}">${r.manifold ? '✓ manifold' : '✗ ' + escapeHtml(r.status)}</div>` +
    `<div class="vp-report-dim">${r.numTri.toLocaleString()} triangles</div>` +
    `<div class="vp-report-dim">${fmt(sx)} × ${fmt(sy)} × ${fmt(sz)}</div>`;
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

function pushHistory(code, ok) {
  state.history.unshift({ code, ok, ts: Date.now() });
  state.history = state.history.slice(0, 20);
  historySelect.innerHTML = '<option value="">History…</option>' + state.history.map((h, i) => {
    const t = new Date(h.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const mark = h.ok ? '✓' : '✗';
    const snippet = h.code.trim().split('\n').find(l => l.trim() && !l.trim().startsWith('//')) || h.code.trim().slice(0, 40);
    return `<option value="${i}">${mark} ${t} — ${escapeHtml(snippet.slice(0, 40))}</option>`;
  }).join('');
}
historySelect.addEventListener('change', () => {
  const i = Number(historySelect.value);
  if (Number.isInteger(i) && state.history[i]) {
    editorEl.value = state.history[i].code;
    editorEl.focus();
  }
  historySelect.value = '';
});

async function runScript(code, { record = true } = {}) {
  state.busy = true;
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
    exportBtn.disabled = false;
    setStatus(formatReportLine(msg.report), msg.report.manifold ? 'ok' : 'bad');
    if (record) pushHistory(code, true);
    return { ok: true, report: msg.report };
  } catch (err) {
    state.lastError = err.message;
    setStatus(err.message, 'bad');
    if (record) pushHistory(code, false);
    return { ok: false, error: err.message };
  } finally {
    state.busy = false;
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
  doExport('part');
});

// ---------- WebMCP tool surface ----------
const SYSTEM_PROMPT_BASE = `You are the authoring assistant embedded in stl-studio, a browser CSG tool for
3D-printable parts. You write and iterate on a small JS CSG script via write_script; the page
renders it with manifold-3d, a boolean-CSG kernel that guarantees watertight output when it
succeeds. A status other than "NoError" means the geometry is NOT safe to print — treat that as a
bug to fix yourself, not a cosmetic warning to mention and move past.

Style — this is a working tool, not a conversation. The human is watching the viewport update
live; you're narrating decisions and flagging problems, not writing them a report.
- 1-3 short sentences by default. A finished part gets a status line, not a paragraph: "Plate with
  4 corner holes — manifold, 412 tri, 40×40×4mm." Numbers over adjectives.
- Don't re-explain what the tool can/can't do (primitives, no scanned-mesh support, etc.) more than
  once per conversation — you already said it; the human remembers.
- Asked a factual question ("what's loaded", "what are the dims") → answer it in one line and stop.
  Don't pad with unrequested aesthetic description or caveats that don't change what happens next.
- One crisp question when you genuinely need a decision from the human — never a paragraph of
  setup before it.
- Long explanation only when explicitly asked ("why", "explain", "walk me through it").

${API_REFERENCE}

Workflow:
1. write_script with your best attempt. Read the report it returns (manifold?, triangle count, bbox).
2. If it errored or came back non-manifold, fix the script and try again yourself before replying.
3. Before telling the human a shape is done, call capture_view (try 'iso', and 'front'/'top' when
   alignment matters) and actually look at the render — geometry can be manifold and still be
   wrong (a hole in the wrong spot, wrong proportions, a part mirrored).
4. Only call export_stl once the shape looks right and is manifold.

State whatever unit you're treating the numbers as (usually mm) so the human isn't left guessing.`;

function getSystemPrompt() {
  const lines = [SYSTEM_PROMPT_BASE, '', 'Current page state:'];
  if (state.busy) lines.push('- A script is currently running.');

  if (state.mode === 'reference' && state.referenceInfo) {
    lines.push(`- Viewport shows an IMPORTED file, not something you authored: ${formatReferenceLine(state.referenceInfo)}`);
    if (state.referenceInfo.importStatus === 'ok') {
      lines.push('- It imported as a valid manifold — call it with imported() in a script to compose it (union/subtract/intersect/transform) with primitives.');
    } else if (state.referenceInfo.importStatus === 'failed') {
      lines.push(`- It did NOT import as a usable shape (${state.referenceInfo.importError}) — view-only. Common for scanned/sculpted meshes. Describe what capture_view shows you; don't claim you can use it in a script.`);
    }
  } else if (state.lastError) {
    lines.push(`- Last run FAILED: ${state.lastError}`);
  } else if (state.lastReport) {
    lines.push(`- Current shape: ${formatReportLine(state.lastReport)}`);
  } else {
    lines.push('- No shape rendered yet.');
  }

  if (state.referenceInfo && state.mode !== 'reference') {
    const usable = state.referenceInfo.importStatus === 'ok';
    lines.push(`- Also available${usable ? ' via imported()' : ' (view-only, not usable in scripts)'}: ${formatReferenceLine(state.referenceInfo)}`);
  }

  return lines.join('\n');
}
function getDividerContext() {
  if (state.mode === 'reference' && state.referenceInfo) return [formatReferenceLine(state.referenceInfo)];
  return state.lastReport ? [formatReportLine(state.lastReport)] : [];
}

const TOOL_DEFS = [
  {
    name: 'write_script',
    title: 'Write CSG script',
    description: 'Replace the current CSG script and render it. Returns the render report (manifold check, triangle count, bbox) or a caught error to fix.',
    readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false,
    schema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'JS function body using the CSG API; must end with `return <shape>`.' } },
      required: ['code'],
    },
    exec: async ({ code }) => {
      editorEl.value = code;
      const result = await runScript(code);
      if (!result.ok) return { error: result.error };
      return { summary: formatReportLine(result.report), displayed: true, ...result.report };
    },
  },
  {
    name: 'get_render_report',
    title: 'Get render report',
    description: 'Current shape stats without re-rendering: manifold check, triangle/vertex count, bounding box, volume. If an imported file is open instead of an authored shape, returns its filename/triangle count/dimensions and whether it imported as a usable manifold (usable via imported() in scripts) or view-only (common for scanned/sculpted meshes) — this is your only way to learn that; you cannot read its raw geometry, only what this and capture_view show you. Also reports an imported reference that exists but isn\'t currently on screen.',
    readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false,
    schema: { type: 'object', properties: {} },
    exec: async () => {
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
    description: 'Return the exact script currently loaded in the editor, in case a human edited it or you need to patch it incrementally instead of rewriting from memory.',
    readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false,
    schema: { type: 'object', properties: {} },
    exec: async () => ({ summary: `${editorEl.value.length} chars`, code: editorEl.value }),
  },
  {
    name: 'capture_view',
    title: 'Capture viewport image',
    description: 'Render the current shape (or reference file, if one is open) from a named camera angle and return it as an image, so you can visually check the result instead of reasoning about numbers alone.',
    readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false,
    schema: {
      type: 'object',
      properties: { preset: { type: 'string', enum: Object.keys(VIEW_PRESETS), description: 'Camera angle. Default iso.' } },
    },
    exec: async ({ preset = 'iso' } = {}) => {
      let base64;
      try { base64 = captureView(preset); }
      catch (err) { return { error: err.message }; }
      const dims = state.mode === 'reference' && state.referenceInfo ? formatReferenceLine(state.referenceInfo)
        : state.lastReport ? formatReportLine(state.lastReport) : '';
      return [
        { type: 'text', text: `${preset} view${dims ? ' — ' + dims : ''}` },
        { type: 'image', data: base64, mimeType: 'image/png' },
      ];
    },
  },
  {
    name: 'export_stl',
    title: 'Export STL',
    description: 'Serialize the current authored shape to a binary .stl and download it. Only works for the authored shape, not a reference file opened for comparison.',
    readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false,
    schema: { type: 'object', properties: { filename: { type: 'string', description: 'Base filename; .stl is added if missing.' } } },
    exec: async ({ filename } = {}) => {
      if (state.mode !== 'authored' || !state.lastMesh) return { error: 'No authored shape to export yet — run a script first.' };
      const r = doExport(filename);
      return { summary: `Exported ${r.filename} (${r.bytes.toLocaleString()} bytes)`, displayed: true };
    },
  },
  {
    name: 'reset_script',
    title: 'Reset script',
    description: 'Clear the editor back to the starter template, remove the current shape, and drop any imported reference (imported() stops working). Wipes in-progress work.',
    readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false,
    schema: { type: 'object', properties: {} },
    exec: async () => {
      editorEl.value = DEFAULT_SCRIPT;
      state.code = DEFAULT_SCRIPT;
      clearModel();
      state.lastMesh = null; state.lastReport = null; state.lastError = null;
      state.mode = 'authored'; state.referenceInfo = null;
      emptyEl.hidden = false; resetBtn.disabled = true; exportBtn.disabled = true;
      reportEl.hidden = true; setStatus('', '');
      try { await cadWorker.clearImport(); } catch { /* best-effort */ }
      return { summary: 'Script reset.', displayed: true };
    },
  },
];

const QUICK_ACTIONS = [
  'A plate with 4 corner mounting holes',
  'A simple enclosure box with a lid lip',
  'A parametric L-bracket with 3 holes',
];

mount({
  tools: TOOL_DEFS,
  getSystemPrompt,
  getDividerContext,
  quickActions: QUICK_ACTIONS,
  // SDK isolation mode (requires a termd build with the settingSources knob — see
  // ../termd/server/turns.mjs): no ~/.claude/settings.json (hooks, output style), no
  // CLAUDE.md, no project/local settings. This assistant should only ever know what
  // getSystemPrompt() + API_REFERENCE tell it, never the operator's own Claude config.
  settingSources: [],
});

// ---------- Floating panel toggles ----------
// Editor and chat are position:fixed overlays (cad.css) — toggling them
// only slides a transform, it never resizes the canvas underneath. Each
// button's icon names which side it controls (fixed); .on marks whether
// that panel is currently open. One control per action: the panels used to
// also carry their own '✕' close button, redundant with the edge toggle
// that already opens/closes the same panel — removed, so toggleBtn is the
// only way in or out.
function wirePanelToggle(toggleBtn, panelEl, storageKey) {
  const setOpen = (open) => {
    panelEl.dataset.open = String(open);
    toggleBtn.setAttribute('aria-expanded', String(open));
    toggleBtn.classList.toggle('on', open);
    try { localStorage.setItem(storageKey, open ? '1' : '0'); } catch { /* private mode, ignore */ }
  };
  toggleBtn.addEventListener('click', () => setOpen(panelEl.dataset.open !== 'true'));
  let stored = '1';
  try { stored = localStorage.getItem(storageKey) ?? '1'; } catch { /* private mode, ignore */ }
  setOpen(stored !== '0');
}
wirePanelToggle(
  document.getElementById('panel-toggle-left'),
  document.getElementById('editor-pane'), 'stl-studio-editor-open',
);
wirePanelToggle(
  document.getElementById('panel-toggle-right'),
  document.getElementById('chat-panel-el'), 'stl-studio-chat-open',
);

// ---------- Chat settle announcer ----------
// #chat-messages used to carry aria-live="polite" itself (index.html) —
// vendored runtime/loop.js streams the assistant's reply into that div
// token-by-token as markdown renders, so a live region ON it announced
// every intermediate delta: a screen reader user got a word-by-word
// narration instead of a normal reply. Announce only that the exchange
// settled, via a separate, visually-hidden status region driven by a
// debounced MutationObserver — no message text mirrored, just the signal.
const chatMessagesEl = document.getElementById('chat-messages');
const chatLiveEl = document.createElement('div');
chatLiveEl.className = 'sr-only';
chatLiveEl.setAttribute('role', 'status');
chatLiveEl.setAttribute('aria-live', 'polite');
document.body.appendChild(chatLiveEl);
let chatSettleTimer = null;
new MutationObserver(() => {
  clearTimeout(chatSettleTimer);
  chatSettleTimer = setTimeout(() => { chatLiveEl.textContent = 'Assistant replied.'; }, 800);
}).observe(chatMessagesEl, { childList: true, subtree: true, characterData: true });

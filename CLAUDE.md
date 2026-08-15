# CLAUDE.md

Non-obvious design decisions and gotchas. Read the header comments in `main.js`, `cad/kernel.js`,
`cad/worker.js`, and `cad.css` for the full reasoning — this is the compressed index.

## Ownership boundary

- `app.css`, `chat.css`, `docs/runtime/` are ported UNMODIFIED from `../webmcp` — never edit them
  here; changes belong upstream. Only `cad.css`, `cad/`, `main.js`, `index.html` are stl-studio's own.
- `cad.css` loads last. `chat.css`'s `body{display:grid}` is `!important`, but its specific
  `grid-template-*` properties aren't — equal-specificity rules in `cad.css` win the cascade
  without needing `!important` of its own. All layout/style overrides go there, not upstream.

## manifold-3d memory model

- embind WASM heap objects are NOT JS-garbage-collected. `kernel.js`'s `buildAPI` tracks every
  shape a script creates (including boolean intermediates) in a per-run `track` set; `worker.js`
  `.delete()`s the whole set when the run ends.
- Exception: `worker.js`'s persistent `importedManifold` must NEVER go through that per-run track
  set, or it gets deleted the first time any script calls `imported()`.
- `new Manifold(mesh)` / `Manifold.ofMesh` THROW SYNCHRONOUSLY on non-2-manifold input — unlike
  booleans, this is not a build-then-check-`.status()` flow.
- A worker respawn on script timeout drops `worker.js`'s persistent imported reference. The next
  `imported()` call throws its own clear error rather than resurrecting stale state — intentional
  honest degradation, no recovery path needed.

## STL import

- Raw STL has no triangle connectivity, so it reads as "all boundary edges" to the manifold
  constructor regardless of whether the real shape is watertight. Weld via three's `mergeVertices`
  on a POSITION-ONLY clone before constructing — leaving normals attached blocks cross-face
  merging at shared corners (a known-good cube welds to 8 verts with normals stripped, only 24 —
  one per face corner — if they ride along).

## CSG / viewer gotchas

- `applyGeometry` in `main.js`: `geometry.translate()` mutates `boundingBox` in place, so the
  ground-plane Y must be captured BEFORE translating — reading `box.min.y` after double-subtracts
  center.y. Invisible on near-centered meshes; only bites meshes authored far from their own origin.
- `cube()/cylinder()/sphere()` default `center:false`. A `subtract()` where the base and its tool
  shapes disagree on centering silently no-ops (nothing overlaps, nothing gets cut) and still
  reports manifold-ok — check `center` on every operand first when a cut does nothing.

## Chat runtime

- `mount({settingSources: []})` in `main.js` is load-bearing: the embedded agent must only ever
  see this app's own system prompt (`getSystemPrompt()` + `API_REFERENCE`), never the operator's
  global `~/.claude` config. Requires a termd build with the `settingSources` knob (`../termd`).

## UI/UX reference

- Owner directive: use https://www.beautifului.dev/ ("Beautiful UI" — primitives for AI-native
  interfaces) as the reference for ALL UI/UX elements, icons, and effects.
- Its language, distilled: near-black neutral surfaces; hairline 1px borders and dotted dividers;
  ONE accent hue used sparingly; small rounded pills and segmented controls; tiny muted numbered/
  uppercase section labels; monospace tabular numerals for stats (elapsed time, counts, dims);
  tool calls as compact chips (icon + verb + mono detail, collapsible "N tool calls" summary);
  quiet human-in-the-loop approval cards; shimmer for loading; restrained motion.
- Pair it with termd's frosted-glass recipe already in `cad.css` (see ../termd/web/styles.css,
  glass-pill family): glass surfaces carry Beautiful UI's restraint and detailing.

## Build

- No build step: static `docs/` site, ESM imports straight from jsDelivr, no npm install/bundler.
  Verify JS changes with `node --check <file>`, not a dev server.

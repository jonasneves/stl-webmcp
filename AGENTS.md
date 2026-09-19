# AGENTS.md

Non-obvious design decisions and gotchas. Read the header comments in `main.js`, `cad/kernel.js`,
`cad/worker.js`, and `cad.css` for the full reasoning — this is the compressed index.

## Ownership boundary

- `app.css` (shared design tokens only — colors, spacing, radius, duration/ease, fonts) is ported
  UNMODIFIED from `../webmcp` — never edit it here; changes belong upstream. `cad.css`, `cad/`,
  `main.js`, `index.html` are stl-webmcp's own.
- `cad.css` loads last and owns the page's actual grid/layout outright (including `body`'s
  `display: grid`) — app.css's own `header`/`tools-panel`/`settings` component selectors don't
  match anything in this app's DOM; only its `:root` tokens are consumed here. All layout/style
  overrides go in `cad.css`, not upstream.

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

## WebMCP tool surface

- `main.js` registers `write_script`/`get_render_report`/`read_script`/`export_stl`/
  `reset_script` via `document.modelContext.registerTool()`
  (github.com/webmachinelearning/webmcp, an in-progress W3C proposal) — no embedded chat ships
  with the app; any browser-integrated agent sharing the tab calls these directly. Support is
  narrow as of 2026: the ChatGPT desktop app's built-in browser has it, its own Chrome extension
  and stock Chrome don't (without an experimental flag).
- `capture_view` from the old embedded-chat tool set is NOT ported: `execute` may return any
  JSON-serializable value, but the spec has no defined shape yet for image/binary tool output —
  there's no way to hand an agent the rendered PNG for visual verification. Re-add once one exists.

## UI/UX principles

Owner directive: use https://www.beautifului.dev/ ("Beautiful UI" — primitives for AI-native
interfaces) as the reference for ALL UI/UX elements, icons, and effects. Its language, distilled:
near-black neutral surfaces; hairline 1px borders and dotted dividers; ONE accent hue used
sparingly; small rounded pills and segmented controls; tiny muted numbered/uppercase section
labels; monospace tabular numerals for stats (elapsed time, counts, dims); shimmer for loading;
restrained motion. The material carrying it is termd's frosted glass (`../termd/web/styles.css`,
glass-pill family), recipe'd at the top of `cad.css`.

The rules below are how that directive binds in practice. Each names where it binds — this is the
index; the `cad.css` comment at that spot is the reasoning.

- **Glass is a claim, not a finish.** Chrome floats over a live WebGL scene, so it is glass
  *because something is behind it* — a header bar was the rejected alternative. One recipe, three
  tiers: small pills take the lit-rim shadow, large panels let blur alone carry depth, and a
  surface that isn't over the canvas gets neither.
- **Dark is frozen, not themed.** The canvas is `#14161c` in both themes, so every floating
  surface pins the dark token values regardless of `html[data-theme]` (§ Dark-glass token freeze).
  A new floating surface joins that selector list in the same edit or it silently forks accent/
  risk colors whenever the OS prefers light. There is no Appearance switcher — it had zero
  observable effect, so the design committed instead of shipping a dead control.
- **Every glass surface has an opaque twin.** `@supports not (backdrop-filter)` and
  `prefers-reduced-transparency / prefers-contrast / forced-colors` both swap in
  `--glass-fallback-*`. Effects that carry meaning degrade too — the busy shimmer falls back to
  plain muted text rather than risk transparent-on-transparent status copy. Adding a surface means
  adding it to both blocks.
- **Contrast is measured, not chosen.** `app.css` states its ratios inline (`--text-source` 6.34:1,
  `--text-caveat` 6.23:1); new color over the frozen surface states its own the same way.
- **Color is never the only carrier.** `.vp-report` / `.editor-status` pair hue with a ✓/✗ glyph.
  Where a second channel isn't reachable, stay quiet and say why in the comment; never fake it.
- **Floors are themed once; exemptions name their reason.** Focus is `2px solid var(--accent)` on
  every control, restyled per control but never removed. Touch targets: SC 2.5.8's 24px is a
  mouse-era number, bumped to 40px under `@media (pointer: coarse)` only where the input is one.
- **Dismiss grammar.** The app menu popover: outside-click + Escape. `#api-dialog`: its own ×
  button or Escape only (native `<dialog>` already gives the latter for free).
- **Destructive actions cue on interaction, not at rest.** The app menu's clear-history item
  turns `--risk-high` on hover/focus instead of wearing red permanently. Where the cost is
  countable, show the count rather than adding a confirm step.
- **CSS comments carry WHY** — the rejected alternative, the measured constraint, the cross-file
  invariant. Restating the declaration underneath is the cut.

## Build

- No build step: static `docs/` site, ESM imports straight from jsDelivr, no npm install/bundler.
  Verify JS changes with `node --check <file>`, not a dev server.

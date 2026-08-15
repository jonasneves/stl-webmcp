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

## UI/UX principles

Owner directive: use https://www.beautifului.dev/ ("Beautiful UI" — primitives for AI-native
interfaces) as the reference for ALL UI/UX elements, icons, and effects. Its language, distilled:
near-black neutral surfaces; hairline 1px borders and dotted dividers; ONE accent hue used
sparingly; small rounded pills and segmented controls; tiny muted numbered/uppercase section
labels; monospace tabular numerals for stats (elapsed time, counts, dims); tool calls as compact
chips (icon + verb + mono detail, collapsible "N tool calls" summary); quiet human-in-the-loop
approval cards; shimmer for loading; restrained motion. The material carrying it is termd's
frosted glass (`../termd/web/styles.css`, glass-pill family), recipe'd at the top of `cad.css`.

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
  Where the second channel isn't reachable — `.chat-divider` is one unmarked `textContent` run with
  no sub-span to recolor — stay quiet and say why in the comment; never fake it.
- **Floors are themed once; exemptions name their reason.** Focus is `2px solid var(--accent)` on
  every control, restyled per control but never removed. Touch targets: SC 2.5.8's 24px is a
  mouse-era number, bumped to 40px under `@media (pointer: coarse)` only where the input is one.
- **Dismiss grammar.** Popovers and menus (settings, tools, app menu): outside-click + Escape.
  Dialogs (`#confirm-dialog`, `#prompt-dialog`): their own buttons or Escape only — an outside
  click would drop an in-flight approval.
- **Destructive actions cue on interaction, not at rest.** `#chat-reset` and the app menu's
  clear-history item turn `--risk-high` on hover/focus instead of wearing red permanently, which
  would compete with the tool cards' own risk badges. Where the cost is countable, show the count
  rather than adding a confirm step.
- **Style the vendored DOM; never edit it.** Every selector in § Chat tool cards was grepped out of
  `docs/runtime/*.js` — none invented, no DOM or JS changed. When the reference wants a DOM change
  (Beautiful UI's collapsible "N tool calls" summary), record it as skipped in the comment rather
  than reaching upstream.
- **CSS comments carry WHY** — the rejected alternative, the measured constraint, the cross-file
  invariant. Restating the declaration underneath is the cut.

## Build

- No build step: static `docs/` site, ESM imports straight from jsDelivr, no npm install/bundler.
  Verify JS changes with `node --check <file>`, not a dev server.

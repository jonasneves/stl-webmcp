# stl-studio

Browser-native STL viewer and CSG authoring studio. Write (or ask Claude to write) a
parametric CSG script, watch it render live, export a manifold `.stl` — no CAD account,
no upload, nothing leaves the device.

Open [`docs/index.html`](./docs/index.html) directly in a browser, or serve `docs/` as a
static site (GitHub Pages, Cloudflare Pages, etc.).

- **Script editor** — a small JS CSG DSL (`cube`/`cylinder`/`sphere`, `union`/`subtract`/
  `intersect`, `translate`/`rotate`/`scale`/`mirror`) compiled with
  [manifold-3d](https://github.com/elalish/manifold) in a Web Worker, so a heavy boolean
  op — or a runaway script — never freezes the UI. `⌘⏎`/`Ctrl⏎` to run; a caught error
  keeps the last good render on screen instead of clearing it.
- **AI Chat** — an embedded local agent (same pattern as [`webmcp`](../webmcp):
  `termd`-driven, no API key in the page) that writes the script, reads back the render
  report (manifold check, triangle count, bbox), and can *look at* the rendered shape via
  `capture_view` before calling it done. Tools: `write_script`, `get_render_report`,
  `read_script`, `capture_view`, `export_stl`, `reset_script`. Runs under termd's
  `settingSources: []` isolation — it only ever sees this app's own system prompt, never
  the operator's global CLAUDE.md/output-style/hooks (needs a termd build that has the
  `settingSources` knob; see `../termd`).
- **Import** — drag-and-drop or file-picker load of an existing `.stl`. Always shown for
  viewing; if it's (or welds into) a valid manifold, it's also usable in scripts via
  `imported()`, composable with primitives via the same union/subtract/intersect/transform
  API. Scanned/sculpted meshes often aren't watertight — those stay view-only, and the
  tool says why rather than pretending it worked.
- The script editor and chat are floating overlays, not a fixed layout split — the
  viewport always renders at full size, and each panel toggles independently (edge
  buttons, state persisted per-browser).

See [`CLAUDE.md`](./CLAUDE.md) for the non-obvious design decisions and gotchas.

## Why this exists

[`robot-studio`](../robot-studio) already renders STL meshes, but only as parts of a URDF
robot assembly — there's no "just open a mesh," let alone "author one from a prompt,"
entry point. This is that entry point.

## Stack

Three.js + manifold-3d, both loaded as ESM from jsDelivr (import map for three.js;
manifold-3d dynamically imported inside the worker). No npm install, no bundler. The
chat runtime (`docs/runtime/`) and shared chrome (`app.css`, `chat.css`) are ported
unmodified from [`webmcp`](../webmcp) — only `cad.css`/`cad/`/`main.js` are stl-studio's
own.

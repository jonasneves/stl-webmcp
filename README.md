# stl-webmcp

Browser-native STL viewer and CSG authoring studio. Write a parametric CSG script by
hand, or let a WebMCP-aware agent drive it directly; watch it render live, export a
manifold `.stl` — no CAD account, no upload, nothing leaves the device.

Open [`docs/index.html`](./docs/index.html) directly in a browser, or serve `docs/` as a
static site (GitHub Pages, Cloudflare Pages, etc.).

- **Script editor** — a small JS CSG DSL (`cube`/`cylinder`/`sphere`, `union`/`subtract`/
  `intersect`, `translate`/`rotate`/`scale`/`mirror`) compiled with
  [manifold-3d](https://github.com/elalish/manifold) in a Web Worker, so a heavy boolean
  op — or a runaway script — never freezes the UI. `⌘⏎`/`Ctrl⏎` to run; a caught error
  keeps the last good render on screen instead of clearing it.
- **WebMCP tools** — no embedded chat; instead the page registers `write_script`,
  `get_render_report`, `read_script`, `export_stl`, and `reset_script` via
  `document.modelContext.registerTool()`
  ([WebMCP](https://github.com/webmachinelearning/webmcp), an in-progress W3C Web Machine
  Learning CG proposal), so any browser-integrated agent sharing the tab can drive the
  app directly. Support is narrow as of 2026 — the ChatGPT desktop app's built-in browser
  has it; its own Chrome extension and stock Chrome don't, without an experimental flag.
  `capture_view` isn't ported: the spec has no defined shape yet for image/binary tool
  output, so there's currently no way to hand an agent the render for visual
  verification.
- **Import** — drag-and-drop or file-picker load of an existing `.stl`. Always shown for
  viewing; if it's (or welds into) a valid manifold, it's also usable in scripts via
  `imported()`, composable with primitives via the same union/subtract/intersect/transform
  API. Scanned/sculpted meshes often aren't watertight — those stay view-only, and the
  tool says why rather than pretending it worked.
- The script editor is a floating overlay, not a fixed layout split — the viewport
  always renders at full size, and the panel toggles independently (edge button, state
  persisted per-browser).

**From Claude, Cursor or VS Code.** The page loads `relay.neves.cloud/webmcp.js`, from an MCP relay the author runs on Cloudflare. A visitor who presses **Use in Claude** gets one-click Add buttons with a private address for their tab; their AI app's tool calls then reach this page through the relay, and the results come back the same way. The relay passes them through and does not store them. Nothing connects until that button is pressed. In a browser without `document.modelContext`, the script provides one so the tools register anyway.

See [`AGENTS.md`](./AGENTS.md) for the non-obvious design decisions and gotchas.

## Why this exists

[`robot-studio`](../robot-studio) already renders STL meshes, but only as parts of a URDF
robot assembly — there's no "just open a mesh," let alone "author one parametrically,"
entry point. This is that entry point.

## Stack

Three.js + manifold-3d, both loaded as ESM from jsDelivr (import map for three.js;
manifold-3d dynamically imported inside the worker). No npm install, no bundler.
`app.css` (shared design tokens — colors, spacing, radius, fonts) is ported unmodified
from [`webmcp`](../webmcp) — `cad.css`/`cad/`/`main.js`/`index.html` are stl-webmcp's
own.

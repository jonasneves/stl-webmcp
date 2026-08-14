// CSG scripting kernel. Runs inside cad/worker.js only — never on the main
// thread. Wraps manifold-3d into a small, LLM-friendly functional API and
// reports geometry health (manifoldness, triangle count, bbox) back out.
//
// manifold-3d API surface used here (verified against manifold.d.ts,
// package manifold-3d@3.5.1 as published on jsdelivr):
//   - Manifold.cube/cylinder/sphere are STATIC factories.
//   - Boolean ops are INSTANCE methods: .add() / .subtract() / .intersect()
//     — there is no .union() on the instance; "union" below is our name for
//     a chain of .add(), chosen because it's the term CSG scripts (OpenSCAD,
//     JSCAD) conventionally use.
//   - .translate()/.rotate() (degrees)/.scale()/.mirror() are transforms.
//   - .getMesh() returns { vertProperties: Float32Array (interleaved,
//     stride = numProp), triVerts: Uint32Array (3 indices/tri), numProp }.
//   - .status() returns 'NoError' when the result is a valid manifold —
//     this is the watertightness check the whole kernel exists to expose.

const MANIFOLD_CDN = 'https://cdn.jsdelivr.net/npm/manifold-3d@3.5.1/manifold.js';

let ManifoldCtor = null;

export async function loadManifold() {
  if (ManifoldCtor) return ManifoldCtor;
  const { default: Module } = await import(MANIFOLD_CDN);
  const wasm = await Module();
  wasm.setup();
  ManifoldCtor = wasm.Manifold;
  return ManifoldCtor;
}

function vec3(v, fallback = 0) {
  if (Array.isArray(v)) return [v[0] ?? fallback, v[1] ?? fallback, v[2] ?? fallback];
  if (typeof v === 'number') return [v, v, v];
  return [fallback, fallback, fallback];
}

// `track` is called with every Manifold instance this API creates —
// including intermediate results inside union/subtract/intersect chains —
// so the caller can free the WASM-side memory after the script finishes.
// manifold-3d objects are embind-wrapped WASM heap allocations; they are
// not garbage-collected by the JS GC, so a script run that doesn't dispose
// its intermediates leaks WASM heap across every re-run.
export function buildAPI(Manifold, track) {
  const T = (m) => { track(m); return m; };
  return {
    cube(opts = {}) {
      return T(Manifold.cube(vec3(opts.size ?? 1, 1), !!opts.center));
    },
    cylinder(opts = {}) {
      const radius = opts.radius ?? 1;
      return T(Manifold.cylinder(
        opts.height ?? 1, radius, opts.radiusTop ?? radius,
        opts.segments ?? 48, !!opts.center,
      ));
    },
    sphere(opts = {}) {
      return T(Manifold.sphere(opts.radius ?? 1, opts.segments ?? 48));
    },
    union(...shapes) {
      shapes = shapes.flat();
      if (!shapes.length) throw new Error('union() needs at least one shape');
      return shapes.reduce((a, b) => T(a.add(b)));
    },
    subtract(base, ...tools) {
      tools = tools.flat();
      if (!tools.length) throw new Error('subtract() needs at least one tool shape to remove');
      return tools.reduce((a, b) => T(a.subtract(b)), base);
    },
    intersect(...shapes) {
      shapes = shapes.flat();
      if (shapes.length < 2) throw new Error('intersect() needs at least two shapes');
      return shapes.reduce((a, b) => T(a.intersect(b)));
    },
    translate(shape, v) { return T(shape.translate(vec3(v))); },
    rotate(shape, v) { return T(shape.rotate(vec3(v))); },
    scale(shape, v) { return T(shape.scale(vec3(v, 1))); },
    mirror(shape, normal) { return T(shape.mirror(vec3(normal))); },
  };
}

const OK_STATUS = 'NoError';

export function reportFor(shape) {
  const status = shape.status();
  const bbox = shape.boundingBox();
  const size = [
    bbox.max[0] - bbox.min[0],
    bbox.max[1] - bbox.min[1],
    bbox.max[2] - bbox.min[2],
  ];
  return {
    manifold: status === OK_STATUS,
    status,
    numTri: shape.numTri(),
    numVert: shape.numVert(),
    genus: shape.genus(),
    volume: shape.volume(),
    surfaceArea: shape.surfaceArea(),
    bbox: { min: [...bbox.min], max: [...bbox.max], size },
  };
}

export function extractMesh(shape) {
  const m = shape.getMesh();
  return { vertProperties: m.vertProperties, triVerts: m.triVerts, numProp: m.numProp };
}

// Static reference, embedded in the chat system prompt (see main.js) so the
// model has the API surface without spending a tool round-trip on it.
export const API_REFERENCE = `
CSG scripting API (plain JS, runs sandboxed — no DOM/network/imports available):

Primitives (return a shape):
  cube({ size: number|[x,y,z] = 1, center = false })
  cylinder({ height = 1, radius = 1, radiusTop = radius, segments = 48, center = false })
  sphere({ radius = 1, segments = 48 })

Booleans (each arg is a shape; extras allowed):
  union(...shapes)         // combine
  subtract(base, ...tools) // base minus every tool
  intersect(...shapes)     // overlap only

Transforms (return a NEW shape — these do not mutate their argument):
  translate(shape, [x,y,z])
  rotate(shape, [x,y,z])    // degrees, around each axis
  scale(shape, number|[x,y,z])
  mirror(shape, [nx,ny,nz]) // reflect across the plane through the origin with this normal

The script body must end with \`return <shape>\`. Units are whatever you intend them
to be (this tool has no fixed unit) — state your convention (usually mm) in the reply.
Compose with plain JS: variables, loops, functions, arrays of shapes reduced with union(...).

Example — a plate with four corner mounting holes:
  const plate = cube({ size: [40, 40, 4], center: true }); // center:true — positions below are relative to the plate's own center, not its corner
  const hole = () => cylinder({ height: 10, radius: 2, segments: 24, center: true }); // taller than the plate so it cuts all the way through
  const positions = [[-15,-15,0], [15,-15,0], [-15,15,0], [15,15,0]];
  const holes = positions.map(p => translate(hole(), p));
  return subtract(plate, ...holes);

cube()/cylinder()/sphere() default to center:false (origin corner, not centered) — mismatching an
uncentered base shape against hole positions meant for a centered one is the most common way a
subtract() silently does nothing (the tool shapes don't overlap the base, so nothing gets cut,
and the script still reports ok/manifold because "no-op" is still a valid manifold). If a
subtract you expected to carve a hole reports the SAME triangle count and dimensions as before
the cut, check center on every shape involved before anything else.
`.trim();

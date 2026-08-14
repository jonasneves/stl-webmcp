// Pure mesh -> binary STL serialization. No WASM, no dependencies — usable
// from the main thread (export) or a worker alike. Kept separate from
// kernel.js so exporting the last-good mesh never needs another worker
// round-trip (and never touches a WASM object after the worker has already
// disposed it).

export function meshToSTL(mesh) {
  const { vertProperties, triVerts, numProp } = mesh;
  const triCount = triVerts.length / 3;
  const buf = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buf);
  let off = 84;

  const vx = i => vertProperties[i * numProp];
  const vy = i => vertProperties[i * numProp + 1];
  const vz = i => vertProperties[i * numProp + 2];

  for (let t = 0; t < triCount; t++) {
    const ia = triVerts[t * 3], ib = triVerts[t * 3 + 1], ic = triVerts[t * 3 + 2];
    const ax = vx(ia), ay = vy(ia), az = vz(ia);
    const bx = vx(ib), by = vy(ib), bz = vz(ib);
    const cx = vx(ic), cy = vy(ic), cz = vz(ic);

    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const wx = cx - ax, wy = cy - ay, wz = cz - az;
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;

    view.setFloat32(off, nx, true); view.setFloat32(off + 4, ny, true); view.setFloat32(off + 8, nz, true);
    view.setFloat32(off + 12, ax, true); view.setFloat32(off + 16, ay, true); view.setFloat32(off + 20, az, true);
    view.setFloat32(off + 24, bx, true); view.setFloat32(off + 28, by, true); view.setFloat32(off + 32, bz, true);
    view.setFloat32(off + 36, cx, true); view.setFloat32(off + 40, cy, true); view.setFloat32(off + 44, cz, true);
    view.setUint16(off + 48, 0, true);
    off += 50;
  }
  view.setUint32(80, triCount, true);
  return buf;
}

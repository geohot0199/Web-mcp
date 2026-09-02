import * as THREE from 'three';

/*
 * Orbit STL export
 * ----------------
 * The viewport is a real 3D scene, but a naive `STLExporter.parse(scene)` can still
 * emit surfaces that are not a 3D body: an infinitely thin `PlaneGeometry` writes two
 * flat triangles, a scale axis collapsed to ~0 writes a flat sheet, and mirrored
 * (negative determinant) transforms write inverted facets. Opened in a slicer or an
 * STL viewer those read as a flat, "2D" model.
 *
 * This module always writes a real 3D solid:
 *   - every form is baked into world space with its own transform,
 *   - flat primitives are thickened into a slab before triangulation,
 *   - degenerate/zero-area triangles are dropped,
 *   - facet normals are recomputed and re-wound for mirrored transforms.
 *
 * Two export flavours are supported:
 *   - 'color' : binary STL carrying per-facet colour (Materialise Magics convention,
 *               plus a `COLOR=` header) so colour-aware viewers show the palette.
 *   - 'solid' : one uniform dark grey body, fully opaque, no colour attributes —
 *               the plain, maximally compatible STL every slicer understands.
 */

/* A facet thinner than this (in scene units) is not a printable body. */
export const MIN_SOLID_THICKNESS = 0.04;
/* Local thickness given to flat `plane` forms, matching their listed base dimension. */
export const PLANE_THICKNESS = 0.025;
/* Solid mode surface: dark, fully opaque grey — deliberately darker than the studio default. */
export const SOLID_EXPORT_COLOR = '#3f3f3f';

export const EXPORT_MODES = {
  color: {
    id: 'color',
    label: 'Colour',
    suffix: 'colour',
    summary: 'Per-facet colour baked into the STL'
  },
  solid: {
    id: 'solid',
    label: 'Solid',
    suffix: 'solid',
    summary: 'One uniform dark grey, fully opaque body'
  }
};

export function normaliseExportMode(mode) {
  return EXPORT_MODES[mode] ? mode : 'color';
}

function hexToRgb(hex) {
  const value = typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#808080';
  return {
    r: parseInt(value.slice(1, 3), 16),
    g: parseInt(value.slice(3, 5), 16),
    b: parseInt(value.slice(5, 7), 16)
  };
}

/* Magics per-facet colour: bits 0-4 red, 5-9 green, 10-14 blue, bit 15 = 0 for own colour. */
function packFacetColor({ r, g, b }) {
  const to5 = (channel) => Math.max(0, Math.min(31, Math.round((channel / 255) * 31)));
  return (to5(r)) | (to5(g) << 5) | (to5(b) << 10);
}

/*
 * Pull world-space triangles out of anything mesh-like below `root`.
 * Meshes flagged `userData.excludeFromExport` (helpers, floor, overlays) are ignored.
 */
export function collectExportTriangles(root) {
  const triangles = [];
  let degenerate = 0;
  let meshCount = 0;

  root.updateMatrixWorld(true);

  root.traverse((object) => {
    if (!object.isMesh || !object.geometry || object.userData?.excludeFromExport) return;
    if (object.visible === false) return;

    const geometry = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry;
    const position = geometry.getAttribute('position');
    if (!position) return;

    meshCount += 1;
    const matrix = object.matrixWorld;
    const mirrored = new THREE.Matrix4().copy(matrix).determinant() < 0;
    const color = hexToRgb(object.userData?.exportColor);

    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const normal = new THREE.Vector3();

    for (let i = 0; i < position.count; i += 3) {
      a.fromBufferAttribute(position, i).applyMatrix4(matrix);
      b.fromBufferAttribute(position, i + 1).applyMatrix4(matrix);
      c.fromBufferAttribute(position, i + 2).applyMatrix4(matrix);

      // A mirrored transform reverses winding; flip it back so the solid stays outward facing.
      if (mirrored) {
        const swap = b.x, swapY = b.y, swapZ = b.z;
        b.set(c.x, c.y, c.z);
        c.set(swap, swapY, swapZ);
      }

      ab.subVectors(b, a);
      ac.subVectors(c, a);
      normal.crossVectors(ab, ac);
      const length = normal.length();
      if (!Number.isFinite(length) || length < 1e-12) {
        degenerate += 1;
        continue;
      }
      normal.divideScalar(length);

      triangles.push({
        a: a.clone(),
        b: b.clone(),
        c: c.clone(),
        normal: normal.clone(),
        color
      });
    }

    if (geometry !== object.geometry) geometry.dispose();
  });

  return { triangles, degenerate, meshCount };
}

/* World bounds of the collected facets — used to prove the export is genuinely 3D. */
export function trianglesBounds(triangles) {
  const box = new THREE.Box3();
  triangles.forEach((triangle) => {
    box.expandByPoint(triangle.a);
    box.expandByPoint(triangle.b);
    box.expandByPoint(triangle.c);
  });
  if (box.isEmpty()) return { size: [0, 0, 0], flat: true, thinnestAxis: 0 };
  const size = new THREE.Vector3();
  box.getSize(size);
  const dimensions = [size.x, size.y, size.z];
  return {
    size: dimensions.map((value) => Number(value.toFixed(4))),
    thinnestAxis: Math.min(...dimensions),
    flat: Math.min(...dimensions) < MIN_SOLID_THICKNESS / 2
  };
}

function writeHeader(bytes, mode, solidColor) {
  // Must never start with "solid" or readers treat the binary file as ASCII.
  const text = mode === 'color'
    ? 'Orbit 3D studio export - colour STL COLOR='
    : 'Orbit 3D studio export - solid STL';
  const encoded = new TextEncoder().encode(text);
  const limit = Math.min(encoded.length, mode === 'color' ? 74 : 80);
  for (let i = 0; i < limit; i += 1) bytes[i] = encoded[i];
  if (mode === 'color') {
    // Materialise Magics global colour: COLOR= followed by R,G,B,A bytes.
    const rgb = hexToRgb(solidColor);
    bytes[limit] = rgb.r;
    bytes[limit + 1] = rgb.g;
    bytes[limit + 2] = rgb.b;
    bytes[limit + 3] = 255;
  }
}

/*
 * Serialise world-space triangles into a binary STL.
 * `mode` = 'color' writes per-facet colour attributes; 'solid' writes plain facets.
 */
export function buildBinarySTL(triangles, { mode = 'color', solidColor = SOLID_EXPORT_COLOR } = {}) {
  const flavour = normaliseExportMode(mode);
  const buffer = new ArrayBuffer(84 + triangles.length * 50);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  writeHeader(bytes, flavour, flavour === 'solid' ? solidColor : '#ffffff');
  view.setUint32(80, triangles.length, true);

  let offset = 84;
  const uniform = packFacetColor(hexToRgb(solidColor));

  triangles.forEach((triangle) => {
    view.setFloat32(offset, triangle.normal.x, true);
    view.setFloat32(offset + 4, triangle.normal.y, true);
    view.setFloat32(offset + 8, triangle.normal.z, true);
    let cursor = offset + 12;
    [triangle.a, triangle.b, triangle.c].forEach((vertex) => {
      view.setFloat32(cursor, vertex.x, true);
      view.setFloat32(cursor + 4, vertex.y, true);
      view.setFloat32(cursor + 8, vertex.z, true);
      cursor += 12;
    });
    // Solid mode stays a plain STL (attribute 0) so every slicer reads it identically.
    view.setUint16(cursor, flavour === 'color' ? packFacetColor(triangle.color) : 0, true);
    offset += 50;
  });

  return { buffer, triangleCount: triangles.length, uniform };
}

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
 * This module always writes real 3D solids:
 *   - every form is baked into world space with its own transform,
 *   - flat primitives are thickened into a slab before triangulation,
 *   - degenerate/zero-area triangles are dropped,
 *   - facet normals are recomputed and re-wound for mirrored transforms,
 *   - forms that interpenetrate (including exact duplicates) are detected up front
 *     and reported as an informational note on the finished file — the download is
 *     never blocked (no boolean union is performed, so every exported form stays
 *     its own closed shell).
 *
 * Two export flavours are supported:
 *   - 'color' : binary STL carrying per-facet colour in the Materialise Magics
 *               convention (plus a `COLOR=` header). Instead of a flat colour, a
 *               mesh may provide a `userData.exportColorAt(u, v)` sampler, which is
 *               invoked per facet so procedural textures can be baked into the file.
 *               Note: this is deliberately *not* the VisCAM/SolidView convention —
 *               see `packFacetColor` below.
 *   - 'solid' : a plain, attribute-free STL. The file carries no colour data at all;
 *               slicers and viewers shade it with their own default grey. The dark
 *               `#3f3f3f` look is only the in-app preview of this flavour.
 */

/* A facet thinner than this (in scene units) is not a printable body. */
export const MIN_SOLID_THICKNESS = 0.04;
/* Local thickness given to flat `plane` forms, matching their listed base dimension. */
export const PLANE_THICKNESS = 0.025;
/*
 * Solid mode preview surface: dark, fully opaque grey. The exported solid STL itself
 * is uncoloured — this constant only drives the viewport preview and the chat card
 * reporting, never the file's bytes.
 */
export const SOLID_EXPORT_COLOR = '#3f3f3f';

export const EXPORT_MODES = {
  color: {
    id: 'color',
    label: 'Colour',
    suffix: 'colour',
    summary: 'Per-facet scene colour baked into the STL, textures sampled per facet'
  },
  solid: {
    id: 'solid',
    label: 'Solid',
    suffix: 'solid',
    summary: 'Plain, uncoloured solid — viewers shade it with their own default grey'
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

function clampRgb({ r, g, b }) {
  const channel = (value) => Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
  return { r: channel(r), g: channel(g), b: channel(b) };
}

/*
 * Per-facet colour in the Materialise Magics convention: bits 0-4 red, 5-9 green,
 * 10-14 blue, bit 15 clear = the facet carries its own colour (set = no own colour).
 *
 * This is deliberately NOT the VisCAM/SolidView convention, which is incompatible in
 * both respects: VisCAM expects bit 15 *set* for a valid colour and stores the channels
 * mirrored (blue in bits 0-4, red in bits 10-14). One attribute word cannot satisfy
 * both readers, so Orbit writes and documents Magics only; VisCAM-style readers ignore
 * the colours and still read the solid geometry.
 */
function packFacetColor({ r, g, b }) {
  const to5 = (channel) => Math.max(0, Math.min(31, Math.round((channel / 255) * 31)));
  return (to5(r)) | (to5(g) << 5) | (to5(b) << 10);
}

/*
 * Pull world-space triangles out of anything mesh-like below `root`.
 * Meshes flagged `userData.excludeFromExport` (helpers, floor, overlays) are ignored.
 *
 * Per mesh, the colour comes from `userData.exportColor` (a hex string) or, when
 * present, from a `userData.exportColorAt(u, v)` sampler called with each facet's UV
 * centroid — that is how procedural texture colours are baked into colour exports.
 * The result also groups triangles per mesh (`meshes`), which is what the
 * form-intersection detection below works on.
 */
export function collectExportTriangles(root) {
  const triangles = [];
  const meshes = [];
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
    const meshRecord = { index: meshCount - 1, name: object.name || `form ${meshCount}`, triangles: [] };
    meshes.push(meshRecord);
    const matrix = object.matrixWorld;
    const mirrored = new THREE.Matrix4().copy(matrix).determinant() < 0;
    const color = hexToRgb(object.userData?.exportColor);
    let sampler = typeof object.userData?.exportColorAt === 'function' ? object.userData.exportColorAt : null;
    const uvAttribute = sampler ? geometry.getAttribute('uv') : null;
    if (sampler && (!uvAttribute || uvAttribute.count !== position.count)) sampler = null;

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

      let colorForFacet = color;
      if (sampler) {
        try {
          const sampled = sampler(
            (uvAttribute.getX(i) + uvAttribute.getX(i + 1) + uvAttribute.getX(i + 2)) / 3,
            (uvAttribute.getY(i) + uvAttribute.getY(i + 1) + uvAttribute.getY(i + 2)) / 3
          );
          if (sampled && Number.isFinite(sampled.r + sampled.g + sampled.b)) {
            colorForFacet = clampRgb(sampled);
          }
        } catch (_) {
          // A broken sampler must never break the export; fall back to the base colour.
          sampler = null;
        }
      }

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

      const triangle = {
        a: a.clone(),
        b: b.clone(),
        c: c.clone(),
        normal: normal.clone(),
        color: colorForFacet,
        meshIndex: meshRecord.index,
        meshName: meshRecord.name
      };
      triangles.push(triangle);
      meshRecord.triangles.push(triangle);
    }

    if (geometry !== object.geometry) geometry.dispose();
  });

  meshes.forEach((meshRecord) => {
    const box = new THREE.Box3();
    meshRecord.triangles.forEach((triangle) => box.expandByPoint(triangle.a).expandByPoint(triangle.b).expandByPoint(triangle.c));
    meshRecord.aabb = box.isEmpty()
      ? null
      : { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] };
  });

  return { triangles, degenerate, meshCount, meshes };
}

/*
 * Recursively split triangles until each one covers a small patch of UV space, so a
 * per-facet texture sample is actually meaningful (a whole box face is two huge
 * triangles; 8×8-ish sub-triangles give the sampler something to resolve).
 * Shape and winding are preserved exactly — midpoints stay on the original facets.
 */
export function subdivideForTexture(geometry, { maxUvArea = 1 / 128, maxDepth = 4 } = {}) {
  const source = geometry.index ? geometry.toNonIndexed() : geometry;
  const position = source.getAttribute('position');
  const uv = source.getAttribute('uv');
  if (!position || !uv || uv.count !== position.count) return source;

  const positions = [];
  const uvs = [];

  const emit = (a, b, c, depth) => {
    const uvArea = Math.abs((b.u - a.u) * (c.v - a.v) - (c.u - a.u) * (b.v - a.v)) / 2;
    if (depth >= maxDepth || uvArea <= maxUvArea) {
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      uvs.push(a.u, a.v, b.u, b.v, c.u, c.v);
      return;
    }
    const mid = (p, q) => ({
      x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, z: (p.z + q.z) / 2,
      u: (p.u + q.u) / 2, v: (p.v + q.v) / 2
    });
    const ab = mid(a, b);
    const bc = mid(b, c);
    const ca = mid(c, a);
    emit(a, ab, ca, depth + 1);
    emit(ab, b, bc, depth + 1);
    emit(ca, bc, c, depth + 1);
    emit(ab, bc, ca, depth + 1);
  };

  for (let i = 0; i < position.count; i += 3) {
    emit(
      { x: position.getX(i), y: position.getY(i), z: position.getZ(i), u: uv.getX(i), v: uv.getY(i) },
      { x: position.getX(i + 1), y: position.getY(i + 1), z: position.getZ(i + 1), u: uv.getX(i + 1), v: uv.getY(i + 1) },
      { x: position.getX(i + 2), y: position.getY(i + 2), z: position.getZ(i + 2), u: uv.getX(i + 2), v: uv.getY(i + 2) },
      0
    );
  }

  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  result.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  if (source !== geometry) source.dispose();
  return result;
}

/*
 * ---------------------------------------------------------------------------
 * Form-intersection detection
 * ---------------------------
 * Every exported form is written as its own closed shell, so two forms that
 * interpenetrate produce intersecting/internal facets rather than a boolean union
 * (notoriously fragile for the coplanar, grid-aligned contact this studio's forms
 * produce). That trade-off is accepted deliberately: the download always proceeds,
 * and detection reports the overlapping or duplicated pairs as an informational
 * note so the contents of the file stay transparent. Exact contact — stacked
 * forms, butt joints — is not overlap and reports nothing.
 *
 * Two complementary tests per form pair:
 *   1. surface crossing — an edge of one solid passes strictly through the interior
 *      of the other's facet (catches every transversal intersection);
 *   2. enclosure — a vertex, facet centroid or body centre of one solid lies
 *      strictly inside the other (catches face-aligned overlaps whose crossings all
 *      land degenerately on shared edges, plus fully embedded forms).
 */

/* Distance tolerance in scene units: closer than this to a surface counts as contact. */
const INTERSECTION_EPSILON = 1e-6;
/* Barycentric safety margins for "strictly inside" tests. */
const BARYCENTRIC_MARGIN = 1e-7;
const BARYCENTRIC_SUSPECT = 1e-5;
/* Rays for the parity inside test use irrational direction ratios so grid-aligned
 * geometry can never send one exactly through a shared edge or vertex. */
const PARITY_RAYS = [
  [1, 0.6180339887498949, 0.4142135623730951],
  [0.7548776662466927, 1, 0.5612378126208283],
  [0.3110748549528304, 0.5221542526308015, 1],
  [1, 0.2718281828459045, 0.1414213562373095]
];

function triangleBounds(triangle) {
  if (!triangle._min) {
    triangle._min = [
      Math.min(triangle.a.x, triangle.b.x, triangle.c.x),
      Math.min(triangle.a.y, triangle.b.y, triangle.c.y),
      Math.min(triangle.a.z, triangle.b.z, triangle.c.z)
    ];
    triangle._max = [
      Math.max(triangle.a.x, triangle.b.x, triangle.c.x),
      Math.max(triangle.a.y, triangle.b.y, triangle.c.y),
      Math.max(triangle.a.z, triangle.b.z, triangle.c.z)
    ];
  }
  return triangle;
}

function triangleBoxesOverlap(first, second) {
  triangleBounds(first);
  triangleBounds(second);
  const eps = INTERSECTION_EPSILON;
  for (let axis = 0; axis < 3; axis += 1) {
    if (first._min[axis] - eps > second._max[axis] || second._min[axis] - eps > first._max[axis]) return false;
  }
  return true;
}

function boxesOverlap(first, second) {
  if (!first?.aabb || !second?.aabb) return false;
  const eps = INTERSECTION_EPSILON;
  for (let axis = 0; axis < 3; axis += 1) {
    if (first.aabb.min[axis] - eps > second.aabb.max[axis] || second.aabb.min[axis] - eps > first.aabb.max[axis]) {
      return false;
    }
  }
  return true;
}

/* Signed distance of point p from the triangle's plane (its stored normal is unit length). */
function planeDistance(triangle, px, py, pz) {
  return (px - triangle.a.x) * triangle.normal.x
    + (py - triangle.a.y) * triangle.normal.y
    + (pz - triangle.a.z) * triangle.normal.z;
}

/* Barycentric (u, v) of point x against triangle edge vectors; assumes x is on its plane. */
function barycentric(triangle, px, py, pz) {
  const e1x = triangle.b.x - triangle.a.x, e1y = triangle.b.y - triangle.a.y, e1z = triangle.b.z - triangle.a.z;
  const e2x = triangle.c.x - triangle.a.x, e2y = triangle.c.y - triangle.a.y, e2z = triangle.c.z - triangle.a.z;
  const wx = px - triangle.a.x, wy = py - triangle.a.y, wz = pz - triangle.a.z;
  const d00 = e1x * e1x + e1y * e1y + e1z * e1z;
  const d01 = e1x * e2x + e1y * e2y + e1z * e2z;
  const d11 = e2x * e2x + e2y * e2y + e2z * e2z;
  const d20 = wx * e1x + wy * e1y + wz * e1z;
  const d21 = wx * e2x + wy * e2y + wz * e2z;
  const denominator = d00 * d11 - d01 * d01;
  if (Math.abs(denominator) < 1e-30) return null;
  return {
    u: (d11 * d20 - d01 * d21) / denominator,
    v: (d00 * d21 - d01 * d20) / denominator
  };
}

/*
 * True when segment p→q passes strictly through the triangle's interior — endpoints
 * on the plane, coplanar contact and edge-grazing crossings deliberately do not
 * count, so forms that merely touch are never reported as intersecting.
 */
function segmentCrossesTriangleStrictly(triangle, px, py, pz, qx, qy, qz) {
  const eps = INTERSECTION_EPSILON;
  const d1 = planeDistance(triangle, px, py, pz);
  const d2 = planeDistance(triangle, qx, qy, qz);
  if (d1 > eps && d2 > eps) return false;
  if (d1 < -eps && d2 < -eps) return false;
  if (Math.abs(d1) <= eps && Math.abs(d2) <= eps) return false; // coplanar contact
  const denominator = d1 - d2;
  if (Math.abs(denominator) < 1e-30) return false;
  const t = d1 / denominator;
  if (t <= 1e-9 || t >= 1 - 1e-9) return false; // touches at an endpoint, not a crossing
  const x = px + t * (qx - px);
  const y = py + t * (qy - py);
  const z = pz + t * (qz - pz);
  const bary = barycentric(triangle, x, y, z);
  if (!bary) return false;
  return bary.u > BARYCENTRIC_MARGIN && bary.v > BARYCENTRIC_MARGIN
    && bary.u + bary.v < 1 - BARYCENTRIC_MARGIN;
}

function surfacesCross(first, second) {
  // Small meshes brute-force; larger ones sweep one mesh against a uniform grid
  // bucketing of the other so the dialog-path estimate stays interactive.
  if (first.triangles.length * second.triangles.length <= 4096) {
    for (const triangle of first.triangles) {
      for (const other of second.triangles) {
        if (!triangleBoxesOverlap(triangle, other)) continue;
        if (edgesCrossPair(triangle, other)) return true;
      }
    }
    return false;
  }

  const grid = buildTriangleGrid(second);
  let stamp = 0;
  for (const triangle of first.triangles) {
    stamp += 1;
    for (const other of gridCandidates(grid, triangle, stamp)) {
      if (edgesCrossPair(triangle, other)) return true;
    }
  }
  return false;
}

/* All six strict edge/interior crossings between two triangles, both directions. */
function edgesCrossPair(triangle, other) {
  return segmentCrossesTriangleStrictly(other, triangle.a.x, triangle.a.y, triangle.a.z, triangle.b.x, triangle.b.y, triangle.b.z)
    || segmentCrossesTriangleStrictly(other, triangle.b.x, triangle.b.y, triangle.b.z, triangle.c.x, triangle.c.y, triangle.c.z)
    || segmentCrossesTriangleStrictly(other, triangle.c.x, triangle.c.y, triangle.c.z, triangle.a.x, triangle.a.y, triangle.a.z)
    || segmentCrossesTriangleStrictly(triangle, other.a.x, other.a.y, other.a.z, other.b.x, other.b.y, other.b.z)
    || segmentCrossesTriangleStrictly(triangle, other.b.x, other.b.y, other.b.z, other.c.x, other.c.y, other.c.z)
    || segmentCrossesTriangleStrictly(triangle, other.c.x, other.c.y, other.c.z, other.a.x, other.a.y, other.a.z);
}

/*
 * Uniform grid over a mesh's AABB. Each triangle lands in every cell its bounds
 * overlap; queries return each stored triangle at most once per stamp.
 */
function buildTriangleGrid(mesh) {
  const resolution = Math.max(4, Math.min(24, Math.ceil(Math.cbrt(mesh.triangles.length))));
  const origin = mesh.aabb.min;
  const cell = [0, 1, 2].map((axis) => Math.max((mesh.aabb.max[axis] - mesh.aabb.min[axis]) / resolution, 1e-9));
  const buckets = new Map();
  const cellKey = (ix, iy, iz) => (ix * resolution + iy) * resolution + iz;
  const clampCell = (value) => Math.max(0, Math.min(resolution - 1, value));

  mesh.triangles.forEach((triangle) => {
    triangleBounds(triangle);
    // Stamps from any previous grid build must never suppress this grid's candidates.
    triangle._stamp = -1;
    const low = [0, 1, 2].map((axis) => clampCell(Math.floor((triangle._min[axis] - origin[axis]) / cell[axis])));
    const high = [0, 1, 2].map((axis) => clampCell(Math.floor((triangle._max[axis] - origin[axis]) / cell[axis])));
    for (let ix = low[0]; ix <= high[0]; ix += 1) {
      for (let iy = low[1]; iy <= high[1]; iy += 1) {
        for (let iz = low[2]; iz <= high[2]; iz += 1) {
          const key = cellKey(ix, iy, iz);
          const bucket = buckets.get(key);
          if (bucket) bucket.push(triangle);
          else buckets.set(key, [triangle]);
        }
      }
    }
  });

  return { buckets, origin, cell, resolution, clampCell, cellKey };
}

function gridCandidates(grid, triangle, stamp) {
  triangleBounds(triangle);
  const candidates = [];
  const low = [0, 1, 2].map((axis) => grid.clampCell(Math.floor((triangle._min[axis] - grid.origin[axis]) / grid.cell[axis])));
  const high = [0, 1, 2].map((axis) => grid.clampCell(Math.floor((triangle._max[axis] - grid.origin[axis]) / grid.cell[axis])));
  for (let ix = low[0]; ix <= high[0]; ix += 1) {
    for (let iy = low[1]; iy <= high[1]; iy += 1) {
      for (let iz = low[2]; iz <= high[2]; iz += 1) {
        const bucket = grid.buckets.get(grid.cellKey(ix, iy, iz));
        if (!bucket) continue;
        for (const other of bucket) {
          if (other._stamp === stamp) continue;
          other._stamp = stamp;
          if (triangleBoxesOverlap(triangle, other)) candidates.push(other);
        }
      }
    }
  }
  return candidates;
}

/* 'inside' | 'outside' | 'surface' for one sample point against one closed mesh. */
function classifyPointAgainstMesh(px, py, pz, mesh) {
  const eps = INTERSECTION_EPSILON;
  for (const triangle of mesh.triangles) {
    triangleBounds(triangle);
    if (
      px < triangle._min[0] - eps || px > triangle._max[0] + eps
      || py < triangle._min[1] - eps || py > triangle._max[1] + eps
      || pz < triangle._min[2] - eps || pz > triangle._max[2] + eps
    ) continue;
    if (Math.abs(planeDistance(triangle, px, py, pz)) <= eps) {
      const bary = barycentric(triangle, px, py, pz);
      if (bary && bary.u >= -BARYCENTRIC_SUSPECT && bary.v >= -BARYCENTRIC_SUSPECT
        && bary.u + bary.v <= 1 + BARYCENTRIC_SUSPECT) {
        return 'surface'; // resting exactly on the other form — contact, not overlap
      }
    }
  }

  const reach = mesh.aabb
    ? Math.hypot(
      mesh.aabb.max[0] - mesh.aabb.min[0],
      mesh.aabb.max[1] - mesh.aabb.min[1],
      mesh.aabb.max[2] - mesh.aabb.min[2]
    ) + 1
    : 10;

  for (const [dx, dy, dz] of PARITY_RAYS) {
    const qx = px + dx * reach;
    const qy = py + dy * reach;
    const qz = pz + dz * reach;
    let crossings = 0;
    let suspect = false;
    for (const triangle of mesh.triangles) {
      if (!segmentCrossesTriangleStrictly(triangle, px, py, pz, qx, qy, qz)) continue;
      // Recompute the hit point to grade how close it landed to the facet boundary.
      const d1 = planeDistance(triangle, px, py, pz);
      const d2 = planeDistance(triangle, qx, qy, qz);
      const t = d1 / (d1 - d2);
      const bary = barycentric(triangle, px + t * (qx - px), py + t * (qy - py), pz + t * (qz - pz));
      if (!bary) { suspect = true; break; }
      const edgeSlack = Math.min(bary.u, bary.v, 1 - bary.u - bary.v);
      if (edgeSlack < BARYCENTRIC_SUSPECT) { suspect = true; break; }
      crossings += 1;
    }
    if (suspect) continue; // ambiguous ray: try the next direction
    return crossings % 2 === 1 ? 'inside' : 'outside';
  }
  return 'outside'; // every ray was ambiguous — never report an overlap on a coin flip
}

function meshEmbedsInto(first, second) {
  if (!second.aabb || !first.aabb) return false;
  const insideBox = (x, y, z) => x > second.aabb.min[0] && x < second.aabb.max[0]
    && y > second.aabb.min[1] && y < second.aabb.max[1]
    && z > second.aabb.min[2] && z < second.aabb.max[2];

  const centre = [
    (first.aabb.min[0] + first.aabb.max[0]) / 2,
    (first.aabb.min[1] + first.aabb.max[1]) / 2,
    (first.aabb.min[2] + first.aabb.max[2]) / 2
  ];
  const candidates = [centre];

  for (const triangle of first.triangles) {
    if (insideBox(triangle.a.x, triangle.a.y, triangle.a.z)) candidates.push([triangle.a.x, triangle.a.y, triangle.a.z]);
    if (insideBox(triangle.b.x, triangle.b.y, triangle.b.z)) candidates.push([triangle.b.x, triangle.b.y, triangle.b.z]);
    if (insideBox(triangle.c.x, triangle.c.y, triangle.c.z)) candidates.push([triangle.c.x, triangle.c.y, triangle.c.z]);
    candidates.push([
      (triangle.a.x + triangle.b.x + triangle.c.x) / 3,
      (triangle.a.y + triangle.b.y + triangle.c.y) / 3,
      (triangle.a.z + triangle.b.z + triangle.c.z) / 3
    ]);
  }

  for (const [x, y, z] of candidates) {
    if (!insideBox(x, y, z)) continue;
    if (classifyPointAgainstMesh(x, y, z, second) === 'inside') return true;
  }
  return false;
}

/*
 * All pairs of forms whose solids interpenetrate, as { a, b } name pairs. Exact
 * contact (stacked forms, butt joints) and disjoint forms return an empty list.
 */
export function detectFormIntersections(collected) {
  const meshes = (collected?.meshes || []).filter((mesh) => mesh.aabb && mesh.triangles.length);
  const pairs = [];
  for (let i = 0; i < meshes.length; i += 1) {
    for (let j = i + 1; j < meshes.length; j += 1) {
      if (!boxesOverlap(meshes[i], meshes[j])) continue;
      if (surfacesCross(meshes[i], meshes[j])
        || meshEmbedsInto(meshes[i], meshes[j])
        || meshEmbedsInto(meshes[j], meshes[i])) {
        pairs.push({ a: meshes[i].name, b: meshes[j].name });
      }
    }
  }
  return pairs;
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

function writeHeader(bytes, mode) {
  // Must never start with "solid" or readers treat the binary file as ASCII.
  // Colour mode is Magics-convention: the COLOR= global colour plus per-facet
  // attributes. Solid mode writes no colour information anywhere in the file.
  const text = mode === 'color'
    ? 'Orbit 3D studio export - colour STL (Magics) COLOR='
    : 'Orbit 3D studio export - plain solid STL (no colour data)';
  const encoded = new TextEncoder().encode(text);
  const limit = Math.min(encoded.length, mode === 'color' ? 74 : 80);
  for (let i = 0; i < limit; i += 1) bytes[i] = encoded[i];
  if (mode === 'color') {
    // Materialise Magics global colour: COLOR= followed by R,G,B,A bytes.
    const rgb = hexToRgb('#808080');
    bytes[limit] = rgb.r;
    bytes[limit + 1] = rgb.g;
    bytes[limit + 2] = rgb.b;
    bytes[limit + 3] = 255;
  }
}

/*
 * Serialise world-space triangles into a binary STL.
 * `mode` = 'color' writes per-facet Magics colour attributes; 'solid' writes a
 * plain, attribute-free file (every facet attribute is exactly 0).
 */
export function buildBinarySTL(triangles, { mode = 'color', solidColor = SOLID_EXPORT_COLOR } = {}) {
  const flavour = normaliseExportMode(mode);
  const buffer = new ArrayBuffer(84 + triangles.length * 50);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  writeHeader(bytes, flavour);
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
    // Solid mode stays a plain STL (attribute 0) so every slicer reads it identically;
    // its dark grey look lives only in the in-app preview, never in the file.
    view.setUint16(cursor, flavour === 'color' ? packFacetColor(triangle.color) : 0, true);
    offset += 50;
  });

  return { buffer, triangleCount: triangles.length, uniform };
}

/*
 * Orbit geometry kernel — pure, dependency-free triangle-mesh math.
 *
 * Everything in Orbit (primitives, CSG, modifiers, importers, exporters,
 * physics) speaks one format:
 *
 *   Mesh = { vertices: number[] (flat x,y,z), indices: number[] (flat tri) }
 *
 * No Three.js, no DOM. This module is the single source of geometric truth and
 * is exercised directly by the Node eval suites.
 */

export const EPS = 1e-9;

/* ------------------------------------------------------------------ mat4 */

export function identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

/** Column-major TRS composition: M = T · Rz · Ry · Rx · S (radians). */
export function compose(position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1]) {
  const [rx, ry, rz] = rotation;
  const [sx, sy, sz] = scale;
  const cx = Math.cos(rx); const sxr = Math.sin(rx);
  const cy = Math.cos(ry); const syr = Math.sin(ry);
  const cz = Math.cos(rz); const szr = Math.sin(rz);

  const m00 = cy * cz;
  const m01 = -cy * szr;
  const m02 = syr;
  const m10 = sxr * syr * cz + cx * szr;
  const m11 = -sxr * syr * szr + cx * cz;
  const m12 = -sxr * cy;
  const m20 = -cx * syr * cz + sxr * szr;
  const m21 = cx * syr * szr + sxr * cz;
  const m22 = cx * cy;

  return [
    m00 * sx, m10 * sx, m20 * sx, 0,
    m01 * sy, m11 * sy, m21 * sy, 0,
    m02 * sz, m12 * sz, m22 * sz, 0,
    position[0], position[1], position[2], 1
  ];
}

export function applyMatrix(m, [x, y, z]) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14]
  ];
}

/** Determinant of the upper-left 3×3 block — negative means a mirrored basis. */
export function determinant3(m) {
  return (
    m[0] * (m[5] * m[10] - m[9] * m[6]) -
    m[4] * (m[1] * m[10] - m[9] * m[2]) +
    m[8] * (m[1] * m[6] - m[5] * m[2])
  );
}

export function invert(m) {
  const inv = new Array(16);
  inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
  inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
  inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
  inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
  inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
  inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
  inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
  inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
  inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
  inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
  inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
  inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
  inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
  inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
  inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
  inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];

  let det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
  if (Math.abs(det) < 1e-14) return null;
  det = 1 / det;
  return inv.map((value) => value * det);
}

/* ------------------------------------------------------------------ vec3 */

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scaleVec = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
export const length = (a) => Math.sqrt(dot(a, a));
export function normalize(a) {
  const len = length(a);
  return len < EPS ? [0, 0, 0] : [a[0] / len, a[1] / len, a[2] / len];
}

/* ------------------------------------------------------------------ mesh */

export function mesh(vertices = [], indices = []) {
  return { vertices: Array.from(vertices), indices: Array.from(indices) };
}

export function vertexCount(m) {
  return m.vertices.length / 3;
}

export function triangleCount(m) {
  return m.indices.length / 3;
}

export function getVertex(m, i) {
  return [m.vertices[i * 3], m.vertices[i * 3 + 1], m.vertices[i * 3 + 2]];
}

export function* triangles(m) {
  for (let i = 0; i < m.indices.length; i += 3) {
    yield [getVertex(m, m.indices[i]), getVertex(m, m.indices[i + 1]), getVertex(m, m.indices[i + 2])];
  }
}

export function transformMesh(m, matrix) {
  const vertices = new Array(m.vertices.length);
  for (let i = 0; i < m.vertices.length; i += 3) {
    const [x, y, z] = applyMatrix(matrix, [m.vertices[i], m.vertices[i + 1], m.vertices[i + 2]]);
    vertices[i] = x; vertices[i + 1] = y; vertices[i + 2] = z;
  }
  // A mirrored basis flips triangle winding; rewind so normals stay outward.
  const indices = determinant3(matrix) < 0
    ? m.indices.reduce((acc, _, i, arr) => (i % 3 === 0 ? acc.concat([arr[i], arr[i + 2], arr[i + 1]]) : acc), [])
    : Array.from(m.indices);
  return { vertices, indices };
}

export function mergeMeshes(meshes) {
  const out = mesh();
  for (const part of meshes) {
    const offset = vertexCount(out);
    out.vertices.push(...part.vertices);
    out.indices.push(...part.indices.map((index) => index + offset));
  }
  return out;
}

export function bounds(m) {
  if (!m.vertices.length) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0] };
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.vertices.length; i += 3) {
    for (let a = 0; a < 3; a += 1) {
      const v = m.vertices[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return {
    min,
    max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
  };
}

/**
 * Signed volume by the divergence theorem over the closed surface:
 *   V = 1/6 · Σ  v0 · (v1 × v2)
 * Positive for outward-facing (counter-clockwise) winding.
 */
export function volume(m) {
  let total = 0;
  for (const [a, b, c] of triangles(m)) total += dot(a, cross(b, c));
  return total / 6;
}

/** Centroid of the enclosed solid (not the vertex average). */
export function centroid(m) {
  let vol = 0;
  const acc = [0, 0, 0];
  for (const [a, b, c] of triangles(m)) {
    const v = dot(a, cross(b, c)) / 6;
    vol += v;
    for (let i = 0; i < 3; i += 1) acc[i] += ((a[i] + b[i] + c[i]) / 4) * v;
  }
  if (Math.abs(vol) < EPS) return bounds(m).center;
  return acc.map((value) => value / vol);
}

export function surfaceArea(m) {
  let area = 0;
  for (const [a, b, c] of triangles(m)) area += length(cross(sub(b, a), sub(c, a))) / 2;
  return area;
}

/** Drop zero-area facets and vertices no triangle references. */
export function cleanMesh(input, epsilon = 1e-10) {
  const kept = [];
  for (let i = 0; i < input.indices.length; i += 3) {
    const a = getVertex(input, input.indices[i]);
    const b = getVertex(input, input.indices[i + 1]);
    const c = getVertex(input, input.indices[i + 2]);
    if (length(cross(sub(b, a), sub(c, a))) / 2 > epsilon) {
      kept.push(input.indices[i], input.indices[i + 1], input.indices[i + 2]);
    }
  }
  const remap = new Map();
  const out = mesh();
  for (const index of kept) {
    if (!remap.has(index)) {
      remap.set(index, vertexCount(out));
      out.vertices.push(...getVertex(input, index));
    }
    out.indices.push(remap.get(index));
  }
  return out;
}

/** Weld coincident vertices within a quantisation grid. */
export function weld(input, tolerance = 1e-6) {
  const key = (v) => v.map((n) => Math.round(n / tolerance)).join(',');
  const lookup = new Map();
  const out = mesh();
  const remap = [];
  for (let i = 0; i < vertexCount(input); i += 1) {
    const v = getVertex(input, i);
    const k = key(v);
    if (!lookup.has(k)) {
      lookup.set(k, vertexCount(out));
      out.vertices.push(...v);
    }
    remap.push(lookup.get(k));
  }
  out.indices = input.indices.map((index) => remap[index]);
  return cleanMesh(out);
}

/**
 * Make winding globally consistent, then make it outward.
 *
 * Adjacent triangles agree when they traverse their shared edge in opposite
 * directions. A breadth-first walk over the dual graph propagates one
 * reference orientation across each connected shell; afterwards a negative
 * signed volume means the whole shell points inward, so it is flipped.
 */
export function orient(input) {
  const welded = weld(input, 1e-7);
  const faceCount = triangleCount(welded);
  if (!faceCount) return welded;

  const edgeMap = new Map();
  for (let f = 0; f < faceCount; f += 1) {
    const tri = [welded.indices[f * 3], welded.indices[f * 3 + 1], welded.indices[f * 3 + 2]];
    for (let e = 0; e < 3; e += 1) {
      const a = tri[e];
      const b = tri[(e + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (!edgeMap.has(key)) edgeMap.set(key, []);
      edgeMap.get(key).push({ face: f, a, b });
    }
  }

  const flipped = new Array(faceCount).fill(false);
  const visited = new Array(faceCount).fill(false);
  const shells = [];

  for (let seed = 0; seed < faceCount; seed += 1) {
    if (visited[seed]) continue;
    const shell = [seed];
    visited[seed] = true;
    const queue = [seed];
    while (queue.length) {
      const f = queue.shift();
      const tri = [welded.indices[f * 3], welded.indices[f * 3 + 1], welded.indices[f * 3 + 2]];
      const oriented = flipped[f] ? [tri[0], tri[2], tri[1]] : tri;
      for (let e = 0; e < 3; e += 1) {
        const a = oriented[e];
        const b = oriented[(e + 1) % 3];
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        for (const entry of edgeMap.get(key) || []) {
          if (entry.face === f || visited[entry.face]) continue;
          const other = [welded.indices[entry.face * 3], welded.indices[entry.face * 3 + 1], welded.indices[entry.face * 3 + 2]];
          // Neighbour agrees when it walks the shared edge b → a.
          let agrees = false;
          for (let k = 0; k < 3; k += 1) {
            if (other[k] === b && other[(k + 1) % 3] === a) agrees = true;
          }
          flipped[entry.face] = !agrees;
          visited[entry.face] = true;
          shell.push(entry.face);
          queue.push(entry.face);
        }
      }
    }
    shells.push(shell);
  }

  const out = mesh(welded.vertices, []);
  const emit = (f, flip) => {
    const tri = [welded.indices[f * 3], welded.indices[f * 3 + 1], welded.indices[f * 3 + 2]];
    if (flip) out.indices.push(tri[0], tri[2], tri[1]);
    else out.indices.push(tri[0], tri[1], tri[2]);
  };

  for (const shell of shells) {
    // Signed volume of this shell alone decides whether it faces outward.
    let signed = 0;
    for (const f of shell) {
      const tri = [welded.indices[f * 3], welded.indices[f * 3 + 1], welded.indices[f * 3 + 2]];
      const oriented = flipped[f] ? [tri[0], tri[2], tri[1]] : tri;
      const a = getVertex(welded, oriented[0]);
      const b = getVertex(welded, oriented[1]);
      const c = getVertex(welded, oriented[2]);
      signed += dot(a, cross(b, c)) / 6;
    }
    const invertShell = signed < 0;
    for (const f of shell) emit(f, flipped[f] !== invertShell);
  }
  return out;
}

/**
 * Split a mesh into its connected shells.
 *
 * A BSP tree assumes its polygon soup bounds ONE solid region. Feeding it a
 * mesh of several disjoint shells makes the tree classify points against
 * whichever shell happens to sit at the root, so booleans silently corrupt.
 * Splitting first, then folding the operation over each shell, is what keeps
 * multi-part operands (arrays, mirrors, imported assemblies) exact.
 */
export function splitShells(input) {
  const welded = weld(input, 1e-7);
  const V = vertexCount(welded);
  if (!V) return [];
  const parent = Array.from({ length: V }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const unite = (x, y) => { const a = find(x); const b = find(y); if (a !== b) parent[a] = b; };
  for (let i = 0; i < welded.indices.length; i += 3) {
    unite(welded.indices[i], welded.indices[i + 1]);
    unite(welded.indices[i + 1], welded.indices[i + 2]);
  }
  const groups = new Map();
  for (let i = 0; i < welded.indices.length; i += 3) {
    const root = find(welded.indices[i]);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }
  if (groups.size <= 1) return [welded];
  return [...groups.values()].map((faces) => {
    const remap = new Map();
    const out = mesh();
    for (const face of faces) {
      for (let k = 0; k < 3; k += 1) {
        const index = welded.indices[face + k];
        if (!remap.has(index)) {
          remap.set(index, vertexCount(out));
          out.vertices.push(...getVertex(welded, index));
        }
        out.indices.push(remap.get(index));
      }
    }
    return out;
  });
}

/**
 * Repair T-junctions.
 *
 * BSP splitting leaves vertices sitting in the *interior* of a neighbouring
 * triangle's edge. Those edges then belong to one triangle on one side and two
 * on the other, so the surface reads as "open" even though it is geometrically
 * closed. This pass re-splits any edge that contains a foreign vertex, which is
 * what makes exact CSG output watertight.
 */
export function repairTJunctions(input, tolerance = 1e-7) {
  let current = weld(input, 1e-7);
  for (let pass = 0; pass < 6; pass += 1) {
    const points = [];
    for (let i = 0; i < vertexCount(current); i += 1) points.push(getVertex(current, i));

    // Spatial hash so the "which vertices touch this edge" query stays cheap.
    // The cell must scale with the model, not with `tolerance`: a fixed micro
    // cell makes a unit-length edge span 10^4 cells and silently degrades the
    // lookup to a full O(n) scan per edge (i.e. O(n²) overall).
    const extent = bounds(current).size;
    const cell = Math.max(1e-9, Math.max(extent[0], extent[1], extent[2], 1e-6) / 48);
    const buckets = new Map();
    const keyOf = (v) => `${Math.floor(v[0] / cell)},${Math.floor(v[1] / cell)},${Math.floor(v[2] / cell)}`;
    points.forEach((p, index) => {
      const k = keyOf(p);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(index);
    });
    const near = (a, b) => {
      const found = new Set();
      const lo = [0, 1, 2].map((i) => Math.floor(Math.min(a[i], b[i]) / cell) - 1);
      const hi = [0, 1, 2].map((i) => Math.floor(Math.max(a[i], b[i]) / cell) + 1);
      const addCell = (x, y, z) => {
        for (const index of buckets.get(`${x},${y},${z}`) || []) found.add(index);
      };
      // Short edges: sweep the (padded) bounding box of cells.
      if ((hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1) <= 4096) {
        for (let x = lo[0]; x <= hi[0]; x += 1) {
          for (let y = lo[1]; y <= hi[1]; y += 1) {
            for (let z = lo[2]; z <= hi[2]; z += 1) {
              addCell(x, y, z);
            }
          }
        }
        return [...found];
      }
      // Long edges: walk the line one cell at a time (Amanatides–Woo DDA).
      // The edge passes through O(length / cell) cells, so the work is linear
      // in edge length instead of falling back to a full vertex scan — which
      // is what made adversarial meshes degrade to quadratic time.
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const dz = b[2] - a[2];
      let x = Math.floor(a[0] / cell);
      let y = Math.floor(a[1] / cell);
      let z = Math.floor(a[2] / cell);
      const x1 = Math.floor(b[0] / cell);
      const y1 = Math.floor(b[1] / cell);
      const z1 = Math.floor(b[2] / cell);
      const tDeltaX = dx !== 0 ? cell / Math.abs(dx) : Infinity;
      const tDeltaY = dy !== 0 ? cell / Math.abs(dy) : Infinity;
      const tDeltaZ = dz !== 0 ? cell / Math.abs(dz) : Infinity;
      let tMaxX = dx > 0 ? (cell * (x + 1) - a[0]) / dx : dx < 0 ? (cell * x - a[0]) / dx : Infinity;
      let tMaxY = dy > 0 ? (cell * (y + 1) - a[1]) / dy : dy < 0 ? (cell * y - a[1]) / dy : Infinity;
      let tMaxZ = dz > 0 ? (cell * (z + 1) - a[2]) / dz : dz < 0 ? (cell * z - a[2]) / dz : Infinity;
      addCell(x, y, z);
      for (let step = 0; step < 100_000 && (x !== x1 || y !== y1 || z !== z1); step += 1) {
        if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
          x += dx > 0 ? 1 : -1;
          tMaxX += tDeltaX;
        } else if (tMaxY <= tMaxZ) {
          y += dy > 0 ? 1 : -1;
          tMaxY += tDeltaY;
        } else {
          z += dz > 0 ? 1 : -1;
          tMaxZ += tDeltaZ;
        }
        addCell(x, y, z);
      }
      return [...found];
    };

    const out = mesh(current.vertices, []);
    let split = 0;
    for (let t = 0; t < current.indices.length; t += 3) {
      const tri = [current.indices[t], current.indices[t + 1], current.indices[t + 2]];
      // Find the edge carrying the most interior vertices, split once, requeue.
      let best = null;
      for (let e = 0; e < 3; e += 1) {
        const ia = tri[e];
        const ib = tri[(e + 1) % 3];
        const a = points[ia];
        const b = points[ib];
        const ab = sub(b, a);
        const lenSq = dot(ab, ab);
        if (lenSq < tolerance) continue;
        for (const ic of near(a, b)) {
          if (ic === ia || ic === ib || ic === tri[(e + 2) % 3]) continue;
          const c = points[ic];
          const s = dot(sub(c, a), ab) / lenSq;
          if (s <= 1e-6 || s >= 1 - 1e-6) continue;
          const projection = [a[0] + ab[0] * s, a[1] + ab[1] * s, a[2] + ab[2] * s];
          if (length(sub(c, projection)) > 1e-6) continue;
          if (!best || Math.abs(s - 0.5) < Math.abs(best.s - 0.5)) best = { e, ic, s };
        }
      }
      if (best) {
        const opposite = tri[(best.e + 2) % 3];
        out.indices.push(tri[best.e], best.ic, opposite, best.ic, tri[(best.e + 1) % 3], opposite);
        split += 1;
      } else {
        out.indices.push(tri[0], tri[1], tri[2]);
      }
    }
    current = cleanMesh(out);
    if (!split) break;
  }
  return weld(current, 1e-7);
}

/**
 * Manifold report. A closed, orientable surface has every edge shared by
 * exactly two triangles with opposite directions, and satisfies Euler's
 * formula V - E + F = 2 - 2g for genus g.
 */
export function manifoldReport(input) {
  const welded = weld(input);
  const edges = new Map();
  for (let i = 0; i < welded.indices.length; i += 3) {
    const tri = [welded.indices[i], welded.indices[i + 1], welded.indices[i + 2]];
    for (let e = 0; e < 3; e += 1) {
      const a = tri[e];
      const b = tri[(e + 1) % 3];
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      const entry = edges.get(k) || { forward: 0, backward: 0 };
      if (a < b) entry.forward += 1; else entry.backward += 1;
      edges.set(k, entry);
    }
  }
  let boundary = 0;
  let nonManifold = 0;
  let inconsistent = 0;
  for (const { forward, backward } of edges.values()) {
    const total = forward + backward;
    if (total === 1) boundary += 1;
    else if (total > 2) nonManifold += 1;
    else if (forward !== 1 || backward !== 1) inconsistent += 1;
  }
  const V = vertexCount(welded);
  const E = edges.size;
  const F = triangleCount(welded);
  const euler = V - E + F;

  // Count connected shells via union-find over triangle vertices: a mesh of k
  // disjoint closed shells has Euler characteristic 2k, and genus
  // g = (2k - chi) / 2. Without this, two separate cubes read as genus -1.
  const parent = Array.from({ length: V }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const unite = (x, y) => { const a = find(x); const b = find(y); if (a !== b) parent[a] = b; };
  for (let i = 0; i < welded.indices.length; i += 3) {
    unite(welded.indices[i], welded.indices[i + 1]);
    unite(welded.indices[i + 1], welded.indices[i + 2]);
  }
  const roots = new Set();
  for (let i = 0; i < V; i += 1) roots.add(find(i));
  const shells = roots.size || 1;

  return {
    shells,
    closed: boundary === 0 && nonManifold === 0,
    watertight: boundary === 0,
    orientable: inconsistent === 0,
    boundary_edges: boundary,
    non_manifold_edges: nonManifold,
    inconsistent_edges: inconsistent,
    euler_characteristic: euler,
    genus: boundary === 0 && nonManifold === 0 ? (2 * shells - euler) / 2 : null,
    vertices: V,
    edges: E,
    faces: F
  };
}

/** Möller–Trumbore ray/triangle intersection. Returns t or null. */
export function rayTriangle(origin, direction, a, b, c) {
  const e1 = sub(b, a);
  const e2 = sub(c, a);
  const p = cross(direction, e2);
  const det = dot(e1, p);
  if (Math.abs(det) < 1e-12) return null;
  const invDet = 1 / det;
  const t = sub(origin, a);
  const u = dot(t, p) * invDet;
  if (u < 0 || u > 1) return null;
  const q = cross(t, e1);
  const v = dot(direction, q) * invDet;
  if (v < 0 || u + v > 1) return null;
  const distance = dot(e2, q) * invDet;
  return distance > 1e-9 ? distance : null;
}

export function raycastMesh(m, origin, direction) {
  let nearest = null;
  for (const [a, b, c] of triangles(m)) {
    const t = rayTriangle(origin, direction, a, b, c);
    if (t !== null && (nearest === null || t < nearest)) nearest = t;
  }
  return nearest;
}

/** Even-odd containment test by counting ray crossings. */
export function containsPoint(m, point) {
  let crossings = 0;
  const direction = [0.5773502691896258, 0.5773502691896258, 0.5773502691896258];
  for (const [a, b, c] of triangles(m)) {
    if (rayTriangle(point, direction, a, b, c) !== null) crossings += 1;
  }
  return crossings % 2 === 1;
}

export function boundsOverlap(a, b, epsilon = 1e-6) {
  for (let axis = 0; axis < 3; axis += 1) {
    if (!(a.min[axis] < b.max[axis] - epsilon && b.min[axis] < a.max[axis] - epsilon)) return false;
  }
  return true;
}

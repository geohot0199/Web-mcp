/*
 * Procedural modifiers — a non-destructive stack applied in order.
 *
 * Each modifier is a pure Mesh → Mesh function described by JSON, so an agent
 * can compose, reorder, retune or remove them without rebuilding the base
 * geometry. This is the "array / mirror / lattice / bevel" layer that primitive
 * composition alone cannot express.
 */

import {
  mesh, mergeMeshes, weld, cleanMesh, bounds, getVertex, vertexCount,
  triangleCount, sub, add, cross, dot, normalize, length, scaleVec,
  compose, transformMesh
} from './geom.js';
import { union } from './csg.js';

/** Global triangle ceiling for any single modifier result. */
export const MAX_TRIANGLES = 150000;

/* ------------------------------------------------------------- utilities */

function vertexNormals(source) {
  const normals = new Array(vertexCount(source)).fill(null).map(() => [0, 0, 0]);
  for (let i = 0; i < source.indices.length; i += 3) {
    const ia = source.indices[i]; const ib = source.indices[i + 1]; const ic = source.indices[i + 2];
    const a = getVertex(source, ia); const b = getVertex(source, ib); const c = getVertex(source, ic);
    const n = cross(sub(b, a), sub(c, a));
    for (const index of [ia, ib, ic]) {
      normals[index][0] += n[0];
      normals[index][1] += n[1];
      normals[index][2] += n[2];
    }
  }
  return normals.map(normalize);
}

function mapVertices(source, fn) {
  const out = mesh(source.vertices, source.indices);
  for (let i = 0; i < out.vertices.length; i += 3) {
    const [x, y, z] = fn([out.vertices[i], out.vertices[i + 1], out.vertices[i + 2]], i / 3, source);
    out.vertices[i] = x; out.vertices[i + 1] = y; out.vertices[i + 2] = z;
  }
  return out;
}

/* ------------------------------------------------------------- modifiers */

/** Linear / radial duplication. `merge: true` fuses copies with real CSG. */
export function array(source, options = {}) {
  // Bound the output before allocating: count is agent-supplied.
  const {
    count = 3, offset = [1, 0, 0], mode = 'linear',
    axis = [0, 1, 0], angle = Math.PI * 2, radius = 1, merge = false
  } = options;
  const requested = Number.isFinite(Number(count)) ? Math.floor(Number(count)) : 3;
  const budget = Math.max(1, Math.floor(MAX_TRIANGLES / Math.max(1, triangleCount(source))));
  const n = Math.max(1, Math.min(256, budget, requested));
  const copies = [];
  for (let i = 0; i < n; i += 1) {
    if (mode === 'radial') {
      const theta = (i / n) * angle;
      const rot = axis[1] ? [0, theta, 0] : axis[0] ? [theta, 0, 0] : [0, 0, theta];
      const pos = axis[1] ? [Math.cos(theta) * radius, 0, Math.sin(theta) * radius]
        : axis[0] ? [0, Math.cos(theta) * radius, Math.sin(theta) * radius]
          : [Math.cos(theta) * radius, Math.sin(theta) * radius, 0];
      copies.push(transformMesh(source, compose(pos, rot, [1, 1, 1])));
    } else {
      copies.push(transformMesh(source, compose([offset[0] * i, offset[1] * i, offset[2] * i])));
    }
  }
  if (!merge) return mergeMeshes(copies);
  return copies.reduce((acc, part) => union(acc, part));
}

/** Mirror across a world plane; `merge` welds the seam into one solid. */
export function mirror(source, options = {}) {
  const { axis = 'x', offset = 0, merge = true } = options;
  const index = { x: 0, y: 1, z: 2 }[axis] ?? 0;
  const scale = [1, 1, 1];
  scale[index] = -1;
  const shift = [0, 0, 0];
  shift[index] = offset * 2;
  const flipped = transformMesh(source, compose(shift, [0, 0, 0], scale));
  if (!merge) return mergeMeshes([source, flipped]);
  return union(source, flipped);
}

/** Twist around an axis: rotation angle scales linearly with position. */
export function twist(source, options = {}) {
  const { axis = 'y', angle = Math.PI / 2 } = options;
  const b = bounds(source);
  const index = { x: 0, y: 1, z: 2 }[axis] ?? 1;
  const span = b.size[index] || 1;
  return mapVertices(source, (v) => {
    const t = (v[index] - b.min[index]) / span - 0.5;
    const a = angle * t;
    const cosA = Math.cos(a); const sinA = Math.sin(a);
    const out = [...v];
    if (index === 1) { out[0] = v[0] * cosA - v[2] * sinA; out[2] = v[0] * sinA + v[2] * cosA; }
    else if (index === 0) { out[1] = v[1] * cosA - v[2] * sinA; out[2] = v[1] * sinA + v[2] * cosA; }
    else { out[0] = v[0] * cosA - v[1] * sinA; out[1] = v[0] * sinA + v[1] * cosA; }
    return out;
  });
}

/** Bend around an axis by wrapping one axis onto a circular arc. */
export function bend(source, options = {}) {
  const { axis = 'y', angle = Math.PI / 4 } = options;
  const b = bounds(source);
  const index = { x: 0, y: 1, z: 2 }[axis] ?? 1;
  const span = b.size[index] || 1;
  const radius = span / (Math.abs(angle) < 1e-6 ? 1e-6 : angle);
  return mapVertices(source, (v) => {
    const t = (v[index] - b.min[index]) / span - 0.5;
    const theta = angle * t;
    const out = [...v];
    const lateral = index === 1 ? 0 : 1;
    const r = radius - v[lateral];
    out[index] = b.center[index] + r * Math.sin(theta);
    out[lateral] = radius - r * Math.cos(theta);
    return out;
  });
}

/** Taper: scale the cross-section along an axis from `from` to `to`. */
export function taper(source, options = {}) {
  const { axis = 'y', from = 1, to = 0.5 } = options;
  const b = bounds(source);
  const index = { x: 0, y: 1, z: 2 }[axis] ?? 1;
  const span = b.size[index] || 1;
  return mapVertices(source, (v) => {
    const t = (v[index] - b.min[index]) / span;
    const s = from + (to - from) * t;
    const out = [...v];
    for (let a = 0; a < 3; a += 1) if (a !== index) out[a] = b.center[a] + (v[a] - b.center[a]) * s;
    return out;
  });
}

/** Push vertices along their normals — shell thickening / shrink. */
export function inflate(source, options = {}) {
  const { distance = 0.05 } = options;
  const normals = vertexNormals(source);
  return mapVertices(source, (v, i) => [
    v[0] + normals[i][0] * distance,
    v[1] + normals[i][1] * distance,
    v[2] + normals[i][2] * distance
  ]);
}

/** Hollow a solid: outer shell minus an inflated-inward copy. */
export function shell(source, options = {}) {
  const { thickness = 0.05 } = options;
  const inner = inflate(source, { distance: -Math.abs(thickness) });
  const result = subtractSafe(source, inner);
  return result;
}

function subtractSafe(a, b) {
  // Imported lazily to keep the modifier module free of a hard CSG cycle.
  // eslint-disable-next-line no-use-before-define
  return csgSubtract(a, b);
}

let csgSubtract = (a) => a;
export function __bindCsg(subtractFn) {
  csgSubtract = subtractFn;
}

/** Laplacian smoothing — averages each vertex toward its neighbours. */
export function smooth(source, options = {}) {
  const { iterations = 1, factor = 0.5 } = options;
  let current = weld(source);
  const steps = Math.max(1, Math.min(10, Number.isFinite(Number(iterations)) ? Math.floor(Number(iterations)) : 1));
  for (let step = 0; step < steps; step += 1) {
    const neighbours = new Map();
    for (let i = 0; i < current.indices.length; i += 3) {
      const tri = [current.indices[i], current.indices[i + 1], current.indices[i + 2]];
      for (let e = 0; e < 3; e += 1) {
        const a = tri[e]; const b = tri[(e + 1) % 3];
        if (!neighbours.has(a)) neighbours.set(a, new Set());
        if (!neighbours.has(b)) neighbours.set(b, new Set());
        neighbours.get(a).add(b);
        neighbours.get(b).add(a);
      }
    }
    current = mapVertices(current, (v, i) => {
      const set = neighbours.get(i);
      if (!set || !set.size) return v;
      const avg = [0, 0, 0];
      for (const j of set) {
        const n = getVertex(current, j);
        avg[0] += n[0]; avg[1] += n[1]; avg[2] += n[2];
      }
      const k = set.size;
      return [
        v[0] + factor * (avg[0] / k - v[0]),
        v[1] + factor * (avg[1] / k - v[1]),
        v[2] + factor * (avg[2] / k - v[2])
      ];
    });
  }
  return current;
}

/** Loop-style subdivision (midpoint split, 1 → 4 triangles). */
export function subdivide(source, options = {}) {
  const { iterations = 1 } = options;
  let current = weld(source);
  const requested = Number.isFinite(Number(iterations)) ? Math.floor(Number(iterations)) : 1;
  // Each iteration quadruples the face count, so cap by the budget too.
  const affordable = Math.floor(Math.log(MAX_TRIANGLES / Math.max(1, triangleCount(current))) / Math.log(4));
  const steps = Math.max(0, Math.min(4, affordable, requested));
  for (let step = 0; step < steps; step += 1) {
    const out = mesh(current.vertices, []);
    const cache = new Map();
    const midpoint = (a, b) => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (cache.has(key)) return cache.get(key);
      const va = getVertex(current, a); const vb = getVertex(current, b);
      const index = out.vertices.length / 3;
      out.vertices.push((va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2);
      cache.set(key, index);
      return index;
    };
    for (let i = 0; i < current.indices.length; i += 3) {
      const a = current.indices[i]; const b = current.indices[i + 1]; const c = current.indices[i + 2];
      const ab = midpoint(a, b); const bc = midpoint(b, c); const ca = midpoint(c, a);
      out.indices.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    current = out;
  }
  return current;
}

/** Quadric-free decimation: collapse the shortest edges until the budget is met. */
export function decimate(source, options = {}) {
  const { ratio = 0.5 } = options;
  const target = Math.max(4, Math.floor(triangleCount(source) * Math.min(1, Math.max(0.02, ratio))));
  let current = weld(source);
  let guard = 0;
  while (triangleCount(current) > target && guard < 2000) {
    guard += 1;
    let shortest = Infinity;
    let pair = null;
    for (let i = 0; i < current.indices.length; i += 3) {
      const tri = [current.indices[i], current.indices[i + 1], current.indices[i + 2]];
      for (let e = 0; e < 3; e += 1) {
        const a = tri[e]; const b = tri[(e + 1) % 3];
        const d = length(sub(getVertex(current, a), getVertex(current, b)));
        if (d < shortest) { shortest = d; pair = [a, b]; }
      }
    }
    if (!pair) break;
    const [a, b] = pair;
    const va = getVertex(current, a); const vb = getVertex(current, b);
    const merged = [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2];
    current.vertices[a * 3] = merged[0];
    current.vertices[a * 3 + 1] = merged[1];
    current.vertices[a * 3 + 2] = merged[2];
    current.indices = current.indices.map((index) => (index === b ? a : index));
    current = cleanMesh(current);
  }
  return weld(current);
}

/**
 * Free-form lattice deformation: a trilinear control cage over the bounding box.
 * `controls` is a 2×2×2 array of [dx,dy,dz] displacements.
 */
export function lattice(source, options = {}) {
  const { controls = null, strength = 1 } = options;
  if (!controls) return source;
  const b = bounds(source);
  const at = (i, j, k) => controls[i * 4 + j * 2 + k] || [0, 0, 0];
  return mapVertices(source, (v) => {
    const u = b.size[0] ? (v[0] - b.min[0]) / b.size[0] : 0;
    const w = b.size[1] ? (v[1] - b.min[1]) / b.size[1] : 0;
    const t = b.size[2] ? (v[2] - b.min[2]) / b.size[2] : 0;
    const d = [0, 0, 0];
    for (let i = 0; i < 2; i += 1) {
      for (let j = 0; j < 2; j += 1) {
        for (let k = 0; k < 2; k += 1) {
          const weight = (i ? u : 1 - u) * (j ? w : 1 - w) * (k ? t : 1 - t);
          const c = at(i, j, k);
          d[0] += c[0] * weight; d[1] += c[1] * weight; d[2] += c[2] * weight;
        }
      }
    }
    return [v[0] + d[0] * strength, v[1] + d[1] * strength, v[2] + d[2] * strength];
  });
}

/** Noise displacement along vertex normals — deterministic, seeded. */
export function displace(source, options = {}) {
  const { amplitude = 0.05, frequency = 4, seed = 1 } = options;
  const normals = vertexNormals(source);
  const hash = (x, y, z) => {
    const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed * 43.3) * 43758.5453;
    return n - Math.floor(n) - 0.5;
  };
  return mapVertices(source, (v, i) => {
    const d = hash(v[0] * frequency, v[1] * frequency, v[2] * frequency) * amplitude;
    return [v[0] + normals[i][0] * d, v[1] + normals[i][1] * d, v[2] + normals[i][2] * d];
  });
}

export const MODIFIERS = {
  array, mirror, twist, bend, taper, inflate, shell, smooth, subdivide, decimate, lattice, displace
};

export const MODIFIER_NAMES = Object.keys(MODIFIERS);

/**
 * Apply an ordered, non-destructive modifier stack.
 * Returns the mesh plus a per-step trace so an agent can see the cost of each.
 */
export function applyStack(source, stack = []) {
  let current = source;
  const trace = [];
  for (const entry of stack) {
    const name = entry?.type || entry?.name;
    const fn = MODIFIERS[name];
    if (!fn) throw new Error(`Unknown modifier: ${name}`);
    if (entry.enabled === false) {
      trace.push({ modifier: name, skipped: true, triangles: triangleCount(current) });
      continue;
    }
    const before = triangleCount(current);
    current = fn(current, entry.options || entry.params || {});
    trace.push({ modifier: name, triangles_before: before, triangles_after: triangleCount(current) });
  }
  return { mesh: current, trace };
}

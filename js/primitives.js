/*
 * Primitive and profile-driven mesh construction.
 *
 * Beyond the six classic primitives this module builds real freeform geometry:
 * extruded 2D profiles (with corner bevels), lathe/revolve surfaces, prisms,
 * capsules, tubes and text-free parametric sweeps. Every result is a closed,
 * outward-wound solid so CSG and volume integration stay well defined.
 */

import { mesh, mergeMeshes, weld, orient, cross, sub, dot, normalize, length } from './geom.js';

const TAU = Math.PI * 2;

/*
 * Resource ceilings. An agent has full authority here, so a mistyped or
 * hostile parameter must degrade into a coarse mesh rather than exhaust
 * memory. Every tessellation input is clamped through these helpers.
 */
export const LIMITS = {
  maxSegments: 256,
  maxRings: 256,
  maxSubdivisions: 5,
  maxProfilePoints: 4096,
  maxSweepSteps: 2048
};

const clampInt = (value, min, max, fallback) => {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const finiteNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export const PRIMITIVE_TYPES = [
  'cube', 'sphere', 'cylinder', 'cone', 'torus', 'plane',
  'capsule', 'prism', 'wedge', 'tube', 'pyramid', 'icosphere'
];

/** Reject profiles that cannot form a valid cap before any allocation. */
export function assertProfile(profile, who = 'profile') {
  if (!Array.isArray(profile)) throw new Error(`${who}: profile must be an array of [x, y] points`);
  if (profile.length < 3) throw new Error(`${who}: profile needs at least three points, got ${profile.length}`);
  if (profile.length > LIMITS.maxProfilePoints) throw new Error(`${who}: profile exceeds ${LIMITS.maxProfilePoints} points`);
  for (const point of profile) {
    if (!Array.isArray(point) || point.length < 2 || !Number.isFinite(Number(point[0])) || !Number.isFinite(Number(point[1]))) {
      throw new Error(`${who}: every profile point must be a finite [x, y] pair`);
    }
  }
  return true;
}

function quad(indices, a, b, c, d) {
  indices.push(a, b, c, a, c, d);
}

export function box(width = 1, height = 1, depth = 1) {
  const x = width / 2; const y = height / 2; const z = depth / 2;
  const vertices = [
    -x, -y, z, x, -y, z, x, y, z, -x, y, z,
    -x, -y, -z, -x, y, -z, x, y, -z, x, -y, -z
  ];
  const indices = [];
  quad(indices, 0, 1, 2, 3);
  quad(indices, 7, 4, 5, 6);
  quad(indices, 3, 2, 6, 5);
  quad(indices, 4, 7, 1, 0);
  quad(indices, 1, 7, 6, 2);
  quad(indices, 4, 0, 3, 5);
  return orient(mesh(vertices, indices));
}

export function sphere(radius = 0.5, segments = 24, rings = 16) {
  const seg = clampInt(segments, 3, LIMITS.maxSegments, 24);
  const rng = clampInt(rings, 2, LIMITS.maxRings, 16);
  const vertices = [];
  const indices = [];
  for (let r = 0; r <= rng; r += 1) {
    const phi = (r / rng) * Math.PI;
    for (let s = 0; s <= seg; s += 1) {
      const theta = (s / seg) * TAU;
      vertices.push(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.cos(phi),
        radius * Math.sin(phi) * Math.sin(theta)
      );
    }
  }
  const row = seg + 1;
  for (let r = 0; r < rng; r += 1) {
    for (let s = 0; s < seg; s += 1) {
      const a = r * row + s;
      quad(indices, a, a + row, a + row + 1, a + 1);
    }
  }
  return orient(mesh(vertices, indices));
}

/** Geodesic sphere by recursive icosahedron subdivision — uniform triangles. */
export function icosphere(radius = 0.5, subdivisions = 2) {
  const t = (1 + Math.sqrt(5)) / 2;
  let points = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]
  ].map(normalize);
  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]
  ];
  const depth = clampInt(subdivisions, 0, LIMITS.maxSubdivisions, 2);
  for (let i = 0; i < depth; i += 1) {
    const cache = new Map();
    const next = [];
    const midpoint = (a, b) => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (cache.has(key)) return cache.get(key);
      const m = normalize([
        (points[a][0] + points[b][0]) / 2,
        (points[a][1] + points[b][1]) / 2,
        (points[a][2] + points[b][2]) / 2
      ]);
      points.push(m);
      cache.set(key, points.length - 1);
      return points.length - 1;
    };
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b); const bc = midpoint(b, c); const ca = midpoint(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  return orient(mesh(points.flatMap((p) => [p[0] * radius, p[1] * radius, p[2] * radius]), faces.flat()));
}

export function cylinder(radiusTop = 0.5, radiusBottom = 0.5, height = 1, segments = 24) {
  const seg = clampInt(segments, 3, LIMITS.maxSegments, 24);
  const half = height / 2;
  const vertices = [];
  const indices = [];
  for (let s = 0; s < seg; s += 1) {
    const theta = (s / seg) * TAU;
    vertices.push(radiusTop * Math.cos(theta), half, radiusTop * Math.sin(theta));
  }
  for (let s = 0; s < seg; s += 1) {
    const theta = (s / seg) * TAU;
    vertices.push(radiusBottom * Math.cos(theta), -half, radiusBottom * Math.sin(theta));
  }
  const topCentre = vertices.length / 3;
  vertices.push(0, half, 0);
  const bottomCentre = vertices.length / 3;
  vertices.push(0, -half, 0);

  for (let s = 0; s < seg; s += 1) {
    const n = (s + 1) % seg;
    if (radiusTop > 1e-9 && radiusBottom > 1e-9) quad(indices, s, seg + s, seg + n, n);
    else if (radiusTop <= 1e-9) indices.push(seg + s, seg + n, s);
    else indices.push(s, seg + s, n);
    indices.push(topCentre, s, n);
    indices.push(bottomCentre, seg + n, seg + s);
  }
  return orient(mesh(vertices, indices));
}

export const cone = (radius = 0.5, height = 1, segments = 24) => cylinder(1e-10, radius, height, segments);

export function torus(radius = 0.5, tube = 0.2, radialSegments = 24, tubularSegments = 16) {
  const R = clampInt(radialSegments, 3, LIMITS.maxSegments, 24);
  const T = clampInt(tubularSegments, 3, LIMITS.maxRings, 16);
  const vertices = [];
  const indices = [];
  for (let i = 0; i < R; i += 1) {
    const u = (i / R) * TAU;
    for (let j = 0; j < T; j += 1) {
      const v = (j / T) * TAU;
      vertices.push(
        (radius + tube * Math.cos(v)) * Math.cos(u),
        tube * Math.sin(v),
        (radius + tube * Math.cos(v)) * Math.sin(u)
      );
    }
  }
  for (let i = 0; i < R; i += 1) {
    for (let j = 0; j < T; j += 1) {
      const a = i * T + j;
      const b = ((i + 1) % R) * T + j;
      const c = ((i + 1) % R) * T + ((j + 1) % T);
      const d = i * T + ((j + 1) % T);
      quad(indices, a, b, c, d);
    }
  }
  return orient(mesh(vertices, indices));
}

/** A "plane" is a thin slab: Orbit never emits zero-thickness geometry. */
export function plane(width = 1, depth = 1, thickness = 0.02) {
  return box(width, Math.max(thickness, 1e-4), depth);
}

export function capsule(radius = 0.3, height = 1, segments = 20, rings = 8) {
  const seg = clampInt(segments, 3, LIMITS.maxSegments, 24);
  const rng = clampInt(rings, 2, LIMITS.maxRings, 16);
  const half = Math.max(0, height / 2);
  const vertices = [];
  const indices = [];
  const rows = [];
  for (let r = 0; r <= rng; r += 1) {
    const phi = (r / rng) * (Math.PI / 2);
    rows.push({ y: half + radius * Math.cos(phi), r: radius * Math.sin(phi) });
  }
  for (let r = rng; r >= 0; r -= 1) {
    const phi = (r / rng) * (Math.PI / 2);
    rows.push({ y: -half - radius * Math.cos(phi), r: radius * Math.sin(phi) });
  }
  for (const { y, r } of rows) {
    for (let s = 0; s <= seg; s += 1) {
      const theta = (s / seg) * TAU;
      vertices.push(r * Math.cos(theta), y, r * Math.sin(theta));
    }
  }
  const row = seg + 1;
  for (let r = 0; r < rows.length - 1; r += 1) {
    for (let s = 0; s < seg; s += 1) {
      const a = r * row + s;
      quad(indices, a, a + row, a + row + 1, a + 1);
    }
  }
  return orient(mesh(vertices, indices));
}

/* --------------------------------------------------------- profile solids */

function polygonArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

/** Ear-clipping triangulation for a simple polygon (CCW or CW). */
export function triangulate(points) {
  const pts = polygonArea(points) < 0 ? [...points].reverse() : [...points];
  const n = pts.length;
  if (n < 3) return [];
  const indices = pts.map((_, i) => i);
  const result = [];
  const isConvex = (a, b, c) => (pts[b][0] - pts[a][0]) * (pts[c][1] - pts[a][1]) - (pts[b][1] - pts[a][1]) * (pts[c][0] - pts[a][0]) > 0;
  const inTriangle = (p, a, b, c) => {
    const sign = (m, n2, o) => (pts[m][0] - pts[o][0]) * (pts[n2][1] - pts[o][1]) - (pts[n2][0] - pts[o][0]) * (pts[m][1] - pts[o][1]);
    const d1 = sign(p, a, b); const d2 = sign(p, b, c); const d3 = sign(p, c, a);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  };
  let guard = 0;
  while (indices.length > 3 && guard < n * n + 16) {
    guard += 1;
    let clipped = false;
    for (let i = 0; i < indices.length; i += 1) {
      const a = indices[(i + indices.length - 1) % indices.length];
      const b = indices[i];
      const c = indices[(i + 1) % indices.length];
      if (!isConvex(a, b, c)) continue;
      const contains = indices.some((p) => p !== a && p !== b && p !== c && inTriangle(p, a, b, c));
      if (contains) continue;
      result.push([a, b, c]);
      indices.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (indices.length === 3) result.push([indices[0], indices[1], indices[2]]);
  return { triangles: result, points: pts };
}

/** Offset a closed 2D polygon inward/outward by `distance` (corner bevels). */
export function offsetPolygon(points, distance) {
  const ccw = polygonArea(points) > 0 ? points : [...points].reverse();
  // Insetting further than the profile's own inradius folds the outline
  // through itself and yields a self-intersecting (non-simple) polygon, which
  // is not a valid extrusion cap.
  if (distance < 0) {
    let shortest = Infinity;
    for (let i = 0; i < ccw.length; i += 1) {
      const a = ccw[i];
      const b = ccw[(i + 1) % ccw.length];
      shortest = Math.min(shortest, Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    if (Number.isFinite(shortest)) distance = -Math.min(Math.abs(distance), shortest * 0.49);
  }
  return ccw.map((p, i) => {
    const prev = ccw[(i + ccw.length - 1) % ccw.length];
    const next = ccw[(i + 1) % ccw.length];
    const n1 = normalize([p[1] - prev[1], -(p[0] - prev[0]), 0]);
    const n2 = normalize([next[1] - p[1], -(next[0] - p[0]), 0]);
    const bis = normalize([n1[0] + n2[0], n1[1] + n2[1], 0]);
    const cosHalf = Math.max(0.2, Math.sqrt(Math.max(0, (1 + (n1[0] * n2[0] + n1[1] * n2[1])) / 2)));
    return [p[0] + (bis[0] * distance) / cosHalf, p[1] + (bis[1] * distance) / cosHalf];
  });
}

/**
 * Extrude a closed 2D profile along +Y into a closed solid.
 * `bevel` chamfers the top and bottom rims by insetting the cap rings.
 */
export function extrude(profile, depth = 1, options = {}) {
  assertProfile(profile, 'extrude');
  const { bevel = 0, bevelSegments = 1, twist = 0, scaleTop = 1 } = options;
  const tri = triangulate(profile);
  if (!tri.triangles || !tri.triangles.length) throw new Error('extrude: profile could not be triangulated');
  const base = tri.points;
  const half = depth / 2;
  const rings = [];

  const ringAt = (y, inset, scale) => {
    const t = (y + half) / (depth || 1);
    const angle = twist * t;
    const cosA = Math.cos(angle); const sinA = Math.sin(angle);
    const source = inset > 0 ? offsetPolygon(base, -inset) : base;
    return source.map(([x, z]) => {
      const sx = x * scale; const sz = z * scale;
      return [sx * cosA - sz * sinA, y, sx * sinA + sz * cosA];
    });
  };

  const steps = bevel > 0 ? Math.max(1, bevelSegments | 0) : 0;
  for (let i = steps; i >= 0; i -= 1) {
    const f = i / Math.max(1, steps);
    if (steps === 0) break;
    rings.push(ringAt(-half + bevel * (1 - f) * 0 + bevel * (1 - Math.cos((Math.PI / 2) * (1 - f))) * 0 + (bevel * (1 - f)) * 0 + (-0), 0, 1));
    break;
  }
  rings.length = 0;

  const profileRings = [];
  if (bevel > 0) {
    for (let i = 0; i <= steps; i += 1) {
      const f = i / steps;
      const angle = (Math.PI / 2) * f;
      profileRings.push({ y: -half + bevel * (1 - Math.cos(angle)), inset: bevel * (1 - Math.sin(angle)), scale: 1 });
    }
    profileRings.push({ y: half - bevel, inset: 0, scale: scaleTop });
    for (let i = steps; i >= 0; i -= 1) {
      const f = i / steps;
      const angle = (Math.PI / 2) * f;
      profileRings.push({ y: half - bevel * (1 - Math.cos(angle)), inset: bevel * (1 - Math.sin(angle)), scale: scaleTop });
    }
  } else {
    profileRings.push({ y: -half, inset: 0, scale: 1 }, { y: half, inset: 0, scale: scaleTop });
  }

  // The bevel builder can emit the same ring twice at the mid-span; a repeated
  // ring produces a zero-height band of degenerate quads that survives welding
  // and then breaks BSP classification downstream.
  const deduped = profileRings.filter((ring, i) => {
    if (i === 0) return true;
    const previous = profileRings[i - 1];
    return Math.abs(ring.y - previous.y) > 1e-9 || Math.abs(ring.inset - previous.inset) > 1e-9;
  });
  const built = deduped.map(({ y, inset, scale }) => ringAt(y, inset, scale));
  const n = base.length;
  const vertices = built.flat().flat();
  const indices = [];
  for (let r = 0; r < built.length - 1; r += 1) {
    for (let s = 0; s < n; s += 1) {
      const s2 = (s + 1) % n;
      const a = r * n + s;
      const b = (r + 1) * n + s;
      const c = (r + 1) * n + s2;
      const d = r * n + s2;
      quad(indices, a, b, c, d);
    }
  }
  // Caps.
  const bottomOffset = 0;
  const topOffset = (built.length - 1) * n;
  for (const [a, b, c] of tri.triangles) {
    indices.push(bottomOffset + a, bottomOffset + c, bottomOffset + b);
    indices.push(topOffset + a, topOffset + b, topOffset + c);
  }
  return orient(mesh(vertices, indices));
}

/** Revolve a 2D profile (x = radius, y = height) around the Y axis. */
export function revolve(profile, segments = 24, angle = TAU) {
  assertProfile(profile, 'revolve');
  const seg = clampInt(segments, 3, LIMITS.maxSegments, 24);
  const closed = Math.abs(angle - TAU) < 1e-6;
  const rings = closed ? seg : seg + 1;
  const vertices = [];
  const indices = [];
  for (let i = 0; i < rings; i += 1) {
    const theta = (i / seg) * angle;
    for (const [r, y] of profile) {
      vertices.push(r * Math.cos(theta), y, r * Math.sin(theta));
    }
  }
  const n = profile.length;
  for (let i = 0; i < (closed ? rings : rings - 1); i += 1) {
    const next = (i + 1) % rings;
    for (let j = 0; j < n - 1; j += 1) {
      quad(indices, i * n + j, next * n + j, next * n + j + 1, i * n + j + 1);
    }
  }
  return orient(mesh(vertices, indices));
}

export function tube(outerRadius = 0.5, innerRadius = 0.3, height = 1, segments = 24) {
  const half = height / 2;
  return revolve([
    [innerRadius, -half], [outerRadius, -half],
    [outerRadius, half], [innerRadius, half], [innerRadius, -half]
  ], segments);
}

export function prism(sides = 6, radius = 0.5, height = 1) {
  const n = clampInt(sides, 3, LIMITS.maxSegments, 6);
  const profile = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * TAU;
    return [radius * Math.cos(a), radius * Math.sin(a)];
  });
  return extrude(profile, height);
}

export function pyramid(sides = 4, radius = 0.5, height = 1) {
  return cylinder(1e-10, radius, height, clampInt(sides, 3, LIMITS.maxSegments, 4));
}

export function wedge(width = 1, height = 1, depth = 1) {
  return extrude([[-width / 2, -depth / 2], [width / 2, -depth / 2], [-width / 2, depth / 2]], height);
}

/** Sweep a profile along an arbitrary 3D polyline (parallel-transport frames). */
export function sweep(profile, path, closed = false) {
  assertProfile(profile, 'sweep');
  if (!Array.isArray(path) || path.length < 2) throw new Error('sweep: path needs at least two points');
  if (path.length > LIMITS.maxSweepSteps) throw new Error(`sweep: path exceeds ${LIMITS.maxSweepSteps} points`);
  if (!path.every((p) => Array.isArray(p) && p.length >= 3 && p.every(Number.isFinite))) {
    throw new Error('sweep: every path point must be a finite [x, y, z]');
  }
  const frames = [];
  let normal = [0, 1, 0];
  for (let i = 0; i < path.length; i += 1) {
    const prev = path[Math.max(0, i - 1)];
    const next = path[Math.min(path.length - 1, i + 1)];
    const tangent = normalize(sub(next, prev));
    if (Math.abs(dot(tangent, normal)) > 0.99) normal = [1, 0, 0];
    const binormal = normalize(cross(tangent, normal));
    normal = normalize(cross(binormal, tangent));
    frames.push({ origin: path[i], u: binormal, v: normal });
  }
  const vertices = [];
  for (const { origin, u, v } of frames) {
    for (const [x, y] of profile) {
      vertices.push(
        origin[0] + u[0] * x + v[0] * y,
        origin[1] + u[1] * x + v[1] * y,
        origin[2] + u[2] * x + v[2] * y
      );
    }
  }
  const n = profile.length;
  const indices = [];
  const ringCount = frames.length;
  for (let i = 0; i < (closed ? ringCount : ringCount - 1); i += 1) {
    const next = (i + 1) % ringCount;
    for (let j = 0; j < n; j += 1) {
      const j2 = (j + 1) % n;
      quad(indices, i * n + j, next * n + j, next * n + j2, i * n + j2);
    }
  }
  if (!closed) {
    const tri = triangulate(profile);
    const top = (ringCount - 1) * n;
    for (const [a, b, c] of tri.triangles) {
      indices.push(a, c, b);
      indices.push(top + a, top + b, top + c);
    }
  }
  return orient(mesh(vertices, indices));
}

const roundedProfile = (w, d, r, steps = 4) => {
  const pts = [];
  const corners = [[w - r, d - r, 0], [-(w - r), d - r, Math.PI / 2], [-(w - r), -(d - r), Math.PI], [w - r, -(d - r), (3 * Math.PI) / 2]];
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= steps; i += 1) {
      const a = start + (i / steps) * (Math.PI / 2);
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  return pts;
};

export function roundedBox(width = 1, height = 1, depth = 1, radius = 0.1) {
  const r = Math.min(radius, Math.min(width, depth) / 2 - 1e-4);
  // The vertical bevel must stay strictly inside the corner radius: insetting
  // the cap by the full radius collapses each rounded corner to a point.
  const bevel = Math.max(1e-4, Math.min(r * 0.5, height / 2 - 1e-3));
  return extrude(roundedProfile(width / 2, depth / 2, Math.max(1e-4, r)), height, { bevel, bevelSegments: 3 });
}

/** Build any registered primitive from a parameter bag. */
export function buildPrimitive(type, params = {}) {
  const raw = params && typeof params === 'object' ? params : {};
  // Strip prototype-polluting keys and non-finite numbers before they reach a
  // geometry builder, where they would become NaN vertices or huge allocations.
  const p = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) p[key] = Number(value);
    else p[key] = value;
  }
  switch (type) {
    case 'cube': return box(p.width ?? 1, p.height ?? 1, p.depth ?? 1);
    case 'sphere': return sphere(p.radius ?? 0.5, p.segments ?? 24, p.rings ?? 16);
    case 'icosphere': return icosphere(p.radius ?? 0.5, p.subdivisions ?? 2);
    case 'cylinder': return cylinder(p.radius_top ?? p.radius ?? 0.5, p.radius_bottom ?? p.radius ?? 0.5, p.height ?? 1, p.segments ?? 24);
    case 'cone': return cone(p.radius ?? 0.5, p.height ?? 1, p.segments ?? 24);
    case 'torus': return torus(p.radius ?? 0.5, p.tube ?? 0.2, p.radial_segments ?? 24, p.tubular_segments ?? 16);
    case 'plane': return plane(p.width ?? 1, p.depth ?? 1, p.thickness ?? 0.02);
    case 'capsule': return capsule(p.radius ?? 0.3, p.height ?? 1, p.segments ?? 20, p.rings ?? 8);
    case 'tube': return tube(p.outer_radius ?? 0.5, p.inner_radius ?? 0.3, p.height ?? 1, p.segments ?? 24);
    case 'prism': return prism(p.sides ?? 6, p.radius ?? 0.5, p.height ?? 1);
    case 'pyramid': return pyramid(p.sides ?? 4, p.radius ?? 0.5, p.height ?? 1);
    case 'wedge': return wedge(p.width ?? 1, p.height ?? 1, p.depth ?? 1);
    case 'rounded_box': return roundedBox(p.width ?? 1, p.height ?? 1, p.depth ?? 1, p.radius ?? 0.1);
    default: throw new Error(`Unknown primitive type: ${type}`);
  }
}

/*
 * Physics & mechanical validation.
 *
 * For drones, robots and printed parts, "does it look right" is not enough.
 * This module answers questions an agent can act on without a renderer:
 * mass, inertia, centre of mass, static stability, collisions, joint limits,
 * and rigid-body settling under gravity.
 */

import {
  volume, centroid, bounds, triangles, getVertex, vertexCount, triangleCount,
  sub, add, cross, dot, length, normalize, scaleVec, boundsOverlap, containsPoint
} from './geom.js';

export const MATERIAL_DENSITY = {
  abs: 1040, pla: 1240, nylon: 1140, resin: 1180,
  aluminium: 2700, steel: 7850, titanium: 4500, brass: 8500,
  wood: 700, glass: 2500, rubber: 1100, foam: 60, carbon_fibre: 1600
};

export const GRAVITY = 9.80665;

/**
 * Mass properties by exact polyhedral integration.
 *   m = ρV,  and the inertia tensor is integrated per tetrahedron
 *   formed by each triangle and the origin.
 */
export function massProperties(mesh, material = 'abs', densityOverride = null) {
  const density = densityOverride ?? MATERIAL_DENSITY[material] ?? MATERIAL_DENSITY.abs;
  const v = Math.abs(volume(mesh));
  const com = centroid(mesh);
  const mass = v * density;

  // Inertia via the tetrahedron covariance method.
  let xx = 0; let yy = 0; let zz = 0; let xy = 0; let xz = 0; let yz = 0;
  for (const [a, b, c] of triangles(mesh)) {
    const det = dot(a, cross(b, c));
    const f = (i) => a[i] + b[i] + c[i];
    const g = (i, j) => a[i] * a[j] + b[i] * b[j] + c[i] * c[j] + f(i) * f(j);
    xx += det * g(0, 0); yy += det * g(1, 1); zz += det * g(2, 2);
    xy += det * g(0, 1); xz += det * g(0, 2); yz += det * g(1, 2);
  }
  const k = density / 120;
  const Ixx = k * (yy + zz); const Iyy = k * (xx + zz); const Izz = k * (xx + yy);

  return {
    volume: Number(v.toFixed(9)),
    density,
    material,
    mass: Number(mass.toFixed(6)),
    center_of_mass: com.map((n) => Number(n.toFixed(6))),
    inertia_tensor: {
      Ixx: Number(Ixx.toFixed(9)), Iyy: Number(Iyy.toFixed(9)), Izz: Number(Izz.toFixed(9)),
      Ixy: Number((-k * xy).toFixed(9)), Ixz: Number((-k * xz).toFixed(9)), Iyz: Number((-k * yz).toFixed(9))
    },
    weight_newtons: Number((mass * GRAVITY).toFixed(6))
  };
}

/** Convex hull of the ground-contact footprint (2D, XZ plane). */
export function supportPolygon(mesh, groundTolerance = 1e-3) {
  const b = bounds(mesh);
  const contact = [];
  for (let i = 0; i < vertexCount(mesh); i += 1) {
    const v = getVertex(mesh, i);
    if (v[1] - b.min[1] <= groundTolerance) contact.push([v[0], v[2]]);
  }
  if (contact.length < 3) return contact;
  // Andrew's monotone chain.
  const pts = [...contact].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross2 = (o, a, c) => (a[0] - o[0]) * (c[1] - o[1]) - (a[1] - o[1]) * (c[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross2(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i -= 1) {
    const p = pts[i];
    while (upper.length >= 2 && cross2(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

function pointInPolygon2D(point, polygon) {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects = (yi > point[1]) !== (yj > point[1]) &&
      point[0] < ((xj - xi) * (point[1] - yi)) / ((yj - yi) || 1e-12) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Static tip-over analysis. A body is stable when its centre of mass projects
 * inside the support polygon; the tipping angle is
 *   θ = atan(d / h)
 * where d is the horizontal distance to the nearest support edge and h the
 * centre-of-mass height above the contact plane.
 */
export function stabilityAnalysis(mesh, material = 'abs') {
  const props = massProperties(mesh, material);
  const b = bounds(mesh);
  const polygon = supportPolygon(mesh);
  const com2d = [props.center_of_mass[0], props.center_of_mass[2]];
  const height = Math.max(1e-6, props.center_of_mass[1] - b.min[1]);
  const stable = pointInPolygon2D(com2d, polygon);

  let margin = Infinity;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const c = polygon[(i + 1) % polygon.length];
    const edge = [c[0] - a[0], c[1] - a[1]];
    const len = Math.hypot(edge[0], edge[1]) || 1e-9;
    const distance = Math.abs(edge[0] * (a[1] - com2d[1]) - (a[0] - com2d[0]) * edge[1]) / len;
    margin = Math.min(margin, distance);
  }
  if (!Number.isFinite(margin)) margin = 0;

  return {
    stable,
    support_points: polygon.length,
    support_area: Number(polygonArea(polygon).toFixed(6)),
    center_of_mass: props.center_of_mass,
    com_height: Number(height.toFixed(6)),
    stability_margin: Number(margin.toFixed(6)),
    tipping_angle_deg: Number(((Math.atan(margin / height) * 180) / Math.PI).toFixed(3)),
    mass: props.mass,
    verdict: stable
      ? margin > height * 0.5 ? 'very stable' : 'stable'
      : 'will tip over'
  };
}

function polygonArea(polygon) {
  let area = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const [x1, y1] = polygon[i];
    const [x2, y2] = polygon[(i + 1) % polygon.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

/**
 * Separating-axis collision test between two convex-ish bodies, with an
 * AABB broad phase and vertex-containment narrow phase for concave shapes.
 */
export function collide(meshA, meshB) {
  const ba = bounds(meshA);
  const bb = bounds(meshB);
  if (!boundsOverlap(ba, bb)) {
    return { colliding: false, phase: 'broad', penetration: 0 };
  }
  let deepest = 0;
  let contacts = 0;
  const step = Math.max(1, Math.floor(vertexCount(meshA) / 64));
  for (let i = 0; i < vertexCount(meshA); i += step) {
    const v = getVertex(meshA, i);
    if (containsPoint(meshB, v)) {
      contacts += 1;
      const depth = Math.min(
        ...[0, 1, 2].flatMap((a) => [Math.abs(v[a] - bb.min[a]), Math.abs(bb.max[a] - v[a])])
      );
      deepest = Math.max(deepest, depth);
    }
  }
  const overlapBox = [0, 1, 2].map((a) => Math.min(ba.max[a], bb.max[a]) - Math.max(ba.min[a], bb.min[a]));
  return {
    colliding: contacts > 0,
    phase: contacts > 0 ? 'narrow' : 'broad-only',
    contact_samples: contacts,
    penetration: Number(deepest.toFixed(6)),
    overlap_volume_estimate: Number((overlapBox[0] * overlapBox[1] * overlapBox[2]).toFixed(6)),
    touching: contacts === 0
  };
}

export const JOINT_TYPES = ['fixed', 'revolute', 'prismatic', 'spherical', 'planar'];

/** Degrees of freedom removed by each joint class. */
const JOINT_DOF = { fixed: 0, revolute: 1, prismatic: 1, spherical: 3, planar: 3 };

/**
 * Kutzbach–Grübler mobility for a spatial linkage:
 *   M = 6(n - 1 - j) + Σ fᵢ
 * where n is body count, j joint count and fᵢ the freedoms of joint i.
 */
export function mechanismMobility(bodyCount, joints = []) {
  const j = joints.length;
  const freedoms = joints.reduce((sum, joint) => sum + (JOINT_DOF[joint.type] ?? 1), 0);
  const mobility = 6 * (bodyCount - 1 - j) + freedoms;
  return {
    bodies: bodyCount,
    joints: j,
    total_freedoms: freedoms,
    mobility,
    classification: mobility > 0 ? 'mechanism' : mobility === 0 ? 'structure (statically determinate)' : 'overconstrained',
    note: mobility < 0 ? 'Remove a joint or add a body — the linkage cannot move.' : null
  };
}

export function validateJoint(joint, angle) {
  const { type = 'revolute', limits = null } = joint;
  if (!JOINT_TYPES.includes(type)) return { valid: false, reason: `Unknown joint type "${type}"` };
  if (!limits) return { valid: true, within_limits: true };
  const [min, max] = limits;
  const within = angle >= min && angle <= max;
  return {
    valid: true,
    within_limits: within,
    angle,
    limits,
    overshoot: within ? 0 : Number((angle < min ? min - angle : angle - max).toFixed(6))
  };
}

/**
 * Semi-implicit Euler rigid-body settle under gravity with a ground plane.
 * Deterministic and step-bounded so agents can call it inside an eval.
 */
export function simulateDrop(bodies, options = {}) {
  const { steps = 120, dt = 1 / 60, restitution = 0.2, groundY = 0, friction = 0.4 } = options;
  const state = bodies.map((body) => {
    const props = massProperties(body.mesh, body.material || 'abs');
    const b = bounds(body.mesh);
    return {
      id: body.id,
      position: [...(body.position || [0, 0, 0])],
      velocity: [...(body.velocity || [0, 0, 0])],
      mass: props.mass || 1,
      halfHeight: (b.size[1] || 0) / 2,
      resting: false
    };
  });

  for (let step = 0; step < Math.min(1000, steps); step += 1) {
    for (const body of state) {
      if (body.resting) continue;
      body.velocity[1] -= GRAVITY * dt;
      for (let a = 0; a < 3; a += 1) body.position[a] += body.velocity[a] * dt;
      const floor = groundY + body.halfHeight;
      if (body.position[1] <= floor) {
        body.position[1] = floor;
        // The rest threshold must exceed the velocity gravity re-adds in one
        // step (g·dt), otherwise the body bounces forever at ~0.16 m/s.
        if (Math.abs(body.velocity[1]) < GRAVITY * dt * 1.5) {
          body.velocity = [0, 0, 0];
          body.resting = true;
        } else {
          body.velocity[1] = -body.velocity[1] * restitution;
          body.velocity[0] *= 1 - friction;
          body.velocity[2] *= 1 - friction;
        }
      }
    }
  }

  return {
    steps: Math.min(1000, steps),
    dt,
    bodies: state.map((body) => ({
      id: body.id,
      rest_position: body.position.map((n) => Number(n.toFixed(5))),
      settled: body.resting,
      mass: Number(body.mass.toFixed(5))
    })),
    all_settled: state.every((body) => body.resting)
  };
}

/** Printability / manufacturability heuristics for a single solid. */
export function printabilityReport(mesh, options = {}) {
  const { nozzle = 0.4, overhangLimitDeg = 45, layerHeight = 0.2 } = options;
  const b = bounds(mesh);
  const limit = Math.cos(((90 - overhangLimitDeg) * Math.PI) / 180);
  let overhangArea = 0;
  let totalArea = 0;
  let thinFacets = 0;

  for (const [a, c, d] of triangles(mesh)) {
    const n = cross(sub(c, a), sub(d, a));
    const area = length(n) / 2;
    totalArea += area;
    const unit = normalize(n);
    // A downward face sitting on the build plate is supported by the plate
    // itself, not an overhang. Only lift it into the overhang budget when it
    // is meaningfully above the first layer.
    const onBuildPlate = Math.max(a[1], c[1], d[1]) <= b.min[1] + layerHeight;
    if (unit[1] < -limit && !onBuildPlate) overhangArea += area;
    if (area < nozzle * nozzle * 0.25) thinFacets += 1;
  }

  const minDimension = Math.min(...b.size.filter((s) => s > 0), Infinity);
  return {
    bounding_box: b.size.map((n) => Number(n.toFixed(4))),
    layers: Math.ceil((b.size[1] || 0) / layerHeight),
    overhang_area_ratio: totalArea ? Number((overhangArea / totalArea).toFixed(4)) : 0,
    needs_support: totalArea > 0 && overhangArea / totalArea > 0.05,
    thin_facets: thinFacets,
    min_wall_ok: Number.isFinite(minDimension) ? minDimension >= nozzle * 2 : true,
    min_dimension: Number.isFinite(minDimension) ? Number(minDimension.toFixed(4)) : null,
    triangles: triangleCount(mesh),
    advice: [
      totalArea && overhangArea / totalArea > 0.25 ? 'Heavy overhangs — reorient or add supports.' : null,
      Number.isFinite(minDimension) && minDimension < nozzle * 2 ? `Wall thinner than ${(nozzle * 2).toFixed(2)}mm nozzle minimum.` : null,
      thinFacets > triangleCount(mesh) * 0.3 ? 'Mesh is over-tessellated for its size; decimate before slicing.' : null
    ].filter(Boolean)
  };
}

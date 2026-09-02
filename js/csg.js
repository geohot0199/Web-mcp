/*
 * Constructive Solid Geometry — a real BSP-tree boolean kernel.
 *
 * Orbit no longer "stacks shapes and notes overlaps". union / subtract /
 * intersect are evaluated exactly, by splitting polygons against the binary
 * space partition of the other solid and recombining the classified pieces:
 *
 *   A ∪ B = A_outside(B) ∪ B_outside(A)
 *   A ∖ B = A_outside(B) ∪ flip(B_inside(A))
 *   A ∩ B = A_inside(B)  ∪ B_inside(A)
 *
 * Implemented from first principles (no three-bvh-csg dependency) so it runs
 * unchanged in Node for the eval suite and in the browser for live modelling.
 */

import { mesh, weld, cleanMesh, mergeMeshes, triangleCount, sub, cross, dot, normalize, volume, repairTJunctions, orient, splitShells } from './geom.js';

const PLANE_EPS = 1e-6;
const COPLANAR = 0;
const FRONT = 1;
const BACK = 2;
const SPANNING = 3;

class Plane {
  constructor(normal, w) {
    this.normal = normal;
    this.w = w;
  }

  clone() {
    return new Plane([...this.normal], this.w);
  }

  static fromPoints(a, b, c) {
    const n = normalize(cross(sub(b, a), sub(c, a)));
    return new Plane(n, dot(n, a));
  }

  flip() {
    this.normal = [-this.normal[0], -this.normal[1], -this.normal[2]];
    this.w = -this.w;
  }

  /** Classify and, when spanning, split a polygon into the four buckets. */
  splitPolygon(polygon, coplanarFront, coplanarBack, front, back) {
    let polygonType = 0;
    const types = [];
    for (const vertex of polygon.vertices) {
      const t = dot(this.normal, vertex) - this.w;
      const type = t < -PLANE_EPS ? BACK : t > PLANE_EPS ? FRONT : COPLANAR;
      polygonType |= type;
      types.push(type);
    }

    if (polygonType === COPLANAR) {
      (dot(this.normal, polygon.plane.normal) > 0 ? coplanarFront : coplanarBack).push(polygon);
    } else if (polygonType === FRONT) {
      front.push(polygon);
    } else if (polygonType === BACK) {
      back.push(polygon);
    } else {
      const f = [];
      const b = [];
      for (let i = 0; i < polygon.vertices.length; i += 1) {
        const j = (i + 1) % polygon.vertices.length;
        const ti = types[i];
        const tj = types[j];
        const vi = polygon.vertices[i];
        const vj = polygon.vertices[j];
        if (ti !== BACK) f.push(vi);
        if (ti !== FRONT) b.push(vi);
        if ((ti | tj) === SPANNING) {
          const denom = dot(this.normal, sub(vj, vi));
          const t = Math.abs(denom) < 1e-12 ? 0 : (this.w - dot(this.normal, vi)) / denom;
          const v = [
            vi[0] + (vj[0] - vi[0]) * t,
            vi[1] + (vj[1] - vi[1]) * t,
            vi[2] + (vj[2] - vi[2]) * t
          ];
          f.push(v);
          b.push(v);
        }
      }
      if (f.length >= 3) front.push(new Polygon(f, polygon.shared));
      if (b.length >= 3) back.push(new Polygon(b, polygon.shared));
    }
  }
}

class Polygon {
  constructor(vertices, shared = null) {
    this.vertices = vertices;
    this.shared = shared;
    this.plane = Plane.fromPoints(vertices[0], vertices[1], vertices[2]);
  }

  flip() {
    this.vertices.reverse();
    this.plane.flip();
  }

  clone() {
    return new Polygon(this.vertices.map((v) => [...v]), this.shared);
  }
}

class Node {
  constructor(polygons) {
    this.plane = null;
    this.front = null;
    this.back = null;
    this.polygons = [];
    if (polygons && polygons.length) this.build(polygons);
  }

  invert() {
    this.polygons.forEach((polygon) => polygon.flip());
    if (this.plane) this.plane.flip();
    if (this.front) this.front.invert();
    if (this.back) this.back.invert();
    const temp = this.front;
    this.front = this.back;
    this.back = temp;
  }

  /** Remove the parts of `polygons` that fall inside this solid. */
  clipPolygons(polygons) {
    if (!this.plane) return polygons.slice();
    let front = [];
    let back = [];
    for (const polygon of polygons) {
      this.plane.splitPolygon(polygon, front, back, front, back);
    }
    if (this.front) front = this.front.clipPolygons(front);
    back = this.back ? this.back.clipPolygons(back) : [];
    return front.concat(back);
  }

  clipTo(bsp) {
    this.polygons = bsp.clipPolygons(this.polygons);
    if (this.front) this.front.clipTo(bsp);
    if (this.back) this.back.clipTo(bsp);
  }

  allPolygons() {
    let result = this.polygons.slice();
    if (this.front) result = result.concat(this.front.allPolygons());
    if (this.back) result = result.concat(this.back.allPolygons());
    return result;
  }

  build(polygons) {
    if (!polygons.length) return;
    if (!this.plane) this.plane = polygons[0].plane.clone();
    const front = [];
    const back = [];
    for (const polygon of polygons) {
      this.plane.splitPolygon(polygon, this.polygons, this.polygons, front, back);
    }
    if (front.length) {
      if (!this.front) this.front = new Node(null);
      this.front.build(front);
    }
    if (back.length) {
      if (!this.back) this.back = new Node(null);
      this.back.build(back);
    }
  }
}

function meshToPolygons(source, shared = null) {
  const polygons = [];
  for (let i = 0; i < source.indices.length; i += 3) {
    const a = source.indices[i]; const b = source.indices[i + 1]; const c = source.indices[i + 2];
    const va = [source.vertices[a * 3], source.vertices[a * 3 + 1], source.vertices[a * 3 + 2]];
    const vb = [source.vertices[b * 3], source.vertices[b * 3 + 1], source.vertices[b * 3 + 2]];
    const vc = [source.vertices[c * 3], source.vertices[c * 3 + 1], source.vertices[c * 3 + 2]];
    const n = cross(sub(vb, va), sub(vc, va));
    if (Math.sqrt(dot(n, n)) / 2 < 1e-12) continue;
    polygons.push(new Polygon([va, vb, vc], shared));
  }
  return polygons;
}

function polygonsToMesh(polygons) {
  const out = mesh();
  for (const polygon of polygons) {
    const base = out.vertices.length / 3;
    for (const v of polygon.vertices) out.vertices.push(v[0], v[1], v[2]);
    // Fan-triangulate the (convex-by-construction) clipped polygon.
    for (let i = 1; i < polygon.vertices.length - 1; i += 1) {
      out.indices.push(base, base + i, base + i + 1);
    }
  }
  return orient(repairTJunctions(cleanMesh(out)));
}

function evaluate(a, b, operation) {
  // A BSP tree can only classify against a single closed region. Disjoint
  // shells are handled by distributing the operation over them:
  //   (A₁ ∪ A₂) op B  =  (A₁ op B) ∪ (A₂ op B)   for op ∈ {∖, ∩}
  //   A ∪ (B₁ ∪ B₂)   =  ((A ∪ B₁) ∪ B₂)
  const shellsA = splitShells(a);
  const shellsB = splitShells(b);
  if (shellsA.length > 1 || shellsB.length > 1) {
    if (operation === 'union') {
      return [...shellsA, ...shellsB].reduce((acc, shell) => (acc ? evaluate(acc, shell, 'union') : shell), null);
    }
    if (operation === 'intersect') {
      // A ∩ (B₁ ∪ B₂) = (A ∩ B₁) ∪ (A ∩ B₂): distribute over the B shells
      // and merge the non-empty parts. Folding sequentially (A ∩ B₁) ∩ B₂
      // would stop at the first disjoint B shell and never reach a later one
      // that actually overlaps A.
      const parts = [];
      for (const shellA of shellsA) {
        for (const shellB of shellsB) {
          const part = evaluate(shellA, shellB, 'intersect');
          if (triangleCount(part)) parts.push(part);
        }
      }
      if (!parts.length) return mesh();
      return parts.length === 1 ? parts[0] : mergeMeshes(parts);
    }
    // Subtract: (A₁ ∪ A₂) ∖ (B₁ ∪ B₂) = (A₁ ∖ B₁ ∖ B₂…) ∪ (A₂ ∖ B₁ ∖ B₂…)
    // — a correct left fold, and an empty intermediate is genuinely final
    // (∅ ∖ anything = ∅), so skipping the rest of the chain is safe here.
    const parts = shellsA
      .map((shell) => shellsB.reduce((acc, other) => (acc && triangleCount(acc) ? evaluate(acc, other, operation) : acc), shell))
      .filter((part) => part && triangleCount(part) > 0);
    if (!parts.length) return mesh();
    return parts.length === 1 ? parts[0] : mergeMeshes(parts);
  }

  const nodeA = new Node(meshToPolygons(a));
  const nodeB = new Node(meshToPolygons(b));

  if (operation === 'union') {
    nodeA.clipTo(nodeB);
    nodeB.clipTo(nodeA);
    nodeB.invert();
    nodeB.clipTo(nodeA);
    nodeB.invert();
    nodeA.build(nodeB.allPolygons());
    return polygonsToMesh(nodeA.allPolygons());
  }

  if (operation === 'subtract') {
    nodeA.invert();
    nodeA.clipTo(nodeB);
    nodeB.clipTo(nodeA);
    nodeB.invert();
    nodeB.clipTo(nodeA);
    nodeB.invert();
    nodeA.build(nodeB.allPolygons());
    nodeA.invert();
    return polygonsToMesh(nodeA.allPolygons());
  }

  if (operation === 'intersect') {
    nodeA.invert();
    nodeB.clipTo(nodeA);
    nodeB.invert();
    nodeA.clipTo(nodeB);
    nodeB.clipTo(nodeA);
    nodeA.build(nodeB.allPolygons());
    nodeA.invert();
    return polygonsToMesh(nodeA.allPolygons());
  }

  throw new Error(`Unknown boolean operation: ${operation}`);
}

export const union = (a, b) => evaluate(a, b, 'union');
export const subtract = (a, b) => evaluate(a, b, 'subtract');
export const intersect = (a, b) => evaluate(a, b, 'intersect');

/**
 * XOR. Computed as (A ∖ B) ∪ (B ∖ A) rather than (A ∪ B) ∖ (A ∩ B): the two are
 * equal in set theory, but the latter feeds two solids that share exact
 * coplanar boundary faces back into the BSP, where the coplanar-classification
 * tie-break loses volume. The disjoint form has no shared faces.
 */
export const symmetricDifference = (a, b) => {
  const left = subtract(a, b);
  const right = subtract(b, a);
  // The two halves are interior-disjoint by construction and each already
  // carries correct outward winding from subtract(). They are combined
  // directly: re-running a BSP union over their exact coplanar interface
  // loses volume, and re-orienting welds them into one shell whose net signed
  // volume flips one half inward.
  return mergeMeshes([left, right]);
};

export const OPERATIONS = ['union', 'subtract', 'intersect', 'xor'];

/**
 * Fold a boolean over an ordered list of meshes, left to right.
 * Returns the result plus a report an agent can reason about without a viewport.
 */
export function booleanOperation(meshes, operation = 'union') {
  if (!Array.isArray(meshes) || meshes.length < 2) {
    throw new Error('booleanOperation needs at least two meshes');
  }
  const op = operation === 'difference' ? 'subtract' : operation;
  const apply = op === 'xor' ? symmetricDifference : (a, b) => evaluate(a, b, op);

  const inputVolume = meshes.map((m) => Math.abs(volume(m)));
  let result = meshes[0];
  for (let i = 1; i < meshes.length; i += 1) result = apply(result, meshes[i]);

  const resultVolume = Math.abs(volume(result));
  return {
    mesh: result,
    report: {
      operation: op,
      operands: meshes.length,
      input_volume: inputVolume.map((v) => Number(v.toFixed(6))),
      result_volume: Number(resultVolume.toFixed(6)),
      result_triangles: result.indices.length / 3,
      // Union can never exceed the sum; subtraction never exceeds the minuend.
      volume_sane:
        op === 'union' ? resultVolume <= inputVolume.reduce((s, v) => s + v, 0) + 1e-6
          : op === 'subtract' ? resultVolume <= inputVolume[0] + 1e-6
            : resultVolume <= Math.min(...inputVolume) + 1e-6
    }
  };
}

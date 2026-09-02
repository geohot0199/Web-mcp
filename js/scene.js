/*
 * Orbit scene kernel — the agent-owned world.
 *
 * There is no human approval layer, no proposal staging and no permission
 * gate. An agent has full authority over the scene; safety comes from
 * determinism, validation and a complete undo history rather than from asking
 * a person. Every mutation is journalled so any state is recoverable.
 */

import {
  mesh, mergeMeshes, bounds, volume, centroid, surfaceArea, transformMesh,
  compose, triangleCount, vertexCount, manifoldReport, boundsOverlap,
  raycastMesh, normalize, sub, length, weld
} from './geom.js';
import { buildPrimitive, PRIMITIVE_TYPES, extrude, revolve, sweep } from './primitives.js';
import { booleanOperation } from './csg.js';
import { applyStack, MODIFIERS, MODIFIER_NAMES, __bindCsg } from './modifiers.js';
import { subtract } from './csg.js';
import { importMesh, exportMesh, SUPPORTED_IMPORT, SUPPORTED_EXPORT } from './io.js';
import { massProperties, stabilityAnalysis, collide, simulateDrop, printabilityReport, mechanismMobility, MATERIAL_DENSITY, JOINT_TYPES } from './physics.js';
import { evaluateGraph, validateGraph, NODE_TYPES } from './nodegraph.js';

__bindCsg(subtract);

export const MATERIALS = ['metal', 'plastic', 'glass', 'wood', 'emissive', 'rubber', 'ceramic', 'carbon'];

const MATERIAL_DEFAULTS = {
  metal: { roughness: 0.21, metalness: 0.92 },
  plastic: { roughness: 0.62, metalness: 0.04 },
  glass: { roughness: 0.05, metalness: 0.02, opacity: 0.3 },
  wood: { roughness: 0.85, metalness: 0.02 },
  emissive: { roughness: 0.30, metalness: 0.10, emissive: 1 },
  rubber: { roughness: 0.95, metalness: 0.0 },
  ceramic: { roughness: 0.35, metalness: 0.0 },
  carbon: { roughness: 0.45, metalness: 0.30 }
};

let counter = 0;
const nextId = (prefix) => `${prefix}_${(counter += 1)}`;

export function createScene(options = {}) {
  const scene = {
    objects: new Map(),
    groups: new Map(),
    joints: new Map(),
    graphs: new Map(),
    selection: new Set(),
    camera: {
      position: [4, 3, 6], target: [0, 0, 0], up: [0, 1, 0],
      fov: 45, near: 0.1, far: 500, projection: 'perspective'
    },
    environment: {
      hdri: 'studio', exposure: 1.0, background: '#0d0d0d',
      ambient_intensity: 0.35, shadows: true, ground_shadow: true,
      post: { bloom: 0, ssao: 0, vignette: 0.15, tonemap: 'aces' }
    },
    units: options.units || 'meters',
    history: [],
    historyIndex: -1,
    journal: [],
    triangles: 0,
    limits: { max_objects: 5000, max_triangles: 4_000_000 }
  };
  // Seed the journal with the empty scene so the very first mutation can be
  // undone back to a truly empty world (total undo, not "everything except
  // the first edit").
  scene.history = [{ label: 'initial scene', detail: { kind: 'bootstrap' }, state: snapshot(scene), at: 0 }];
  scene.historyIndex = 0;
  return scene;
}

/* --------------------------------------------------------------- history */

function snapshot(scene) {
  return {
    objects: [...scene.objects.entries()].map(([id, object]) => [id, {
      ...object,
      mesh: undefined,
      _meshCache: undefined,
      transform: { ...object.transform },
      modifiers: object.modifiers.map((m) => ({ ...m })),
      tags: [...object.tags]
    }]),
    groups: [...scene.groups.entries()].map(([id, group]) => [id, { ...group, children: [...group.children] }]),
    joints: [...scene.joints.entries()].map(([id, joint]) => [id, { ...joint }]),
    graphs: [...scene.graphs.entries()].map(([id, graph]) => [id, JSON.parse(JSON.stringify(graph))]),
    selection: [...scene.selection],
    camera: { ...scene.camera },
    environment: JSON.parse(JSON.stringify(scene.environment)),
    triangles: scene.triangles
  };
}

function restore(scene, state) {
  scene.objects = new Map(state.objects.map(([id, object]) => [id, {
    ...object,
    transform: { ...object.transform },
    modifiers: object.modifiers.map((m) => ({ ...m })),
    tags: [...object.tags],
    _meshCache: null
  }]));
  scene.groups = new Map(state.groups.map(([id, group]) => [id, { ...group, children: [...group.children] }]));
  scene.joints = new Map(state.joints.map(([id, joint]) => [id, { ...joint }]));
  scene.graphs = new Map((state.graphs || []).map(([id, graph]) => [id, JSON.parse(JSON.stringify(graph))]));
  scene.selection = new Set(state.selection);
  scene.camera = { ...state.camera };
  scene.environment = JSON.parse(JSON.stringify(state.environment));
  scene.triangles = state.triangles || 0;
}

export function commit(scene, label, detail = {}) {
  scene.history = scene.history.slice(0, scene.historyIndex + 1);
  scene.history.push({ label, detail, state: snapshot(scene), at: scene.history.length });
  if (scene.history.length > 200) scene.history.shift();
  scene.historyIndex = scene.history.length - 1;
  scene.journal.push({ label, detail, index: scene.historyIndex });
  if (scene.journal.length > 1000) scene.journal.shift();
}

export function undo(scene, steps = 1) {
  const n = Math.max(1, steps | 0);
  const target = Math.max(0, scene.historyIndex - n);
  if (scene.historyIndex <= 0) return { undone: 0, reason: 'nothing to undo' };
  const moved = scene.historyIndex - target;
  scene.historyIndex = target;
  restore(scene, scene.history[target].state);
  return { undone: moved, restored_to: scene.history[target].label, history_index: target };
}

export function redo(scene, steps = 1) {
  const n = Math.max(1, steps | 0);
  const target = Math.min(scene.history.length - 1, scene.historyIndex + n);
  if (target <= scene.historyIndex) return { redone: 0, reason: 'nothing to redo' };
  const moved = target - scene.historyIndex;
  scene.historyIndex = target;
  restore(scene, scene.history[target].state);
  return { redone: moved, restored_to: scene.history[target].label, history_index: target };
}

/* --------------------------------------------------------------- objects */

function makeObject(spec = {}) {
  const type = spec.type || 'cube';
  const scale = typeof spec.scale === 'number' ? asNumber(spec.scale, 'scale') : undefined;
  return {
    id: spec.id || nextId(type),
    name: spec.name || `${type} ${counter}`,
    kind: spec.kind || 'primitive',
    type,
    params: { ...(spec.params || {}) },
    transform: {
      // Validated at the boundary: every creation path (create, duplicate,
      // freeform, graph instantiation, import) passes through here, so a
      // malformed transform can never reach the object map.
      position: spec.position !== undefined ? asVec3(spec.position, 'position') : [0, 0, 0],
      rotation: spec.rotation !== undefined ? asVec3(spec.rotation, 'rotation') : [0, 0, 0],
      scale: scale !== undefined ? [scale, scale, scale] : (spec.scale !== undefined ? asVec3(spec.scale, 'scale') : [1, 1, 1])
    },
    material: spec.material || 'plastic',
    color: spec.color || '#c8c8c8',
    roughness: spec.roughness ?? null,
    metalness: spec.metalness ?? null,
    opacity: spec.opacity ?? null,
    modifiers: spec.modifiers ? spec.modifiers.map((m) => ({ ...m })) : [],
    tags: [...(spec.tags || [])],
    group: spec.group || null,
    visible: spec.visible !== false,
    baseMesh: spec.baseMesh || null,
    _meshCache: null
  };
}

/** Local-space mesh: base geometry + modifier stack (cached). */
export function objectMesh(object) {
  if (object._meshCache) return object._meshCache;
  const base = object.baseMesh
    ? mesh(object.baseMesh.vertices, object.baseMesh.indices)
    : buildPrimitive(object.type, object.params);
  const { mesh: result } = applyStack(base, object.modifiers);
  object._meshCache = result;
  return result;
}

/** World-space mesh with the object's transform baked in. */
export function worldMesh(object) {
  const { position, rotation, scale } = object.transform;
  return transformMesh(objectMesh(object), compose(position, rotation, scale));
}

const invalidate = (object) => { object._meshCache = null; };

/** Local-space triangle count of an object's current mesh (cached). */
function trianglesOf(object) {
  try { return triangleCount(objectMesh(object)); } catch { return 0; }
}

/* -------------------------------------------------- argument validation */

/**
 * Every vector argument is validated at the tool boundary: exactly three
 * finite numbers. The postMessage bridge does not run JSON schemas, so a
 * malformed cross-frame request must be rejected here, never committed into
 * a transform where it would poison world bounds, physics and exports.
 */
function asVec3(value, name) {
  if (!Array.isArray(value) || value.length !== 3 || value.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    throw new Error(`${name} must be an array of three finite numbers, e.g. [0, 1, 0]`);
  }
  return [...value];
}

function asVec2(value, name) {
  if (!Array.isArray(value) || value.length < 2 || value.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    throw new Error(`${name} must be an array of finite numbers`);
  }
  return [...value];
}

function asNumber(value, name, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

function requireObject(scene, id) {
  if (id === undefined || id === null || id === '') {
    // Reached when a tool fell back to an empty selection. Saying
    // 'No object with id "undefined"' sends an autonomous agent hunting for a
    // nonexistent object instead of selecting one.
    throw new Error('no object id given and the selection is empty — pass `id`, or call select_object first');
  }
  const object = scene.objects.get(id);
  if (!object) {
    const known = [...scene.objects.keys()];
    throw new Error(`No object with id "${id}"${known.length ? ` — live ids: ${known.slice(0, 8).join(', ')}${known.length > 8 ? `, +${known.length - 8} more` : ''}` : ' — the scene is empty'}`);
  }
  return object;
}

function describe(scene, object, deep = false) {
  const world = worldMesh(object);
  const b = bounds(world);
  const defaults = MATERIAL_DEFAULTS[object.material] || {};
  const summary = {
    id: object.id,
    name: object.name,
    kind: object.kind,
    type: object.type,
    params: object.params,
    position: object.transform.position.map((n) => Number(n.toFixed(5))),
    rotation: object.transform.rotation.map((n) => Number(n.toFixed(5))),
    scale: object.transform.scale.map((n) => Number(n.toFixed(5))),
    material: object.material,
    color: object.color,
    roughness: object.roughness ?? defaults.roughness ?? null,
    metalness: object.metalness ?? defaults.metalness ?? null,
    modifiers: object.modifiers.map((m) => m.type),
    tags: object.tags,
    group: object.group,
    visible: object.visible,
    triangles: triangleCount(world),
    world_bounds: { min: b.min.map((n) => Number(n.toFixed(5))), max: b.max.map((n) => Number(n.toFixed(5))), size: b.size.map((n) => Number(n.toFixed(5))) }
  };
  if (!deep) return summary;
  return {
    ...summary,
    vertices: vertexCount(world),
    volume: Number(Math.abs(volume(world)).toFixed(6)),
    surface_area: Number(surfaceArea(world).toFixed(6)),
    centroid: centroid(world).map((n) => Number(n.toFixed(5))),
    manifold: manifoldReport(world),
    neighbours: [...scene.objects.values()]
      .filter((other) => other.id !== object.id)
      .map((other) => ({ id: other.id, distance: Number(length(sub(bounds(worldMesh(other)).center, b.center)).toFixed(4)) }))
      .sort((a, c) => a.distance - c.distance)
      .slice(0, 5)
  };
}

/* -------------------------------------------- shared mutation helpers */

/**
 * The only door into `scene.objects`. Every creation path — create,
 * duplicate, freeform, graph instantiation, import, boolean result —
 * funnels through here so the advertised ceilings hold no matter which tool
 * an agent reaches for:
 *   · object count vs `limits.max_objects`
 *   · aggregate triangle count vs `limits.max_triangles`
 *   · id uniqueness (a live id can never be silently overwritten)
 * The scene's running triangle counter is updated here and on every removal,
 * so repeated insertions stay O(1) instead of re-scanning the whole scene.
 */
function insertObjects(scene, objects) {
  if (!objects.length) return;
  const incomingTris = objects.reduce((sum, object) => sum + trianglesOf(object), 0);
  for (const object of objects) {
    if (scene.objects.has(object.id)) {
      throw new Error(`Object id "${object.id}" already exists — ids must be unique; pick a new id or delete the existing object first`);
    }
  }
  if (scene.objects.size + objects.length > scene.limits.max_objects) {
    throw new Error(`Scene object limit reached (${scene.limits.max_objects}) — delete objects or use a boolean to merge them`);
  }
  if (scene.triangles + incomingTris > scene.limits.max_triangles) {
    throw new Error(`Scene triangle budget exceeded (${scene.triangles.toLocaleString()} live + ${incomingTris.toLocaleString()} incoming > ${scene.limits.max_triangles.toLocaleString()})`);
  }
  for (const object of objects) scene.objects.set(object.id, object);
  scene.triangles += incomingTris;
}

/**
 * Remove an object and everything that referenced it: selection, group
 * membership and any joint whose parent or child is going away. Leaving
 * dangling joints behind would make mobility reports count constraints on
 * nonexistent bodies.
 */
function purgeObject(scene, id) {
  const object = scene.objects.get(id);
  if (object) scene.triangles -= trianglesOf(object);
  scene.objects.delete(id);
  scene.selection.delete(id);
  for (const group of scene.groups.values()) {
    group.children = group.children.filter((child) => child !== id);
  }
  for (const [jointId, joint] of [...scene.joints]) {
    if (joint.parent === id || joint.child === id) scene.joints.delete(jointId);
  }
}

/* ----------------------------------------------------------------- tools */

export function createTools(scene) {
  const ok = (payload) => ({ ok: true, ...payload });

  const api = {
    /* ------------------------------------------------------- core CRUD */

    create_object(args = {}) {
      const type = args.type || 'cube';
      if (!PRIMITIVE_TYPES.includes(type) && type !== 'rounded_box' && type !== 'mesh') {
        throw new Error(`Unknown type "${type}". Available: ${[...PRIMITIVE_TYPES, 'rounded_box'].join(', ')}`);
      }
      const object = makeObject(args);
      objectMesh(object);
      insertObjects(scene, [object]);
      if (args.select !== false) scene.selection = new Set([object.id]);
      commit(scene, `create ${object.type}`, { id: object.id });
      return ok({ object: describe(scene, object) });
    },

    delete_object(args = {}) {
      const ids = args.ids || (args.id ? [args.id] : [...scene.selection]);
      if (!Array.isArray(ids) || !ids.length) {
        throw new Error('delete_object: no ids given and the selection is empty — pass id, ids, or select something first');
      }
      const removed = [];
      for (const id of ids) {
        requireObject(scene, id);
        purgeObject(scene, id);
        removed.push(id);
      }
      commit(scene, `delete ${removed.length} object(s)`, { ids: removed });
      return ok({ deleted: removed, remaining: scene.objects.size });
    },

    duplicate_object(args = {}) {
      const ids = args.ids || (args.id ? [args.id] : [...scene.selection]);
      if (!ids.length) throw new Error('duplicate_object: no ids and empty selection');
      const offset = args.offset || [0, 0, 0];
      const copies = [];
      for (const id of ids) {
        const source = requireObject(scene, id);
        copies.push(makeObject({
          ...source,
          id: nextId(source.type),
          name: `${source.name} copy`,
          position: source.transform.position.map((n, i) => n + (offset[i] || 0)),
          rotation: [...source.transform.rotation],
          scale: [...source.transform.scale],
          modifiers: source.modifiers,
          tags: source.tags,
          baseMesh: source.baseMesh
        }));
      }
      insertObjects(scene, copies);
      scene.selection = new Set(copies.map((c) => c.id));
      commit(scene, `duplicate ${copies.length}`, { ids: copies.map((c) => c.id) });
      return ok({ created: copies.map((c) => c.id) });
    },

    move_object(args = {}) {
      const ids = args.ids || (args.id ? [args.id] : [...scene.selection]);
      if (!ids.length) throw new Error('move_object: no ids and empty selection');
      const position = args.position !== undefined ? asVec3(args.position, 'position') : undefined;
      const delta = args.delta !== undefined ? asVec3(args.delta, 'delta') : undefined;
      const results = [];
      for (const id of ids) {
        const object = requireObject(scene, id);
        if (position) object.transform.position = [...position];
        else if (delta) object.transform.position = object.transform.position.map((n, i) => n + (delta[i] || 0));
        if (args.drop_to_ground) {
          const b = bounds(worldMesh(object));
          object.transform.position[1] -= b.min[1];
        }
        results.push({ id, position: object.transform.position.map((n) => Number(n.toFixed(5))) });
      }
      commit(scene, `move ${ids.length}`, { ids });
      return ok({ moved: results });
    },

    rotate_object(args = {}) {
      const ids = args.ids || (args.id ? [args.id] : [...scene.selection]);
      if (!ids.length) throw new Error('rotate_object: no ids and empty selection');
      const toRad = (v) => (args.degrees === false ? v : (v * Math.PI) / 180);
      const rotation = args.rotation !== undefined ? asVec3(args.rotation, 'rotation') : undefined;
      const delta = args.delta !== undefined ? asVec3(args.delta, 'delta') : undefined;
      const angle = args.angle !== undefined ? asNumber(args.angle, 'angle') : undefined;
      const results = [];
      for (const id of ids) {
        const object = requireObject(scene, id);
        if (rotation) object.transform.rotation = rotation.map(toRad);
        else if (delta) object.transform.rotation = object.transform.rotation.map((n, i) => n + toRad(delta[i] || 0));
        else if (args.axis !== undefined && angle !== undefined) {
          const index = { x: 0, y: 1, z: 2 }[args.axis] ?? 1;
          object.transform.rotation[index] += toRad(angle);
        }
        results.push({ id, rotation_deg: object.transform.rotation.map((n) => Number(((n * 180) / Math.PI).toFixed(3))) });
      }
      commit(scene, `rotate ${ids.length}`, { ids });
      return ok({ rotated: results });
    },

    scale_object(args = {}) {
      const ids = args.ids || (args.id ? [args.id] : [...scene.selection]);
      if (!ids.length) throw new Error('scale_object: no ids and empty selection');
      const factor = args.factor !== undefined ? asNumber(args.factor, 'factor') : undefined;
      const scale = args.scale !== undefined
        ? (typeof args.scale === 'number'
            ? [asNumber(args.scale, 'scale'), asNumber(args.scale, 'scale'), asNumber(args.scale, 'scale')]
            : asVec3(args.scale, 'scale'))
        : undefined;
      const amount = args.amount !== undefined ? asNumber(args.amount, 'amount') : undefined;
      const results = [];
      for (const id of ids) {
        const object = requireObject(scene, id);
        if (factor !== undefined) {
          object.transform.scale = object.transform.scale.map((n) => n * factor);
        } else if (scale) {
          object.transform.scale = [...scale];
        } else if (args.axis && amount !== undefined) {
          const index = { x: 0, y: 1, z: 2 }[args.axis] ?? 1;
          object.transform.scale[index] *= amount;
        }
        object.transform.scale = object.transform.scale.map((n) => (Math.abs(n) < 1e-4 ? Math.sign(n || 1) * 1e-4 : n));
        results.push({ id, scale: object.transform.scale.map((n) => Number(n.toFixed(5))) });
      }
      commit(scene, `scale ${ids.length}`, { ids });
      return ok({ scaled: results });
    },

    set_material(args = {}) {
      const ids = args.ids || (args.id ? [args.id] : [...scene.selection]);
      if (!ids.length) throw new Error('set_material: no ids and empty selection');
      if (args.material && !MATERIALS.includes(args.material)) {
        throw new Error(`Unknown material "${args.material}". Available: ${MATERIALS.join(', ')}`);
      }
      const roughness = args.roughness !== undefined ? Math.min(1, Math.max(0, asNumber(args.roughness, 'roughness'))) : undefined;
      const metalness = args.metalness !== undefined ? Math.min(1, Math.max(0, asNumber(args.metalness, 'metalness'))) : undefined;
      const opacity = args.opacity !== undefined ? Math.min(1, Math.max(0, asNumber(args.opacity, 'opacity'))) : undefined;
      const results = [];
      for (const id of ids) {
        const object = requireObject(scene, id);
        if (args.material) object.material = args.material;
        if (args.color) object.color = args.color;
        if (roughness !== undefined) object.roughness = roughness;
        if (metalness !== undefined) object.metalness = metalness;
        if (opacity !== undefined) object.opacity = opacity;
        results.push(describe(scene, object));
      }
      commit(scene, `material ${ids.length}`, { ids });
      return ok({ updated: results });
    },

    set_camera(args = {}) {
      const camera = scene.camera;
      if (args.position) camera.position = asVec3(args.position, 'position');
      if (args.target) camera.target = asVec3(args.target, 'target');
      if (args.up) camera.up = asVec3(args.up, 'up');
      if (args.fov !== undefined) camera.fov = Math.min(160, Math.max(5, asNumber(args.fov, 'fov')));
      if (args.near !== undefined) camera.near = Math.max(0.001, asNumber(args.near, 'near'));
      if (args.far !== undefined) camera.far = Math.max(camera.near + 0.001, asNumber(args.far, 'far'));
      if (args.projection && !['perspective', 'orthographic'].includes(args.projection)) {
        throw new Error(`Unknown projection "${args.projection}" — use "perspective" or "orthographic"`);
      }
      if (args.projection) camera.projection = args.projection;
      if (args.frame_all || args.frame) {
        const meshes = [...scene.objects.values()].filter((o) => o.visible).map(worldMesh);
        if (meshes.length) {
          const b = bounds(mergeMeshes(meshes));
          const radius = Math.max(...b.size) || 1;
          const distance = (radius / 2) / Math.tan(((camera.fov / 2) * Math.PI) / 180) * 1.8;
          camera.target = b.center;
          const dir = normalize(args.direction ? asVec3(args.direction, 'direction') : [1, 0.7, 1]);
          camera.position = b.center.map((n, i) => n + dir[i] * distance);
        }
      }
      if (args.preset) {
        const presets = {
          front: [0, 0, 1], back: [0, 0, -1], left: [-1, 0, 0],
          right: [1, 0, 0], top: [0, 1, 0], bottom: [0, -1, 0], iso: [1, 0.8, 1]
        };
        const dir = normalize(presets[args.preset] || presets.iso);
        const distance = length(sub(camera.position, camera.target)) || 8;
        camera.position = camera.target.map((n, i) => n + dir[i] * distance);
      }
      commit(scene, 'camera', { preset: args.preset || null });
      return ok({ camera: { ...camera } });
    },

    group_objects(args = {}) {
      const ids = args.ids || [...scene.selection];
      if (ids.length < 1) throw new Error('group_objects: nothing to group');
      ids.forEach((id) => requireObject(scene, id));
      const group = {
        id: args.id || nextId('group'),
        name: args.name || `Group ${scene.groups.size + 1}`,
        children: [...ids],
        tags: args.tags || []
      };
      if (scene.groups.has(group.id)) {
        throw new Error(`Group id "${group.id}" already exists — pick a new id or ungroup the existing group first`);
      }
      scene.groups.set(group.id, group);
      for (const id of ids) scene.objects.get(id).group = group.id;
      commit(scene, `group ${ids.length}`, { group: group.id });
      return ok({ group: { ...group } });
    },

    ungroup_objects(args = {}) {
      const group = scene.groups.get(args.group_id);
      if (!group) throw new Error(`No group "${args.group_id}"`);
      for (const id of group.children) {
        const object = scene.objects.get(id);
        if (object) object.group = null;
      }
      scene.groups.delete(group.id);
      commit(scene, 'ungroup', { group: group.id });
      return ok({ ungrouped: group.children });
    },

    /**
     * Real CSG. The operands are consumed and replaced by one solid result
     * unless `keep_operands` is set.
     */
    boolean_operation(args = {}) {
      const ids = args.ids || [...scene.selection];
      const operation = args.operation || 'union';
      if (ids.length < 2) throw new Error('boolean_operation needs at least two object ids');
      const objects = ids.map((id) => requireObject(scene, id));
      const meshes = objects.map(worldMesh);
      const { mesh: result, report } = booleanOperation(meshes, operation);
      if (!triangleCount(result)) {
        throw new Error(`boolean_operation "${operation}" produced an empty solid — the operands may not overlap`);
      }
      const first = objects[0];
      const merged = makeObject({
        id: args.result_id || nextId('csg'),
        name: args.name || `${operation} of ${objects.length}`,
        kind: 'csg',
        type: 'mesh',
        material: first.material,
        color: args.color || first.color,
        tags: ['csg', operation],
        baseMesh: result
      });
      // The result is admitted through the shared gate (uniqueness + budgets)
      // *before* the operands are removed, so an oversized or colliding result
      // fails loudly without corrupting the scene.
      insertObjects(scene, [merged]);
      if (!args.keep_operands) {
        for (const object of objects) purgeObject(scene, object.id);
      }
      scene.selection = new Set([merged.id]);
      commit(scene, `boolean ${operation}`, { result: merged.id, operands: ids });
      return ok({ object: describe(scene, merged), report, manifold: manifoldReport(result) });
    },

    undo(args = {}) { const r = undo(scene, args.steps || 1); return ok(r); },
    redo(args = {}) { const r = redo(scene, args.steps || 1); return ok(r); },

    inspect_scene(args = {}) {
      const objects = [...scene.objects.values()];
      const visible = objects.filter((o) => o.visible);
      const world = visible.length ? mergeMeshes(visible.map(worldMesh)) : mesh();
      const b = bounds(world);
      return ok({
        object_count: objects.length,
        group_count: scene.groups.size,
        triangles: triangleCount(world),
        scene_bounds: { min: b.min.map((n) => Number(n.toFixed(4))), max: b.max.map((n) => Number(n.toFixed(4))), size: b.size.map((n) => Number(n.toFixed(4))) },
        total_volume: Number(Math.abs(volume(world)).toFixed(6)),
        units: scene.units,
        selection: [...scene.selection],
        camera: { ...scene.camera },
        environment: scene.environment,
        history_index: scene.historyIndex,
        history_depth: scene.history.length,
        objects: objects.map((object) => describe(scene, object, Boolean(args.deep))),
        groups: [...scene.groups.values()].map((group) => ({ ...group }))
      });
    },

    inspect_object(args = {}) {
      const id = args.id || [...scene.selection][0];
      if (!id) throw new Error('inspect_object: no id and empty selection');
      return ok({ object: describe(scene, requireObject(scene, id), true) });
    },

    select_object(args = {}) {
      if (args.all) {
        scene.selection = new Set(scene.objects.keys());
      } else if (args.none || args.clear) {
        scene.selection = new Set();
      } else if (args.ids) {
        args.ids.forEach((id) => requireObject(scene, id));
        scene.selection = args.mode === 'add' ? new Set([...scene.selection, ...args.ids]) : new Set(args.ids);
      } else if (args.id) {
        requireObject(scene, args.id);
        scene.selection = args.mode === 'add' ? new Set([...scene.selection, args.id]) : new Set([args.id]);
      } else if (args.query || args.tag || args.type || args.material) {
        const matches = [...scene.objects.values()].filter((object) => {
          if (args.tag && !object.tags.includes(args.tag)) return false;
          if (args.type && object.type !== args.type) return false;
          if (args.material && object.material !== args.material) return false;
          if (args.query) {
            const q = String(args.query).toLowerCase();
            if (!object.name.toLowerCase().includes(q) && !object.tags.some((t) => t.includes(q)) && !object.id.includes(q)) return false;
          }
          return true;
        });
        scene.selection = new Set(matches.map((object) => object.id));
      } else if (args.ray) {
        const origin = asVec3(args.ray.origin, 'ray.origin');
        const direction = asVec3(args.ray.direction, 'ray.direction');
        let best = null;
        for (const object of scene.objects.values()) {
          const t = raycastMesh(worldMesh(object), origin, normalize(direction));
          if (t !== null && (!best || t < best.t)) best = { t, id: object.id };
        }
        scene.selection = best ? new Set([best.id]) : new Set();
        return ok({ selection: [...scene.selection], hit: best ? { id: best.id, distance: Number(best.t.toFixed(5)) } : null });
      } else {
        throw new Error('select_object: provide id, ids, query, tag, type, ray, all or none');
      }
      return ok({ selection: [...scene.selection], count: scene.selection.size });
    },

    /* -------------------------------------------- freeform + parametric */

    create_profile_solid(args = {}) {
      const method = args.method || 'extrude';
      let built;
      if (method === 'extrude') built = extrude(args.profile, asNumber(args.depth, 'depth', 1), args.options || {});
      else if (method === 'revolve') built = revolve(args.profile, args.segments ?? 24, asNumber(args.angle, 'angle', Math.PI * 2));
      else if (method === 'sweep') built = sweep(args.profile, args.path, Boolean(args.closed));
      else throw new Error(`create_profile_solid: unknown method "${method}"`);
      const object = makeObject({ ...args, kind: 'freeform', type: 'mesh', baseMesh: built, name: args.name || `${method} solid` });
      insertObjects(scene, [object]);
      scene.selection = new Set([object.id]);
      commit(scene, `${method} solid`, { id: object.id });
      return ok({ object: describe(scene, object, true) });
    },

    add_modifier(args = {}) {
      const id = args.id || [...scene.selection][0];
      const object = requireObject(scene, id);
      const type = args.modifier || args.type;
      if (!MODIFIER_NAMES.includes(type)) throw new Error(`Unknown modifier "${type}". Available: ${MODIFIER_NAMES.join(', ')}`);
      const entry = { id: nextId('mod'), type, options: args.options || {}, enabled: args.enabled !== false };
      if (args.index !== undefined) object.modifiers.splice(asNumber(args.index, 'index', 0) | 0, 0, entry);
      else object.modifiers.push(entry);
      const beforeTris = trianglesOf(object);
      invalidate(object);
      const afterTris = trianglesOf(object);
      if (scene.triangles - beforeTris + afterTris > scene.limits.max_triangles) {
        // Roll the edit back: the scene may never cross its triangle budget,
        // even through the modifier stack.
        object.modifiers = object.modifiers.filter((m) => m.id !== entry.id);
        invalidate(object);
        throw new Error(`Scene triangle budget would be exceeded by this modifier (${scene.triangles.toLocaleString()} + ${(afterTris - beforeTris).toLocaleString()} > ${scene.limits.max_triangles.toLocaleString()})`);
      }
      scene.triangles += afterTris - beforeTris;
      commit(scene, `modifier ${type}`, { id, modifier: type });
      return ok({ object: describe(scene, object), modifier: entry, triangles: afterTris });
    },

    remove_modifier(args = {}) {
      const object = requireObject(scene, args.id || [...scene.selection][0]);
      const before = object.modifiers.length;
      const beforeTris = trianglesOf(object);
      object.modifiers = object.modifiers.filter((m, i) => m.id !== args.modifier_id && i !== (args.index !== undefined ? asNumber(args.index, 'index') | 0 : -1));
      invalidate(object);
      scene.triangles += trianglesOf(object) - beforeTris;
      commit(scene, 'remove modifier', { id: object.id });
      return ok({ removed: before - object.modifiers.length, modifiers: object.modifiers.map((m) => m.type) });
    },

    reorder_modifiers(args = {}) {
      const object = requireObject(scene, args.id || [...scene.selection][0]);
      const order = args.order || [];
      const byId = new Map(object.modifiers.map((m) => [m.id, m]));
      const reordered = order.map((id) => byId.get(id)).filter(Boolean);
      if (reordered.length !== object.modifiers.length) throw new Error('reorder_modifiers: order must list every modifier id');
      const beforeTris = trianglesOf(object);
      object.modifiers = reordered;
      invalidate(object);
      scene.triangles += trianglesOf(object) - beforeTris;
      commit(scene, 'reorder modifiers', { id: object.id });
      return ok({ modifiers: object.modifiers.map((m) => m.type) });
    },

    define_graph(args = {}) {
      const validation = validateGraph(args.graph);
      if (!validation.valid) throw new Error(`define_graph: ${validation.errors.join('; ')}`);
      const id = args.id || nextId('graph');
      if (scene.graphs.has(id)) {
        // Redefinition silently changing geometry out from under objects that
        // reference the old graph is the same identity-overwrite bug as
        // objects, so it is refused — graph state is journaled and undoable.
        throw new Error(`Graph id "${id}" already exists — pick a new id (existing graphs stay live and can be re-evaluated)`);
      }
      scene.graphs.set(id, args.graph);
      commit(scene, 'define graph', { id });
      return ok({ graph_id: id, validation });
    },

    evaluate_graph(args = {}) {
      const graph = args.graph || scene.graphs.get(args.graph_id);
      if (!graph) throw new Error('evaluate_graph: provide graph or a known graph_id');
      const result = evaluateGraph(graph, args.parameters || {});
      if (args.instantiate === false) return ok({ stats: result.stats, trace: result.trace, parameters: result.parameters });
      const object = makeObject({
        ...args, kind: 'parametric', type: 'mesh',
        baseMesh: result.mesh, name: args.name || 'parametric solid',
        tags: ['parametric']
      });
      object.graph_id = args.graph_id || null;
      object.graph_parameters = result.parameters;
      insertObjects(scene, [object]);
      scene.selection = new Set([object.id]);
      commit(scene, 'evaluate graph', { id: object.id });
      return ok({ object: describe(scene, object), stats: result.stats, trace: result.trace, parameters: result.parameters });
    },

    /* -------------------------------------------------------- import/IO */

    import_mesh(args = {}) {
      const data = args.data ?? args.content;
      if (data === undefined) throw new Error('import_mesh: provide data (text or bytes)');
      // The parsers enforce the budget *while* decoding, so an oversized asset
      // is refused before it can exhaust memory — not after it is stored.
      const imported = importMesh(data, args.format || 'auto', {
        maxTriangles: Math.max(0, scene.limits.max_triangles - scene.triangles)
      });
      if (!triangleCount(imported)) throw new Error('import_mesh: file contained no triangles');
      let built = imported;
      if (args.normalize) {
        const b = bounds(built);
        const largest = Math.max(...b.size) || 1;
        const s = asNumber(args.target_size, 'target_size', 1) / largest;
        if (!(s > 0)) throw new Error('import_mesh: target_size must be a positive number');
        built = transformMesh(built, compose([-b.center[0] * s, -b.center[1] * s, -b.center[2] * s], [0, 0, 0], [s, s, s]));
      }
      const object = makeObject({ ...args, kind: 'imported', type: 'mesh', baseMesh: built, name: args.name || 'imported mesh' });
      insertObjects(scene, [object]);
      scene.selection = new Set([object.id]);
      commit(scene, 'import mesh', { id: object.id });
      return ok({ object: describe(scene, object, true), manifold: manifoldReport(built) });
    },

    export_scene(args = {}) {
      const ids = args.ids || (scene.selection.size && args.selection_only ? [...scene.selection] : [...scene.objects.keys()]);
      const meshes = ids.map((id) => worldMesh(requireObject(scene, id)));
      if (!meshes.length) throw new Error('export_scene: nothing to export');
      const combined = args.weld_solid
        ? meshes.reduce((acc, part) => booleanOperation([acc, part], 'union').mesh)
        : mergeMeshes(meshes);
      const format = args.format || 'stl';
      const { data, mime, binary } = exportMesh(combined, format, {
        name: args.name || 'orbit_scene',
        color: args.color || scene.objects.get(ids[0])?.color
      });
      return ok({
        format, mime, binary,
        byte_length: binary ? data.length : new TextEncoder().encode(data).length,
        triangles: triangleCount(combined),
        manifold: manifoldReport(combined),
        data: args.inline === false ? undefined : data
      });
    },

    list_capabilities() {
      return ok({
        primitives: [...PRIMITIVE_TYPES, 'rounded_box'],
        materials: MATERIALS,
        modifiers: MODIFIER_NAMES,
        boolean_operations: ['union', 'subtract', 'intersect', 'xor'],
        import_formats: SUPPORTED_IMPORT,
        export_formats: SUPPORTED_EXPORT,
        node_types: Object.fromEntries(Object.entries(NODE_TYPES).map(([k, v]) => [k, v.description])),
        physics_materials: Object.keys(MATERIAL_DENSITY),
        joint_types: JOINT_TYPES,
        profile_methods: ['extrude', 'revolve', 'sweep'],
        units: scene.units
      });
    },

    /* --------------------------------------------------------- physics */

    compute_mass_properties(args = {}) {
      const id = args.id || [...scene.selection][0];
      const object = requireObject(scene, id);
      return ok({ id, ...massProperties(worldMesh(object), args.material || 'abs', args.density) });
    },

    analyze_stability(args = {}) {
      const ids = args.ids || (args.id ? [args.id] : [...scene.objects.keys()]);
      if (!ids.length) throw new Error('analyze_stability: scene is empty');
      const combined = mergeMeshes(ids.map((id) => worldMesh(requireObject(scene, id))));
      return ok({ ids, ...stabilityAnalysis(combined, args.material || 'abs') });
    },

    check_collisions(args = {}) {
      const ids = args.ids || [...scene.objects.keys()];
      const pairs = [];
      for (let i = 0; i < ids.length; i += 1) {
        for (let j = i + 1; j < ids.length; j += 1) {
          const a = requireObject(scene, ids[i]);
          const b = requireObject(scene, ids[j]);
          const result = collide(worldMesh(a), worldMesh(b));
          if (result.colliding || (args.include_touching && result.phase !== 'broad')) {
            pairs.push({ a: a.id, b: b.id, ...result });
          }
        }
      }
      return ok({ checked: (ids.length * (ids.length - 1)) / 2, collisions: pairs, clean: pairs.length === 0 });
    },

    add_joint(args = {}) {
      const joint = {
        id: args.id || nextId('joint'),
        type: args.type || 'revolute',
        parent: args.parent,
        child: args.child,
        anchor: args.anchor !== undefined ? asVec3(args.anchor, 'anchor') : [0, 0, 0],
        axis: args.axis !== undefined ? asVec3(args.axis, 'axis') : [0, 1, 0],
        limits: args.limits !== undefined
          ? asVec2(args.limits, 'limits').map((n) => n).slice(0, 2)
          : null
      };
      if (joint.limits && (joint.limits[0] > joint.limits[1])) {
        throw new Error('add_joint: limits must be [min, max] with min ≤ max');
      }
      if (!JOINT_TYPES.includes(joint.type)) throw new Error(`Unknown joint type "${joint.type}"`);
      requireObject(scene, joint.parent);
      requireObject(scene, joint.child);
      if (scene.joints.has(joint.id)) {
        throw new Error(`Joint id "${joint.id}" already exists — pick a new id`);
      }
      scene.joints.set(joint.id, joint);
      commit(scene, `joint ${joint.type}`, { id: joint.id });
      return ok({ joint, mobility: mechanismMobility(scene.objects.size, [...scene.joints.values()]) });
    },

    simulate(args = {}) {
      const ids = args.ids || [...scene.objects.keys()];
      const bodies = ids.map((id) => {
        const object = requireObject(scene, id);
        return { id, mesh: worldMesh(object), position: object.transform.position, material: args.material || 'abs' };
      });
      const result = simulateDrop(bodies, args);
      if (args.apply) {
        for (const body of result.bodies) {
          const object = scene.objects.get(body.id);
          if (object) object.transform.position = body.rest_position;
        }
        commit(scene, 'simulate settle', { bodies: result.bodies.length });
      }
      return ok(result);
    },

    check_printability(args = {}) {
      const ids = args.ids || (args.id ? [args.id] : [...scene.objects.keys()]);
      const combined = mergeMeshes(ids.map((id) => worldMesh(requireObject(scene, id))));
      return ok({ ids, ...printabilityReport(combined, args) });
    },

    /* -------------------------------------------------------- validate */

    validate_scene(args = {}) {
      const objects = [...scene.objects.values()];
      const issues = [];
      for (const object of objects) {
        const world = worldMesh(object);
        const report = manifoldReport(world);
        if (!report.closed) issues.push({ severity: 'error', id: object.id, issue: 'not a closed solid', detail: report });
        if (!report.orientable) issues.push({ severity: 'error', id: object.id, issue: 'inconsistent winding' });
        if (Math.abs(volume(world)) < 1e-9) issues.push({ severity: 'error', id: object.id, issue: 'zero volume' });
        const b = bounds(world);
        if (args.ground_check !== false && b.min[1] < -1e-6) issues.push({ severity: 'warning', id: object.id, issue: 'below ground plane', detail: { min_y: b.min[1] } });
        if (object.transform.scale.some((s) => Math.abs(s) < 1e-3)) issues.push({ severity: 'warning', id: object.id, issue: 'near-degenerate scale' });
      }
      const collisions = api.check_collisions({ ids: objects.map((o) => o.id) });
      for (const pair of collisions.collisions) {
        issues.push({ severity: 'info', id: `${pair.a}+${pair.b}`, issue: 'interpenetrating solids', detail: { penetration: pair.penetration } });
      }
      const errors = issues.filter((i) => i.severity === 'error').length;
      return ok({
        valid: errors === 0,
        errors,
        warnings: issues.filter((i) => i.severity === 'warning').length,
        issues,
        objects: objects.length,
        triangles: objects.length ? triangleCount(mergeMeshes(objects.map(worldMesh))) : 0
      });
    },

    measure(args = {}) {
      if (args.between) {
        const [idA, idB] = args.between;
        const a = bounds(worldMesh(requireObject(scene, idA))).center;
        const b = bounds(worldMesh(requireObject(scene, idB))).center;
        return ok({ distance: Number(length(sub(a, b)).toFixed(6)), from: a, to: b });
      }
      const id = args.id || [...scene.selection][0];
      const world = worldMesh(requireObject(scene, id));
      const b = bounds(world);
      return ok({
        id,
        size: b.size.map((n) => Number(n.toFixed(6))),
        volume: Number(Math.abs(volume(world)).toFixed(6)),
        surface_area: Number(surfaceArea(world).toFixed(6)),
        centroid: centroid(world).map((n) => Number(n.toFixed(6))),
        triangles: triangleCount(world)
      });
    },

    /* ------------------------------------------------------- rendering */

    set_environment(args = {}) {
      const env = scene.environment;
      if (args.hdri) env.hdri = String(args.hdri);
      if (args.exposure !== undefined) env.exposure = Math.max(0, asNumber(args.exposure, 'exposure'));
      if (args.background) env.background = String(args.background);
      if (args.ambient_intensity !== undefined) env.ambient_intensity = Math.max(0, asNumber(args.ambient_intensity, 'ambient_intensity'));
      if (args.shadows !== undefined) env.shadows = Boolean(args.shadows);
      if (args.post) {
        const post = { ...env.post, ...args.post };
        for (const key of ['bloom', 'ssao', 'vignette']) {
          if (post[key] !== undefined) post[key] = Math.max(0, asNumber(post[key], `post.${key}`));
        }
        if (post.tonemap !== undefined && !['aces', 'linear', 'none'].includes(post.tonemap)) {
          throw new Error(`set_environment: unknown tonemap "${post.tonemap}" — use aces, linear or none`);
        }
        env.post = post;
      }
      commit(scene, 'environment', {});
      return ok({ environment: env });
    },

    get_history() {
      return ok({
        index: scene.historyIndex,
        depth: scene.history.length,
        entries: scene.history.map((entry, i) => ({ at: i, label: entry.label, detail: entry.detail, current: i === scene.historyIndex }))
      });
    },

    clear_scene() {
      const removed = scene.objects.size;
      scene.objects = new Map();
      scene.groups = new Map();
      scene.joints = new Map();
      scene.selection = new Set();
      scene.triangles = 0;
      commit(scene, 'clear scene', { removed });
      return ok({ removed });
    }
  };

  return api;
}

/* --------------------------------------------------- WebMCP tool schemas */

const vec3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };

export const TOOL_SCHEMAS = [
  { name: 'create_object', description: 'Create a solid primitive. Types: cube, sphere, icosphere, cylinder, cone, torus, plane, capsule, tube, prism, pyramid, wedge, rounded_box.', parameters: { type: { type: 'string' }, name: { type: 'string' }, position: vec3, rotation: vec3, scale: {}, material: { type: 'string' }, color: { type: 'string' }, params: { type: 'object' }, tags: { type: 'array' } } },
  { name: 'delete_object', description: 'Delete objects by id, ids, or the current selection.', parameters: { id: { type: 'string' }, ids: { type: 'array' } } },
  { name: 'duplicate_object', description: 'Duplicate objects with an optional positional offset.', parameters: { id: { type: 'string' }, ids: { type: 'array' }, offset: vec3 } },
  { name: 'move_object', description: 'Set absolute position, apply a delta, or drop to the ground plane.', parameters: { id: { type: 'string' }, ids: { type: 'array' }, position: vec3, delta: vec3, drop_to_ground: { type: 'boolean' } } },
  { name: 'rotate_object', description: 'Rotate in degrees (default) or radians, absolutely or by delta, or about a named axis.', parameters: { id: { type: 'string' }, rotation: vec3, delta: vec3, axis: { type: 'string' }, angle: { type: 'number' }, degrees: { type: 'boolean' } } },
  { name: 'scale_object', description: 'Uniform factor, per-axis vector, or a single-axis stretch.', parameters: { id: { type: 'string' }, factor: { type: 'number' }, scale: {}, axis: { type: 'string' }, amount: { type: 'number' } } },
  { name: 'set_material', description: 'Set material, colour, roughness, metalness and opacity.', parameters: { id: { type: 'string' }, ids: { type: 'array' }, material: { type: 'string' }, color: { type: 'string' }, roughness: { type: 'number' }, metalness: { type: 'number' }, opacity: { type: 'number' } } },
  { name: 'set_camera', description: 'Position the camera, frame the whole scene, jump to a named view preset, or switch projection (perspective/orthographic).', parameters: { position: vec3, target: vec3, up: vec3, fov: { type: 'number' }, near: { type: 'number' }, far: { type: 'number' }, projection: { type: 'string' }, preset: { type: 'string' }, frame_all: { type: 'boolean' }, direction: vec3 } },
  { name: 'group_objects', description: 'Group objects under a named parent for collective reasoning.', parameters: { ids: { type: 'array' }, name: { type: 'string' } } },
  { name: 'ungroup_objects', description: 'Dissolve a group, leaving its children in the scene.', parameters: { group_id: { type: 'string' } } },
  { name: 'boolean_operation', description: 'Exact CSG: union, subtract, intersect or xor over two or more solids. Returns a closed manifold result.', parameters: { ids: { type: 'array' }, operation: { type: 'string' }, keep_operands: { type: 'boolean' }, name: { type: 'string' } } },
  { name: 'undo', description: 'Step backwards through the mutation journal.', parameters: { steps: { type: 'number' } } },
  { name: 'redo', description: 'Step forwards after an undo.', parameters: { steps: { type: 'number' } } },
  { name: 'inspect_scene', description: 'Full scene read: objects, bounds, triangles, camera, environment, history.', parameters: { deep: { type: 'boolean' } } },
  { name: 'inspect_object', description: 'Deep read of one object including manifold report and nearest neighbours.', parameters: { id: { type: 'string' } } },
  { name: 'select_object', description: 'Select by id, ids, semantic query, tag, type, material, raycast, all or none.', parameters: { id: { type: 'string' }, ids: { type: 'array' }, query: { type: 'string' }, tag: { type: 'string' }, ray: { type: 'object' }, all: { type: 'boolean' }, none: { type: 'boolean' } } },
  { name: 'create_profile_solid', description: 'Freeform geometry: extrude, revolve or sweep a 2D profile into a closed solid. Supports bevel and twist.', parameters: { method: { type: 'string' }, profile: { type: 'array' }, depth: { type: 'number' }, path: { type: 'array' }, options: { type: 'object' } } },
  { name: 'add_modifier', description: 'Push a procedural modifier onto the object stack: array, mirror, twist, bend, taper, inflate, shell, smooth, subdivide, decimate, lattice, displace.', parameters: { id: { type: 'string' }, modifier: { type: 'string' }, options: { type: 'object' }, index: { type: 'number' } } },
  { name: 'remove_modifier', description: 'Remove a modifier from the stack by id or index.', parameters: { id: { type: 'string' }, modifier_id: { type: 'string' }, index: { type: 'number' } } },
  { name: 'reorder_modifiers', description: 'Reorder the non-destructive modifier stack.', parameters: { id: { type: 'string' }, order: { type: 'array' } } },
  { name: 'define_graph', description: 'Register a reusable parametric node graph and statically validate it.', parameters: { id: { type: 'string' }, graph: { type: 'object' } } },
  { name: 'evaluate_graph', description: 'Evaluate a parametric graph with parameter overrides and instantiate the result.', parameters: { graph_id: { type: 'string' }, graph: { type: 'object' }, parameters: { type: 'object' }, instantiate: { type: 'boolean' } } },
  { name: 'import_mesh', description: 'Import OBJ, STL (ascii/binary), PLY, glTF or GLB into the scene, optionally normalised to a target size.', parameters: { data: {}, format: { type: 'string' }, normalize: { type: 'boolean' }, target_size: { type: 'number' } } },
  { name: 'export_scene', description: 'Export to STL, ASCII STL, OBJ, PLY or glTF 2.0. Optionally weld everything into one solid first.', parameters: { format: { type: 'string' }, ids: { type: 'array' }, weld_solid: { type: 'boolean' }, selection_only: { type: 'boolean' } } },
  { name: 'list_capabilities', description: 'Enumerate every primitive, material, modifier, format, node type and joint the kernel supports.', parameters: {} },
  { name: 'compute_mass_properties', description: 'Exact volume, mass, centre of mass and inertia tensor for a chosen physical material.', parameters: { id: { type: 'string' }, material: { type: 'string' }, density: { type: 'number' } } },
  { name: 'analyze_stability', description: 'Support polygon, stability margin and tipping angle — will the design stand up?', parameters: { ids: { type: 'array' }, material: { type: 'string' } } },
  { name: 'check_collisions', description: 'Broad-phase AABB plus narrow-phase containment collision detection across the scene.', parameters: { ids: { type: 'array' }, include_touching: { type: 'boolean' } } },
  { name: 'add_joint', description: 'Add a mechanical joint (fixed, revolute, prismatic, spherical, planar) and report linkage mobility.', parameters: { type: { type: 'string' }, parent: { type: 'string' }, child: { type: 'string' }, axis: vec3, limits: { type: 'array' } } },
  { name: 'simulate', description: 'Deterministic rigid-body settle under gravity; optionally apply the resting positions.', parameters: { ids: { type: 'array' }, steps: { type: 'number' }, apply: { type: 'boolean' } } },
  { name: 'check_printability', description: 'Overhang ratio, layer count, wall thickness and support advice for additive manufacturing.', parameters: { ids: { type: 'array' }, nozzle: { type: 'number' }, layer_height: { type: 'number' } } },
  { name: 'validate_scene', description: 'Manifold, winding, volume, ground and interpenetration diagnostics with severities.', parameters: { ground_check: { type: 'boolean' } } },
  { name: 'measure', description: 'Measure one object or the distance between two.', parameters: { id: { type: 'string' }, between: { type: 'array' } } },
  { name: 'set_environment', description: 'HDRI, exposure, background, shadows and post-processing (bloom, SSAO, vignette, tonemap).', parameters: { hdri: { type: 'string' }, exposure: { type: 'number' }, post: { type: 'object' } } },
  { name: 'get_history', description: 'Read the full mutation journal with the current index.', parameters: {} },
  { name: 'clear_scene', description: 'Remove every object, group and joint.', parameters: {} }
];

export const TOOL_NAMES = TOOL_SCHEMAS.map((tool) => tool.name);

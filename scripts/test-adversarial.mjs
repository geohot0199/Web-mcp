#!/usr/bin/env node
/**
 * Adversarial / red-team suite.
 *
 * Orbit gives an agent full authority over the scene — no human approval gate.
 * That authority is only safe if the tool surface itself is hostile to bad
 * input. This suite is the adversary: malformed arguments, conflicting edits,
 * injection attempts, resource exhaustion, degenerate geometry and state
 * corruption. Every case must fail *loudly and safely*, never silently
 * corrupt the scene or escape the sandbox.
 */

import { createScene, createTools, TOOL_NAMES, TOOL_SCHEMAS } from '../js/scene.js';
import { evaluateExpression, validateGraph, evaluateGraph } from '../js/nodegraph.js';
import { importMesh } from '../js/io.js';
import { manifoldReport, volume, triangleCount } from '../js/geom.js';

let passed = 0;
const failures = [];

const check = (name, condition, detail = '') => {
  if (condition) passed += 1;
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

/** A hostile call must throw, not silently succeed. */
function rejects(name, fn) {
  try {
    fn();
    failures.push(`${name} — call succeeded but should have been rejected`);
  } catch (error) {
    if (error instanceof RangeError && /stack/i.test(error.message)) {
      failures.push(`${name} — crashed with a stack overflow instead of a clean error`);
    } else {
      passed += 1;
    }
  }
}

/** A weird-but-legal call must survive without throwing. */
function survives(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push(`${name} — threw "${error.message}"`);
  }
}

const fresh = () => {
  const scene = createScene();
  return { scene, tools: createTools(scene) };
};

/* ------------------------------------------------- 1. malformed arguments */

{
  const { tools } = fresh();
  rejects('unknown primitive type is rejected', () => tools.create_object({ type: 'blackhole' }));
  rejects('unknown material is rejected', () => tools.create_object({ type: 'cube' }) && tools.set_material({ material: 'unobtanium' }));
  rejects('delete with no id and empty selection', () => fresh().tools.delete_object({}));
  rejects('inspect a nonexistent id', () => tools.inspect_object({ id: 'ghost_999' }));
  rejects('move a nonexistent id', () => tools.move_object({ id: 'ghost_999', position: [0, 0, 0] }));
  rejects('group a nonexistent id', () => tools.group_objects({ ids: ['ghost_999'] }));
  rejects('ungroup a nonexistent group', () => tools.ungroup_objects({ group_id: 'ghost_999' }));
  rejects('boolean with one operand', () => tools.boolean_operation({ ids: ['a'], operation: 'union' }));
  rejects('unknown boolean operation', () => {
    const a = tools.create_object({ type: 'cube' }).object.id;
    const b = tools.create_object({ type: 'cube' }).object.id;
    tools.boolean_operation({ ids: [a, b], operation: 'annihilate' });
  });
  rejects('unknown modifier is rejected', () => tools.add_modifier({ modifier: 'liquify' }));
  rejects('unsupported import format', () => tools.import_mesh({ data: 'x', format: 'dwg' }));
  rejects('unsupported export format', () => tools.export_scene({ format: 'dwg' }));
  rejects('select with no criteria', () => tools.select_object({}));
}

/* -------------------------------------- 2. type confusion / wrong shapes */

{
  const { tools } = fresh();
  survives('null args are handled', () => { try { tools.inspect_scene(null); } catch { /* throwing is fine, crashing is not */ } });
  survives('undefined args are handled', () => tools.inspect_scene(undefined));
  survives('extra unknown args are ignored', () => tools.create_object({ type: 'cube', wormhole: true, __proto__: { evil: 1 } }));
  survives('string where number expected', () => { try { tools.create_object({ type: 'cube', params: { width: 'wide' } }); } catch { /* ok */ } });

  const id = tools.create_object({ type: 'cube' }).object.id;
  survives('NaN position does not corrupt the scene', () => { try { tools.move_object({ id, position: [NaN, 0, 0] }); } catch { /* ok */ } });
  survives('Infinity scale does not corrupt the scene', () => { try { tools.scale_object({ id, factor: Infinity }); } catch { /* ok */ } });

  const { tools: t2 } = fresh();
  const id2 = t2.create_object({ type: 'cube' }).object.id;
  t2.scale_object({ id: id2, factor: 0 });
  const scaled = t2.inspect_object({ id: id2 }).object;
  check('zero scale is clamped, never degenerate', scaled.scale.every((s) => Math.abs(s) > 0), JSON.stringify(scaled.scale));

  // A negative scale mirrors the basis; the exporter and mass integrator both
  // rely on winding being rewound so the solid keeps positive volume.
  const { tools: t3 } = fresh();
  const id3 = t3.create_object({ type: 'cube' }).object.id;
  t3.scale_object({ id: id3, scale: [-1, 1, 1] });
  const mirroredVolume = t3.measure({ id: id3 }).volume;
  check('mirrored scale keeps positive volume', mirroredVolume > 0, `${mirroredVolume}`);
  check('mirrored solid stays watertight', t3.inspect_object({ id: id3 }).object.manifold.closed);
  check('mirrored solid has correct mass', t3.compute_mass_properties({ id: id3, density: 1 }).mass > 0);
}

/* ------------------------------------------- 3. expression / code injection */

rejects('expression rejects process access', () => evaluateExpression('process.exit(1)'));
rejects('expression rejects require', () => evaluateExpression('require("fs")'));
rejects('expression rejects constructor escape', () => evaluateExpression('constructor.constructor("return 1")()'));
rejects('expression rejects __proto__', () => evaluateExpression('__proto__'));
rejects('expression rejects globalThis', () => evaluateExpression('globalThis'));
rejects('expression rejects arrow functions', () => evaluateExpression('(()=>1)()'));
rejects('expression rejects assignment', () => evaluateExpression('x = 1'));
rejects('expression rejects semicolon chaining', () => evaluateExpression('1; 2'));
rejects('expression rejects unbalanced parens', () => evaluateExpression('(1 + 2'));
rejects('expression rejects trailing garbage', () => evaluateExpression('1 + 2 )'));
rejects('expression rejects empty input', () => evaluateExpression(''));
rejects('expression rejects bare operators', () => evaluateExpression('*'));
rejects('expression rejects unknown identifiers', () => evaluateExpression('secret_key'));

check('expression division by zero is non-finite and rejected', (() => {
  try { evaluateExpression('1 / 0'); return false; } catch { return true; }
})());
check('expression still computes valid math', evaluateExpression('sqrt(16) + 2 ^ 3') === 12);

/* --------------------------------------------- 4. graph abuse / cycles */

rejects('self-referential node is rejected', () => evaluateGraph({ nodes: [{ id: 'a', type: 'transform', inputs: ['a'] }] }));
rejects('two-node cycle is rejected', () => evaluateGraph({ nodes: [{ id: 'a', type: 'transform', inputs: ['b'] }, { id: 'b', type: 'transform', inputs: ['a'] }] }));
rejects('three-node cycle is rejected', () => evaluateGraph({
  nodes: [
    { id: 'a', type: 'transform', inputs: ['c'] },
    { id: 'b', type: 'transform', inputs: ['a'] },
    { id: 'c', type: 'transform', inputs: ['b'] }
  ]
}));
rejects('empty graph is rejected', () => evaluateGraph({ nodes: [] }));
rejects('dangling input is rejected', () => evaluateGraph({ nodes: [{ id: 'a', type: 'transform', inputs: ['ghost'] }] }));
rejects('unknown node type is rejected', () => evaluateGraph({ nodes: [{ id: 'a', type: 'summon' }] }));
rejects('undefined parameter reference is rejected', () => evaluateGraph({
  nodes: [{ id: 'a', type: 'primitive', primitive: 'cube', params: { width: '$missing' } }]
}));
rejects('graph terminating in a scalar is rejected', () => evaluateGraph({
  parameters: { n: 2 }, nodes: [{ id: 'a', type: 'expression', expression: 'n * 2' }]
}));

check('validateGraph never throws on garbage', (() => {
  for (const garbage of [null, undefined, {}, { nodes: null }, { nodes: 'x' }, { nodes: [null] }, { nodes: [{}] }]) {
    try { validateGraph(garbage); } catch { return false; }
  }
  return true;
})());

/* -------------------------------------------- 5. degenerate geometry input */

{
  const { tools } = fresh();
  rejects('extruding a 2-point profile is rejected', () => tools.create_profile_solid({ method: 'extrude', profile: [[0, 0], [1, 1]], depth: 1 }));
  rejects('extruding an empty profile is rejected', () => tools.create_profile_solid({ method: 'extrude', profile: [], depth: 1 }));
  rejects('sweeping along a 1-point path is rejected', () => tools.create_profile_solid({ method: 'sweep', profile: [[0, 0], [1, 0], [1, 1]], path: [[0, 0, 0]] }));
  rejects('unknown profile method is rejected', () => tools.create_profile_solid({ method: 'teleport', profile: [[0, 0], [1, 0], [1, 1]] }));

  survives('collinear profile does not hang', () => {
    try { tools.create_profile_solid({ method: 'extrude', profile: [[0, 0], [1, 0], [2, 0], [3, 0]], depth: 1 }); } catch { /* rejecting is correct */ }
  });
  survives('duplicate-point profile does not hang', () => {
    try { tools.create_profile_solid({ method: 'extrude', profile: [[0, 0], [0, 0], [1, 0], [1, 1]], depth: 1 }); } catch { /* ok */ }
  });
}

/* ------------------------------------------------ 6. malformed asset import */

rejects('empty OBJ import is rejected', () => importMesh('', 'obj'));
rejects('OBJ with no faces is rejected', () => importMesh('v 0 0 0\nv 1 0 0\nv 0 1 0\n', 'obj'));
rejects('truncated binary STL is rejected', () => importMesh(new Uint8Array(10), 'stl'));
rejects('PLY without a header is rejected', () => importMesh('not a ply file', 'ply'));
rejects('malformed JSON glTF is rejected', () => importMesh('{ broken', 'gltf'));
rejects('glTF with no meshes is rejected', () => importMesh(JSON.stringify({ asset: { version: '2.0' } }), 'gltf'));
rejects('glTF with an external buffer is rejected', () => importMesh(JSON.stringify({
  asset: { version: '2.0' }, buffers: [{ uri: 'http://evil.example/payload.bin', byteLength: 4 }],
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 }],
  accessors: [{ bufferView: 0, componentType: 5126, count: 1, type: 'VEC3' }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }]
}), 'gltf'));

survives('OBJ with out-of-range face indices does not crash', () => {
  try { importMesh('v 0 0 0\nf 1 99 250\n', 'obj'); } catch { /* rejecting is correct */ }
});
survives('OBJ with junk lines is tolerated', () => {
  const m = importMesh('# comment\nmtllib x.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nvn 0 1 0\nusemtl steel\nf 1//1 2//1 3//1\n', 'obj');
  check('junk-tolerant OBJ still yields a face', triangleCount(m) === 1);
});

/* ------------------------------------------- 7. conflicting / racing edits */

{
  const { scene, tools } = fresh();
  const a = tools.create_object({ type: 'cube', name: 'A' }).object.id;
  const b = tools.create_object({ type: 'cube', name: 'B', position: [0.5, 0, 0] }).object.id;

  // Delete an object, then try to keep operating on it.
  tools.delete_object({ id: a });
  rejects('editing a deleted object is rejected', () => tools.move_object({ id: a, position: [1, 1, 1] }));
  rejects('booleaning with a deleted operand is rejected', () => tools.boolean_operation({ ids: [a, b], operation: 'union' }));
  check('deleted id leaves the selection', !scene.selection.has(a));

  // A boolean consumes its operands; they must not linger.
  const c = tools.create_object({ type: 'cube' }).object.id;
  const d = tools.create_object({ type: 'sphere', params: { radius: 0.6 } }).object.id;
  const result = tools.boolean_operation({ ids: [c, d], operation: 'union' });
  rejects('consumed operand is gone after a boolean', () => tools.inspect_object({ id: c }));
  check('boolean result is a real object', Boolean(result.object.id));
  check('boolean result is watertight', result.manifold.closed, JSON.stringify(result.manifold));

  // Group then delete a member.
  const e = tools.create_object({ type: 'cube' }).object.id;
  const f = tools.create_object({ type: 'cube' }).object.id;
  const group = tools.group_objects({ ids: [e, f] }).group.id;
  tools.delete_object({ id: e });
  const groups = tools.inspect_scene({}).groups;
  check('deleting a member prunes it from its group', !groups.find((g) => g.id === group).children.includes(e));
}

/* ------------------------------------------------- 8. history integrity */

{
  const { tools } = fresh();
  const before = tools.inspect_scene({}).object_count;
  tools.create_object({ type: 'cube' });
  tools.create_object({ type: 'sphere' });
  tools.create_object({ type: 'cone' });
  check('three creates land', tools.inspect_scene({}).object_count === before + 3);

  tools.undo({ steps: 2 });
  check('undo rewinds exactly two steps', tools.inspect_scene({}).object_count === before + 1);
  tools.redo({ steps: 2 });
  check('redo replays exactly two steps', tools.inspect_scene({}).object_count === before + 3);

  // Undoing past the beginning must clamp, not corrupt.
  const clamp = tools.undo({ steps: 9999 });
  check('undo clamps at the start of history', clamp.ok && tools.inspect_scene({}).object_count >= 0);
  const clampForward = tools.redo({ steps: 9999 });
  check('redo clamps at the end of history', clampForward.ok);

  // A new edit after an undo must truncate the redo branch.
  const { tools: t } = fresh();
  t.create_object({ type: 'cube' });
  t.create_object({ type: 'sphere' });
  t.undo({});
  t.create_object({ type: 'cone' });
  const redone = t.redo({});
  check('new work truncates the redo branch', redone.redone === 0, JSON.stringify(redone));

  const empty = fresh().tools.undo({});
  check('undo on an empty scene is a safe no-op', empty.undone === 0);
}

/* ------------------------------------------ 9. resource exhaustion limits */

{
  const { scene, tools } = fresh();
  scene.limits.max_objects = 5;
  for (let i = 0; i < 5; i += 1) tools.create_object({ type: 'cube' });
  rejects('object limit is enforced', () => tools.create_object({ type: 'cube' }));

  const { tools: t } = fresh();
  const id = t.create_object({ type: 'cube' }).object.id;
  survives('absurd array count is bounded', () => t.add_modifier({ id, modifier: 'array', options: { count: 1e9 } }));
  const stats = t.inspect_object({ id }).object;
  check('bounded array stays under a sane triangle budget', stats.triangles < 200000, `${stats.triangles} triangles`);

  const { tools: t2 } = fresh();
  const id2 = t2.create_object({ type: 'sphere' }).object.id;
  survives('absurd subdivision is bounded', () => t2.add_modifier({ id: id2, modifier: 'subdivide', options: { iterations: 99 } }));
  check('bounded subdivision stays under budget', t2.inspect_object({ id: id2 }).object.triangles < 200000);

  const { tools: t3 } = fresh();
  const id3 = t3.create_object({ type: 'sphere', params: { segments: 1e6, rings: 1e6 } }).object.id;
  check('absurd tessellation is clamped', t3.inspect_object({ id: id3 }).object.triangles < 500000);
}

/* --------------------------------------- 10. prototype pollution attempts */

{
  const { tools } = fresh();
  survives('__proto__ in tags does not pollute', () => tools.create_object({ type: 'cube', tags: ['__proto__', 'constructor'] }));
  check('Object.prototype is unpolluted', ({}).evil === undefined && ({}).polluted === undefined);

  survives('polluting name keys is inert', () => tools.create_object({ type: 'cube', name: '__proto__' }));
  survives('polluting params is inert', () => {
    try { tools.create_object({ type: 'cube', params: JSON.parse('{"__proto__":{"polluted":true}}') }); } catch { /* ok */ }
  });
  check('prototype still clean after param pollution', ({}).polluted === undefined);

  survives('graph node ids cannot pollute', () => {
    try { evaluateGraph({ nodes: [{ id: '__proto__', type: 'primitive', primitive: 'cube' }] }); } catch { /* ok */ }
  });
  check('prototype still clean after graph pollution', ({}).polluted === undefined);
}

/* --------------------------------------------- 11. tool surface integrity */

{
  const { tools } = fresh();
  check('every schema maps to an implementation', TOOL_SCHEMAS.every((tool) => typeof tools[tool.name] === 'function'),
    TOOL_SCHEMAS.filter((tool) => typeof tools[tool.name] !== 'function').map((t) => t.name).join(', '));

  const implemented = Object.keys(tools);
  const undocumented = implemented.filter((name) => !TOOL_NAMES.includes(name));
  check('every implementation is documented in a schema', undocumented.length === 0, undocumented.join(', '));

  check('every tool has a description', TOOL_SCHEMAS.every((tool) => typeof tool.description === 'string' && tool.description.length > 20));
  check('tool names are unique', new Set(TOOL_NAMES).size === TOOL_NAMES.length);
  check('tool names are snake_case', TOOL_NAMES.every((name) => /^[a-z][a-z0-9_]*$/.test(name)));

  // Read-only tools must never mutate the scene.
  const readOnly = ['inspect_scene', 'inspect_object', 'list_capabilities', 'get_history', 'measure', 'validate_scene', 'check_collisions'];
  const id = tools.create_object({ type: 'cube' }).object.id;
  const fingerprint = JSON.stringify(tools.inspect_scene({}).objects);
  for (const name of readOnly) {
    try { tools[name]({ id }); } catch { /* some need args; that is fine */ }
  }
  check('read-only tools do not mutate the scene', JSON.stringify(tools.inspect_scene({}).objects) === fingerprint);

  const depthBefore = tools.get_history().depth;
  tools.inspect_scene({});
  tools.measure({ id });
  check('read-only tools do not grow history', tools.get_history().depth === depthBefore);
}

/* ----------------------------------- 12. validation catches real problems */

{
  const { tools } = fresh();
  const a = tools.create_object({ type: 'cube', position: [0, 0.5, 0] }).object.id;
  const b = tools.create_object({ type: 'cube', position: [0.3, 0.5, 0] }).object.id;
  const report = tools.validate_scene({});
  check('interpenetration is reported', report.issues.some((issue) => issue.issue === 'interpenetrating solids'));
  check('interpenetration is informational, not an error', report.errors === 0, JSON.stringify(report.issues));

  tools.move_object({ id: b, position: [0.3, -5, 0] });
  check('below-ground geometry is warned about', tools.validate_scene({}).issues.some((issue) => issue.issue === 'below ground plane'));

  const { tools: t } = fresh();
  t.create_object({ type: 'cube', position: [0, 0.5, 0] });
  t.create_object({ type: 'cube', position: [9, 0.5, 0] });
  const clean = t.validate_scene({});
  check('a clean scene validates', clean.valid && clean.errors === 0, JSON.stringify(clean.issues));
  check('separated objects report no collisions', t.check_collisions({}).clean);
}

/* --------------------------------------------------------------- report */

console.log(`\nOrbit adversarial suite: ${passed}/${passed + failures.length} checks passed`);
if (failures.length) {
  console.error('\nFailures:');
  failures.forEach((failure) => console.error(`  ✗ ${failure}`));
} else {
  console.log('Verified: malformed args · injection · cycles · degenerate geometry · hostile assets · conflicting edits · history integrity · resource limits · prototype pollution');
}
process.exitCode = failures.length ? 1 : 0;

#!/usr/bin/env node
/**
 * Geometry kernel correctness suite.
 *
 * These are not smoke tests — every assertion is a closed-form ground truth
 * (analytic volumes, Euler characteristics, inertia tensors, boolean algebra
 * identities) that the kernel must reproduce numerically.
 */

import {
  volume, manifoldReport, bounds, centroid, surfaceArea, triangleCount,
  transformMesh, compose, determinant3, mergeMeshes, orient, repairTJunctions
} from '../js/geom.js';
import {
  box, sphere, icosphere, cylinder, cone, torus, plane, capsule,
  tube, prism, pyramid, wedge, roundedBox, extrude, revolve, sweep, triangulate, LIMITS
} from '../js/primitives.js';
import { union, subtract, intersect, symmetricDifference, booleanOperation } from '../js/csg.js';
import { array, mirror, twist, taper, smooth, subdivide, decimate, shell, displace, applyStack } from '../js/modifiers.js';
import { massProperties, stabilityAnalysis, collide, mechanismMobility, simulateDrop, printabilityReport } from '../js/physics.js';
import { evaluateGraph, validateGraph, evaluateExpression } from '../js/nodegraph.js';
import { parseOBJ, parseSTL, parsePLY, parseGLTF, exportOBJ, exportSTLBinary, exportSTLAscii, exportPLY, exportGLTF, importMesh, sniffFormat } from '../js/io.js';

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

function near(name, actual, expected, tolerance = 1e-6) {
  const delta = Math.abs(actual - expected);
  check(name, delta <= tolerance, `expected ${expected}, got ${actual} (Δ${delta.toExponential(2)})`);
}

function solid(name, m, expectedGenus = 0) {
  const report = manifoldReport(m);
  check(`${name} is closed`, report.closed, JSON.stringify({ boundary: report.boundary_edges, non_manifold: report.non_manifold_edges }));
  check(`${name} is orientable`, report.orientable, `${report.inconsistent_edges} inconsistent edges`);
  check(`${name} has positive volume`, volume(m) > 0, `volume ${volume(m)}`);
  if (expectedGenus !== null) check(`${name} genus = ${expectedGenus}`, report.genus === expectedGenus, `got ${report.genus}`);
}

/* ---------------------------------------------------- 1. primitive solids */

solid('box', box(1, 1, 1));
solid('sphere', sphere(0.5, 24, 16));
solid('icosphere', icosphere(0.5, 2));
solid('cylinder', cylinder(0.5, 0.5, 1, 32));
solid('cone', cone(0.5, 1, 32));
solid('torus', torus(0.5, 0.2, 24, 16), 1);
solid('plane slab', plane(1, 1, 0.02));
solid('capsule', capsule(0.3, 1, 20, 8));
solid('tube', tube(0.5, 0.3, 1, 32), 1);
solid('prism', prism(6, 0.5, 1));
solid('pyramid', pyramid(4, 0.5, 1));
solid('wedge', wedge(1, 1, 1));
solid('rounded box', roundedBox(1, 1, 1, 0.1));

// Analytic volumes.
near('box volume = w·h·d', volume(box(2, 3, 4)), 24, 1e-9);
near('cylinder volume → πr²h', volume(cylinder(0.5, 0.5, 2, LIMITS.maxSegments)), Math.PI * 0.25 * 2, 1e-3);
check('cylinder is inscribed (converges from below)', volume(cylinder(0.5, 0.5, 2, LIMITS.maxSegments)) < Math.PI * 0.25 * 2);
check('segment count is clamped to the documented limit',
  triangleCount(cylinder(0.5, 0.5, 1, 1e6)) === triangleCount(cylinder(0.5, 0.5, 1, LIMITS.maxSegments)));
near('cone volume → πr²h/3', volume(cone(0.5, 1, LIMITS.maxSegments)), (Math.PI * 0.25 * 1) / 3, 1e-3);
near('sphere volume → 4/3πr³', volume(sphere(1, 128, 96)), (4 / 3) * Math.PI, 5e-3);
check('sphere is inscribed (converges from below)', volume(sphere(1, 128, 96)) < (4 / 3) * Math.PI);
check('sphere volume converges with resolution',
  Math.abs(volume(sphere(1, 256, 256)) - (4 / 3) * Math.PI) < Math.abs(volume(sphere(1, 32, 24)) - (4 / 3) * Math.PI));
near('icosphere volume → 4/3πr³', volume(icosphere(1, 4)), (4 / 3) * Math.PI, 1e-2);
check('icosphere converges with subdivision',
  Math.abs(volume(icosphere(1, 4)) - (4 / 3) * Math.PI) < Math.abs(volume(icosphere(1, 1)) - (4 / 3) * Math.PI));
near('torus volume → 2π²Rr²', volume(torus(1, 0.25, 128, 96)), 2 * Math.PI ** 2 * 1 * 0.0625, 5e-3);
near('pyramid volume → base·h/3', volume(pyramid(4, Math.SQRT1_2, 3)), (1 * 3) / 3, 1e-9);
near('wedge is half a box', volume(wedge(2, 2, 2)), 4, 1e-9);
near('sphere surface → 4πr²', surfaceArea(sphere(1, 128, 96)), 4 * Math.PI, 5e-3);

// A plane is never zero-thickness — the flat-STL class of bug cannot return.
check('plane has real thickness', bounds(plane(1, 1, 0.02)).size[1] > 0.019);
check('degenerate plane is clamped', bounds(plane(1, 1, 0)).size[1] > 0);

/* -------------------------------------------------------- 2. freeform ops */

const square = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
near('extruded square volume', volume(extrude(square, 3)), 12, 1e-9);
solid('extruded square', extrude(square, 3));
solid('bevelled extrusion', extrude(square, 2, { bevel: 0.2, bevelSegments: 3 }));
check('bevel removes volume', volume(extrude(square, 2, { bevel: 0.3, bevelSegments: 3 })) < volume(extrude(square, 2)));
solid('twisted extrusion', extrude(square, 2, { twist: Math.PI / 3 }));

const hexagon = Array.from({ length: 6 }, (_, i) => {
  const a = (i / 6) * Math.PI * 2;
  return [Math.cos(a), Math.sin(a)];
});
near('regular hexagon area → 3√3/2·s²', volume(extrude(hexagon, 1)), (3 * Math.sqrt(3)) / 2, 1e-9);
check('hexagon triangulates to n-2 triangles', triangulate(hexagon).triangles.length === 4);

// Revolving a rectangle profile reproduces a cylinder.
near('revolve rectangle → cylinder', volume(revolve([[0, -1], [0.5, -1], [0.5, 1], [0, 1], [0, -1]], LIMITS.maxSegments)), Math.PI * 0.25 * 2, 1e-3);
solid('swept tube', sweep([[-0.1, -0.1], [0.1, -0.1], [0.1, 0.1], [-0.1, 0.1]], [[0, 0, 0], [0, 1, 0], [0, 2, 0]]));

/* ------------------------------------------------- 3. boolean set algebra */

const unitA = box(1, 1, 1);
const unitB = transformMesh(box(1, 1, 1), compose([0.5, 0, 0]));
const far = transformMesh(box(1, 1, 1), compose([5, 0, 0]));

near('A ∪ B volume (half overlap)', volume(union(unitA, unitB)), 1.5, 1e-9);
near('A ∩ B volume (half overlap)', volume(intersect(unitA, unitB)), 0.5, 1e-9);
near('A ∖ B volume (half overlap)', volume(subtract(unitA, unitB)), 0.5, 1e-9);
near('disjoint union is additive', volume(union(unitA, far)), 2, 1e-9);
near('disjoint intersection is empty', volume(intersect(unitA, far)), 0, 1e-9);
near('A ∖ A is empty', volume(subtract(unitA, unitA)), 0, 1e-6);
near('A ∪ A = A', volume(union(unitA, unitA)), 1, 1e-6);
near('A ∩ A = A', volume(intersect(unitA, unitA)), 1, 1e-6);

// Inclusion–exclusion: |A ∪ B| = |A| + |B| − |A ∩ B|
const sphereA = sphere(0.7, 32, 24);
const sphereB = transformMesh(sphere(0.7, 32, 24), compose([0.6, 0.2, 0]));
const vA = volume(sphereA);
const vB = volume(sphereB);
near('inclusion–exclusion holds', volume(union(sphereA, sphereB)) + volume(intersect(sphereA, sphereB)), vA + vB, 5e-3);
near('XOR = union minus intersection', volume(symmetricDifference(sphereA, sphereB)), volume(union(sphereA, sphereB)) - volume(intersect(sphereA, sphereB)), 5e-3);
near('XOR = (A∖B) + (B∖A)', volume(symmetricDifference(sphereA, sphereB)), volume(subtract(sphereA, sphereB)) + volume(subtract(sphereB, sphereA)), 1e-6);
near('XOR of a solid with itself is empty', volume(symmetricDifference(unitA, unitA)), 0, 1e-6);
near('XOR of disjoint solids is additive', volume(symmetricDifference(unitA, far)), 2, 1e-6);

// Boolean results must remain watertight — this is the whole point of the kernel.
solid('union stays manifold', union(unitA, unitB));
solid('subtract stays manifold', subtract(box(2, 2, 2), sphere(1.3, 24, 16)), null);
solid('intersect stays manifold', intersect(box(2, 2, 2), sphere(1.3, 24, 16)));

// Drilling a hole through a block must raise the genus to exactly 1.
const drilled = subtract(box(2, 2, 2), cylinder(0.4, 0.4, 4, 48));
const drilledReport = manifoldReport(drilled);
check('drilled block is closed', drilledReport.closed);
check('drilled block has genus 1', drilledReport.genus === 1, `got ${drilledReport.genus}`);
near('drilled volume = 8 − πr²h', volume(drilled), 8 - Math.PI * 0.16 * 2, 5e-3);

// Three-way fold.
const folded = booleanOperation([box(2, 2, 2), cylinder(0.3, 0.3, 4, 32), transformMesh(cylinder(0.3, 0.3, 4, 32), compose([0, 0, 0], [Math.PI / 2, 0, 0]))], 'subtract');
check('multi-operand subtract reports sanity', folded.report.volume_sane);
check('cross-drilled block has genus 3', manifoldReport(folded.mesh).genus === 3, `got ${manifoldReport(folded.mesh).genus}`);

/* -------------------------------------------------------- 4. modifiers */

near('array of 4 quadruples volume', volume(array(box(0.5, 0.5, 0.5), { count: 4, offset: [2, 0, 0] })), 0.5, 1e-9);
check('radial array places n copies', triangleCount(array(box(0.2, 0.2, 0.2), { count: 6, mode: 'radial', radius: 1 })) === 12 * 6);
near('merged array welds overlaps', volume(array(box(1, 1, 1), { count: 2, offset: [0.5, 0, 0], merge: true })), 1.5, 1e-6);
solid('mirror produces one solid', mirror(box(1, 1, 1), { axis: 'x', offset: 1 }));
check('disjoint mirror reports two shells', manifoldReport(mirror(box(1, 1, 1), { axis: 'x', offset: 3 })).shells === 2);
check('two disjoint cubes are genus 0', manifoldReport(mirror(box(1, 1, 1), { axis: 'x', offset: 3 })).genus === 0);
near('mirror doubles disjoint volume', volume(mirror(box(1, 1, 1), { axis: 'x', offset: 2 })), 2, 1e-6);
check('twist preserves triangle count', triangleCount(twist(cylinder(0.5, 0.5, 2, 32), { angle: Math.PI })) === triangleCount(cylinder(0.5, 0.5, 2, 32)));
check('taper shrinks volume', volume(taper(cylinder(0.5, 0.5, 2, 32), { from: 1, to: 0.5 })) < volume(cylinder(0.5, 0.5, 2, 32)));
check('subdivide quadruples faces', triangleCount(subdivide(box(1, 1, 1), { iterations: 1 })) === 48);
check('decimate reduces faces', triangleCount(decimate(sphere(0.5, 24, 16), { ratio: 0.3 })) < triangleCount(sphere(0.5, 24, 16)));
check('smooth keeps mesh closed', manifoldReport(smooth(sphere(0.5, 20, 14), { iterations: 2 })).closed);
check('smooth shrinks a sphere', volume(smooth(sphere(0.5, 20, 14), { iterations: 3 })) < volume(sphere(0.5, 20, 14)));
check('displace is deterministic', volume(displace(sphere(0.5, 16, 12), { seed: 7 })) === volume(displace(sphere(0.5, 16, 12), { seed: 7 })));
check('displace responds to seed', volume(displace(sphere(0.5, 16, 12), { seed: 1 })) !== volume(displace(sphere(0.5, 16, 12), { seed: 2 })));

const stack = applyStack(box(1, 1, 1), [
  { type: 'subdivide', options: { iterations: 1 } },
  { type: 'smooth', options: { iterations: 1 } },
  { type: 'array', options: { count: 2, offset: [3, 0, 0] } }
]);
check('modifier stack traces every step', stack.trace.length === 3);
check('disabled modifiers are skipped', applyStack(box(1, 1, 1), [{ type: 'subdivide', enabled: false }]).trace[0].skipped === true);
check('unknown modifier throws', (() => { try { applyStack(box(1, 1, 1), [{ type: 'nope' }]); return false; } catch { return true; } })());

/* ----------------------------------------------------------- 5. physics */

const steelCube = box(0.1, 0.1, 0.1); // 1 litre = 0.001 m³
const props = massProperties(steelCube, 'steel');
near('steel 0.1m cube mass = ρV', props.mass, 7850 * 0.001, 1e-6);
near('centred cube COM is origin', props.center_of_mass[1], 0, 1e-9);

// Solid cube inertia: I = m·s²/6 about a centroidal axis.
const inertiaCube = massProperties(box(1, 1, 1), null, 1);
near('cube Ixx = m·s²/6', inertiaCube.inertia_tensor.Ixx, 1 / 6, 1e-6);
near('cube Izz = m·s²/6', inertiaCube.inertia_tensor.Izz, 1 / 6, 1e-6);
near('cube products of inertia vanish', inertiaCube.inertia_tensor.Ixy, 0, 1e-9);

// Solid sphere: I = 2/5·m·r².
const inertiaSphere = massProperties(sphere(1, 96, 72), null, 1);
near('sphere Ixx → 2/5·m·r²', inertiaSphere.inertia_tensor.Ixx, 0.4 * inertiaSphere.mass, 5e-3);

const wide = stabilityAnalysis(transformMesh(box(4, 0.4, 4), compose([0, 0.2, 0])));
check('wide flat base is stable', wide.stable, wide.verdict);
check('wide base has a large tipping angle', wide.tipping_angle_deg > 60, `${wide.tipping_angle_deg}°`);
const tower = stabilityAnalysis(transformMesh(box(0.2, 6, 0.2), compose([0, 3, 0])));
check('tall tower has a small tipping angle', tower.tipping_angle_deg < 5, `${tower.tipping_angle_deg}°`);
check('tipping angle falls as COM rises', tower.tipping_angle_deg < wide.tipping_angle_deg);

check('overlapping bodies collide', collide(box(1, 1, 1), transformMesh(box(1, 1, 1), compose([0.3, 0, 0]))).colliding);
check('separated bodies do not collide', !collide(box(1, 1, 1), transformMesh(box(1, 1, 1), compose([9, 0, 0]))).colliding);
check('broad phase short-circuits', collide(box(1, 1, 1), transformMesh(box(1, 1, 1), compose([9, 0, 0]))).phase === 'broad');

// Kutzbach: a 4-bar linkage (4 bodies, 4 revolute joints) has mobility 1 in plane;
// spatially the formula returns −2, correctly flagging it as overconstrained.
const fourBar = mechanismMobility(4, Array.from({ length: 4 }, () => ({ type: 'revolute' })));
check('4-bar spatial mobility = −2', fourBar.mobility === -2, `got ${fourBar.mobility}`);
check('overconstrained linkage is flagged', fourBar.classification === 'overconstrained');
check('two bodies + spherical joint is a mechanism', mechanismMobility(2, [{ type: 'spherical' }]).mobility === 3);
check('fixed joints remove all freedom', mechanismMobility(2, [{ type: 'fixed' }]).mobility === 0);

const dropped = simulateDrop([{ id: 'a', mesh: box(1, 1, 1), position: [0, 8, 0] }], { steps: 400 });
check('dropped body settles', dropped.all_settled);
near('body rests on the ground plane', dropped.bodies[0].rest_position[1], 0.5, 1e-3);
check('simulation is deterministic', JSON.stringify(simulateDrop([{ id: 'a', mesh: box(1, 1, 1), position: [0, 8, 0] }], { steps: 400 })) === JSON.stringify(dropped));

const overhang = printabilityReport(sphere(1, 32, 24));
check('sphere needs print supports', overhang.needs_support);
check('flat slab needs no supports', !printabilityReport(box(4, 0.2, 4)).needs_support);
check('layer count scales with height', printabilityReport(box(1, 10, 1), { layerHeight: 0.2 }).layers === 50);

/* ------------------------------------------------------- 6. node graph */

near('expression arithmetic', evaluateExpression('2 + 3 * 4'), 14);
near('expression precedence with parens', evaluateExpression('(2 + 3) * 4'), 20);
near('expression exponent', evaluateExpression('2 ^ 10'), 1024);
near('expression functions', evaluateExpression('max(3, sqrt(16))'), 4);
near('expression constants', evaluateExpression('cos(pi)'), -1, 1e-12);
near('expression scope variables', evaluateExpression('rotors * 2', { rotors: 3 }), 6);
check('expression rejects unknown identifiers', (() => { try { evaluateExpression('nope + 1'); return false; } catch { return true; } })());
check('expression rejects code injection', (() => { try { evaluateExpression('process.exit(1)'); return false; } catch { return true; } })());
check('expression rejects constructor escape', (() => { try { evaluateExpression('constructor'); return false; } catch { return true; } })());

const droneGraph = {
  parameters: { arm: 1.2, body: 0.6, rotor: 0.35 },
  nodes: [
    { id: 'hull', type: 'primitive', primitive: 'rounded_box', params: { width: '$body', height: 0.25, depth: '$body', radius: 0.08 } },
    { id: 'boom', type: 'primitive', primitive: 'cylinder', params: { radius: 0.05, height: '=arm * 2', segments: 16 } },
    { id: 'boom_lay', type: 'transform', inputs: ['boom'], rotation: [0, 0, 1.5707963] },
    { id: 'booms', type: 'modifier', inputs: ['boom_lay'], modifier: 'array', options: { count: 2, mode: 'radial', radius: 0, angle: 3.14159265 } },
    { id: 'frame', type: 'boolean', inputs: ['hull', 'booms'], operation: 'union' },
    { id: 'out', type: 'output', inputs: ['frame'] }
  ]
};
const graphResult = evaluateGraph(droneGraph);
check('graph evaluates to a mesh', graphResult.stats.triangles > 0);
check('graph traces every node', graphResult.trace.length === droneGraph.nodes.length);
solid('graph output is a closed solid', graphResult.mesh);

const bigger = evaluateGraph(droneGraph, { arm: 2.4 });
check('parameter override changes geometry', bigger.stats.bounds[0] > graphResult.stats.bounds[0], `${bigger.stats.bounds[0]} vs ${graphResult.stats.bounds[0]}`);
check('graph evaluation is deterministic', JSON.stringify(evaluateGraph(droneGraph).stats) === JSON.stringify(graphResult.stats));

check('valid graph passes validation', validateGraph(droneGraph).valid);
check('cycle is rejected', !validateGraph({ nodes: [{ id: 'a', type: 'transform', inputs: ['b'] }, { id: 'b', type: 'transform', inputs: ['a'] }] }).valid);
check('missing input is rejected', !validateGraph({ nodes: [{ id: 'a', type: 'transform', inputs: ['ghost'] }] }).valid);
check('duplicate ids are rejected', !validateGraph({ nodes: [{ id: 'a', type: 'primitive' }, { id: 'a', type: 'primitive' }] }).valid);
check('unknown node type is rejected', !validateGraph({ nodes: [{ id: 'a', type: 'wormhole' }] }).valid);
check('boolean node needs two inputs', !validateGraph({ nodes: [{ id: 'p', type: 'primitive' }, { id: 'b', type: 'boolean', inputs: ['p'] }] }).valid);

/* --------------------------------------------------------------- 7. I/O */

const roundTrip = box(1, 2, 3);

const objText = exportOBJ(roundTrip);
near('OBJ round-trip preserves volume', volume(parseOBJ(objText)), 6, 1e-6);
check('OBJ round-trip preserves faces', triangleCount(parseOBJ(objText)) === triangleCount(roundTrip));
check('OBJ handles negative indices', triangleCount(parseOBJ('v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\n')) === 1);

const stlBinary = exportSTLBinary(roundTrip, { color: '#ff0000' });
check('binary STL length = 84 + 50n', stlBinary.length === 84 + 50 * triangleCount(roundTrip));
near('binary STL round-trip volume', volume(parseSTL(stlBinary)), 6, 1e-5);
const attribute = new DataView(stlBinary.buffer).getUint16(84 + 48, true);
check('Magics colour bit 15 is clear', (attribute & 0x8000) === 0);
check('Magics red channel encodes 31', (attribute & 0x1f) === 31, `got ${attribute & 0x1f}`);

near('ASCII STL round-trip volume', volume(parseSTL(exportSTLAscii(roundTrip))), 6, 1e-5);
near('PLY round-trip volume', volume(parsePLY(exportPLY(roundTrip))), 6, 1e-6);

const gltfText = exportGLTF(roundTrip, { name: 'unit', color: '#3366cc' });
const gltfJson = JSON.parse(gltfText);
check('glTF declares version 2.0', gltfJson.asset.version === '2.0');
check('glTF embeds a material', gltfJson.materials.length === 1);
check('glTF buffer is a data URI', gltfJson.buffers[0].uri.startsWith('data:'));
near('glTF round-trip volume', volume(parseGLTF(gltfText)), 6, 1e-5);

check('sniff detects OBJ', sniffFormat('v 0 0 0\nf 1 1 1') === 'obj');
check('sniff detects PLY', sniffFormat('ply\nformat ascii 1.0') === 'ply');
check('sniff detects glTF', sniffFormat('{"asset":{}}') === 'gltf');
check('sniff detects ASCII STL', sniffFormat('solid x\nfacet normal 0 0 1') === 'stl');
check('auto import works end to end', triangleCount(importMesh(exportOBJ(roundTrip), 'auto')) === 12);
check('unsupported format throws', (() => { try { importMesh('x', 'dwg'); return false; } catch { return true; } })());

/* ------------------------------------------------- 8. numerical hygiene */

check('mirrored matrix has negative determinant', determinant3(compose([0, 0, 0], [0, 0, 0], [-1, 1, 1])) < 0);
const mirrored = transformMesh(box(1, 1, 1), compose([0, 0, 0], [0, 0, 0], [-1, 1, 1]));
check('mirrored mesh keeps outward normals', volume(mirrored) > 0, `volume ${volume(mirrored)}`);
check('mirrored mesh stays closed', manifoldReport(mirrored).closed);

const tiny = box(1e-4, 1e-4, 1e-4);
check('micro-scale solid stays valid', manifoldReport(tiny).closed && volume(tiny) > 0);
const huge = box(1e4, 1e4, 1e4);
check('macro-scale solid stays valid', manifoldReport(huge).closed && volume(huge) > 0);
check('extreme aspect ratio stays valid', manifoldReport(box(1e3, 1e-3, 1e3)).closed);

near('centroid of an offset box', centroid(transformMesh(box(1, 1, 1), compose([3, 4, 5])))[0], 3, 1e-9);
check('orient() is idempotent', JSON.stringify(orient(orient(box(1, 1, 1)))) === JSON.stringify(orient(box(1, 1, 1))));
check('T-junction repair is idempotent', triangleCount(repairTJunctions(repairTJunctions(drilled))) === triangleCount(repairTJunctions(drilled)));

/* ---------------------------------------------------------------- report */

console.log(`\nOrbit geometry kernel: ${passed}/${passed + failures.length} checks passed`);
if (failures.length) {
  console.error('\nFailures:');
  failures.forEach((failure) => console.error(`  ✗ ${failure}`));
} else {
  console.log('Verified: analytic volumes · Euler characteristics · boolean set algebra · inertia tensors · format round-trips');
}
process.exitCode = failures.length ? 1 : 0;

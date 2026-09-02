/*
 * STL export verification.
 *
 * Guards the properties the studio cares about: the exported file is a real 3D solid,
 * never the flat 2D surfaces a naive mesh dump produces, overlapping forms are refused
 * instead of written as non-manifold intersections, both export flavours (colour /
 * plain solid) are written correctly, and procedural textures are baked into per-facet
 * colours.
 *
 * three.js is a dev dependency pinned to the version the browser loads from the CDN,
 * so `npm run check` fails loudly when it is missing (a green check must mean the
 * assertions actually ran). Environments that genuinely cannot install it may opt out
 * explicitly with `npm run test:stl:optional` — a flag the check path never uses.
 */
const optional = process.argv.includes('--optional');
let THREE;
try {
  THREE = await import('three');
} catch (error) {
  if (optional) {
    console.log('· skipped (--optional): three is not installed, so the STL export checks did not run');
    process.exit(0);
  }
  console.error('✗ three could not be imported — the STL export checks did not run.');
  console.error('  three is a dev dependency (same version the browser loads from the CDN):');
  console.error('  run `npm install` before `npm run check` / `npm run test:stl`.');
  console.error(`  (${error.message})`);
  process.exit(1);
}

const {
  MIN_SOLID_THICKNESS,
  PLANE_THICKNESS,
  SOLID_EXPORT_COLOR,
  buildBinarySTL,
  collectExportTriangles,
  detectFormIntersections,
  subdivideForTexture,
  trianglesBounds
} = await import('../js/stl-export.js');

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`✓ ${name}`);
  } else {
    failures += 1;
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function mesh(geometry, { position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1], color = '#808080' } = {}) {
  const item = new THREE.Mesh(geometry);
  item.position.set(...position);
  item.rotation.set(...rotation);
  item.scale.set(...scale);
  item.userData.exportColor = color;
  return item;
}

function named(name, item) {
  item.name = name;
  return item;
}

/* A raw plane is exactly the 2D case that used to leak into exports. */
const flatGroup = new THREE.Group();
flatGroup.add(mesh(new THREE.PlaneGeometry(1, 1), { rotation: [-Math.PI / 2, 0, 0] }));
const flat = collectExportTriangles(flatGroup);
check('raw plane is detected as flat (not a 3D body)', trianglesBounds(flat.triangles).flat);

/* The export pipeline thickens it into a solid slab instead. */
const solidGroup = new THREE.Group();
solidGroup.add(mesh(new THREE.BoxGeometry(1, 1, PLANE_THICKNESS), { rotation: [-Math.PI / 2, 0, 0], color: '#d94040' }));
solidGroup.add(mesh(new THREE.SphereGeometry(0.5, 24, 16), { position: [0, 1, 0], color: '#3868d0' }));
const solid = collectExportTriangles(solidGroup);
const bounds = trianglesBounds(solid.triangles);
check('thickened plane + sphere export as a 3D body', !bounds.flat, `bounds ${bounds.size.join(' × ')}`);
check('no zero-area facets are written', solid.triangles.every((t) => t.normal.length() > 0.99));
check('every axis has real depth', bounds.size.every((value) => value >= MIN_SOLID_THICKNESS));

/* A collapsed scale axis must not produce a flat sheet either. */
const squashedGroup = new THREE.Group();
squashedGroup.add(mesh(new THREE.BoxGeometry(1, 1, 1), { scale: [1, MIN_SOLID_THICKNESS, 1] }));
check('clamped scale keeps a printable thickness', !trianglesBounds(collectExportTriangles(squashedGroup).triangles).flat);

/* Mirrored transforms must stay outward facing. */
const mirroredGroup = new THREE.Group();
mirroredGroup.add(mesh(new THREE.BoxGeometry(1, 1, 1), { scale: [-1, 1, 1] }));
const mirrored = collectExportTriangles(mirroredGroup);
const outward = mirrored.triangles.filter((t) => {
  const centroid = t.a.clone().add(t.b).add(t.c).divideScalar(3);
  return centroid.dot(t.normal) > 0;
});
check('mirrored geometry keeps outward normals', outward.length === mirrored.triangles.length);

/* Overlapping forms must be refused, not written as intersecting facets. */
function intersectionPairs(entries) {
  const group = new THREE.Group();
  entries.forEach((entry) => group.add(entry));
  return detectFormIntersections(collectExportTriangles(group));
}

const unitBox = () => new THREE.BoxGeometry(1, 1, 1);

check('disjoint forms never report an intersection',
  intersectionPairs([
    named('Cube A', mesh(unitBox(), { position: [0, 0, 0] })),
    named('Cube B', mesh(unitBox(), { position: [4, 0, 0] }))
  ]).length === 0);

check('exactly touching forms (stacked) are allowed to export',
  intersectionPairs([
    named('Base', mesh(unitBox(), { position: [0, 0, 0] })),
    named('Top', mesh(unitBox(), { position: [0, 1, 0] }))
  ]).length === 0);

check('exactly touching forms (butt joint) are allowed to export',
  intersectionPairs([
    named('Left', mesh(unitBox(), { position: [-0.5, 0, 0] })),
    named('Right', mesh(unitBox(), { position: [0.5, 0, 0] }))
  ]).length === 0);

/* 0.64 units is the studio's default placement spread — unit forms overlap at it. */
const overlapping = intersectionPairs([
  named('Cube A', mesh(unitBox(), { position: [0, 0, 0] })),
  named('Cube B', mesh(unitBox(), { position: [0.64, 0, 0] }))
]);
check('face-aligned overlapping forms are detected (default spread)', overlapping.length === 1, JSON.stringify(overlapping));
check('detection names the overlapping forms',
  overlapping[0]?.a === 'Cube A' && overlapping[0]?.b === 'Cube B', JSON.stringify(overlapping));

check('a form fully embedded inside another is detected',
  intersectionPairs([
    named('Shell', mesh(unitBox(), { position: [0, 0, 0] })),
    named('Core', mesh(new THREE.SphereGeometry(0.25, 16, 12), { position: [0, 0, 0] }))
  ]).length === 1);

check('transversal crossings (beam through beam) are detected',
  intersectionPairs([
    named('Beam X', mesh(new THREE.BoxGeometry(3, 0.2, 0.2), { position: [0, 0, 0] })),
    named('Beam Y', mesh(new THREE.BoxGeometry(0.2, 3, 0.2), { position: [0, 0.3, 0] }))
  ]).length === 1);

check('diagonal neighbours with touching bounding boxes stay allowed',
  intersectionPairs([
    named('Cube A', mesh(unitBox(), { position: [0, 0, 0] })),
    named('Cube B', mesh(unitBox(), { position: [1, 1, 0] }))
  ]).length === 0);

/* Texture baking: subdivision keeps facets small in UV space, sampling reaches facets. */
const texturedGeometry = subdivideForTexture(new THREE.BoxGeometry(1, 1, 1));
const texturedPosition = texturedGeometry.getAttribute('position');
const texturedUv = texturedGeometry.getAttribute('uv');
check('textured exports subdivide coarse facets for sampling', texturedPosition.count > 12, `${texturedPosition.count} vertices`);
let worstUvArea = 0;
for (let i = 0; i < texturedPosition.count; i += 3) {
  const u0 = texturedUv.getX(i), v0 = texturedUv.getY(i);
  const u1 = texturedUv.getX(i + 1), v1 = texturedUv.getY(i + 1);
  const u2 = texturedUv.getX(i + 2), v2 = texturedUv.getY(i + 2);
  worstUvArea = Math.max(worstUvArea, Math.abs((u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0)) / 2);
}
check('sub-facets cover small UV patches (samples resolve the pattern)', worstUvArea <= 1 / 128 + 1e-9, `max ${worstUvArea.toFixed(4)}`);
const subdividedBounds = trianglesBounds(collectExportTriangles(new THREE.Mesh(texturedGeometry, undefined)).triangles);
check('subdivision preserves the solid shape exactly',
  subdividedBounds.size.every((value, index) => Math.abs(value - [1, 1, 1][index]) < 1e-6),
  `bounds ${subdividedBounds.size.join(' × ')}`);

const bakedGroup = new THREE.Group();
const bakedMesh = new THREE.Mesh(texturedGeometry);
bakedMesh.userData.exportColorAt = (u) => (u < 0.5 ? { r: 255, g: 0, b: 0 } : { r: 0, g: 0, b: 255 });
bakedGroup.add(bakedMesh);
const baked = collectExportTriangles(bakedGroup);
const redFacets = baked.triangles.filter((t) => t.color.r === 255).length;
const blueFacets = baked.triangles.filter((t) => t.color.b === 255).length;
check('per-facet texture sampling reaches every facet', redFacets + blueFacets === baked.triangles.length);
check('sampled texture colours actually vary per facet', redFacets > 0 && blueFacets > 0, `${redFacets} red / ${blueFacets} blue`);

const bakedBinary = buildBinarySTL(baked.triangles, { mode: 'color' });
const bakedView = new DataView(bakedBinary.buffer);
const bakedAttributes = new Set();
for (let i = 0; i < baked.triangles.length; i += 1) bakedAttributes.add(bakedView.getUint16(84 + i * 50 + 48, true));
check('sampled texture colours round-trip through the STL attributes',
  bakedAttributes.has(31) && bakedAttributes.has(31 << 10), // 5-bit pure red and pure blue
  [...bakedAttributes].join(', '));

/* A throwing sampler falls back to the base colour instead of breaking the export. */
const brokenSamplerGroup = new THREE.Group();
const brokenSamplerMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
brokenSamplerMesh.userData.exportColor = '#d94040';
brokenSamplerMesh.userData.exportColorAt = () => { throw new Error('no canvas here'); };
brokenSamplerGroup.add(brokenSamplerMesh);
const brokenSampler = collectExportTriangles(brokenSamplerGroup);
check('a failing texture sampler falls back to the base colour',
  brokenSampler.triangles.length > 0 && brokenSampler.triangles.every((t) => t.color.r === 0xd9));

/* Binary layout + colour attributes. */
const colored = buildBinarySTL(solid.triangles, { mode: 'color' });
const plain = buildBinarySTL(solid.triangles, { mode: 'solid', solidColor: SOLID_EXPORT_COLOR });
const view = new DataView(colored.buffer);
const header = new TextDecoder().decode(new Uint8Array(colored.buffer, 0, 80));

check('binary size matches the facet count', colored.buffer.byteLength === 84 + solid.triangles.length * 50);
check('facet count header is correct', view.getUint32(80, true) === solid.triangles.length);
check('header never starts with "solid"', !header.trimStart().toLowerCase().startsWith('solid'));
check('colour export carries a COLOR= header', header.includes('COLOR='));
check('colour header names the Magics convention', header.includes('Magics'));

const firstAttribute = view.getUint16(84 + 48, true);
const plainAttribute = new DataView(plain.buffer).getUint16(84 + 48, true);
check('colour export writes Magics per-facet attributes (bit 15 clear)',
  firstAttribute !== 0 && (firstAttribute & 0x8000) === 0);
check('colour attributes keep red in the low bits (Magics order)', (firstAttribute & 0x1f) >= (firstAttribute >> 10) & 0x1f);
check('solid export writes a plain, attribute-free STL', plainAttribute === 0);

/* Decode a facet colour back and confirm it matches its mesh. */
const red5 = firstAttribute & 0x1f;
check('per-facet red channel round-trips', Math.abs(red5 / 31 - 0xd9 / 255) < 0.05, `got ${red5}`);

console.log(failures ? `\n${failures} check(s) failed` : '\nAll STL export checks passed');
process.exit(failures ? 1 : 0);

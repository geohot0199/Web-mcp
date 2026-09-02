/*
 * STL export verification.
 *
 * Guards the property the studio cares about: the exported file is a real 3D solid,
 * never the flat 2D surfaces a naive mesh dump produces, and both export flavours
 * (colour / solid grey) are written correctly.
 *
 * three.js is loaded from the CDN in the browser, so it is not a runtime dependency
 * here. If it is not installed locally the script skips instead of failing.
 */
let THREE;
try {
  THREE = await import('three');
} catch (_) {
  console.log('· skipped: install three locally (npm i three@0.164.0) to run the STL export checks');
  process.exit(0);
}

const {
  MIN_SOLID_THICKNESS,
  PLANE_THICKNESS,
  SOLID_EXPORT_COLOR,
  buildBinarySTL,
  collectExportTriangles,
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

/* Binary layout + colour attributes. */
const colored = buildBinarySTL(solid.triangles, { mode: 'color' });
const plain = buildBinarySTL(solid.triangles, { mode: 'solid', solidColor: SOLID_EXPORT_COLOR });
const view = new DataView(colored.buffer);
const header = new TextDecoder().decode(new Uint8Array(colored.buffer, 0, 80));

check('binary size matches the facet count', colored.buffer.byteLength === 84 + solid.triangles.length * 50);
check('facet count header is correct', view.getUint32(80, true) === solid.triangles.length);
check('header never starts with "solid"', !header.trimStart().toLowerCase().startsWith('solid'));
check('colour export carries a COLOR= header', header.includes('COLOR='));

const firstAttribute = view.getUint16(84 + 48, true);
const plainAttribute = new DataView(plain.buffer).getUint16(84 + 48, true);
check('colour export writes per-facet colour attributes', firstAttribute !== 0 && (firstAttribute & 0x8000) === 0);
check('solid export writes a plain, attribute-free STL', plainAttribute === 0);

/* Decode a facet colour back and confirm it matches its mesh. */
const red5 = firstAttribute & 0x1f;
check('per-facet red channel round-trips', Math.abs(red5 / 31 - 0xd9 / 255) < 0.05, `got ${red5}`);

console.log(failures ? `\n${failures} check(s) failed` : '\nAll STL export checks passed');
process.exit(failures ? 1 : 0);

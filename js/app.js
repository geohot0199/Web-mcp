/*
 * Orbit browser shell.
 *
 * The shell is deliberately a *viewer*, not an editor. It renders whatever the
 * agent-owned scene kernel contains and streams the tool-call log. There are
 * no approval cards, no permission toggles, no proposal staging and no
 * human-authored mutations — the human watches, the agent builds.
 *
 * Everything geometric happens in the framework-free kernel; Three.js is used
 * purely to draw the mesh arrays it produces.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createOrbitServer, registerOrbit } from './webmcp.js';
import { worldMesh } from './scene.js';

/* ------------------------------------------------------------- kernel */

const server = createOrbitServer();
const bridges = registerOrbit(server, window);
const { scene: kernel } = server;

/* ------------------------------------------------------------- three */

const viewportEl = document.getElementById('viewport');
let renderer = null;
let camera = null;
let controls = null;
let webglAvailable = true;

const view = new THREE.Scene();
view.background = new THREE.Color('#0d0d0d');

const group = new THREE.Group();
view.add(group);

const grid = new THREE.GridHelper(20, 20, 0x2e2e2e, 0x1b1b1b);
grid.material.transparent = true;
grid.material.opacity = 0.55;
view.add(grid);

const hemi = new THREE.HemisphereLight(0xffffff, 0x101014, 0.55);
view.add(hemi);
const key = new THREE.DirectionalLight(0xffffff, 2.1);
key.position.set(5, 8, 6);
view.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.35);
fill.position.set(-6, 3, -4);
view.add(fill);
const rim = new THREE.DirectionalLight(0xffffff, 0.8);
rim.position.set(0, 2, -8);
view.add(rim);

try {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  viewportEl.appendChild(renderer.domElement);

  camera = new THREE.PerspectiveCamera(45, 1, 0.05, 1000);
  camera.position.set(4, 3, 6);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
} catch {
  webglAvailable = false;
  viewportEl.innerHTML = '<div class="viewport-fallback"><p>WebGL is unavailable in this browser.</p>'
    + '<p>The kernel and all tools still work — drive them via <code>window.orbit.call()</code>.</p></div>';
}

function resize() {
  if (!renderer || !camera) return;
  const { clientWidth: w, clientHeight: h } = viewportEl;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

/* --------------------------------------------------------- materials */

const MATERIAL_PRESETS = {
  metal: { roughness: 0.21, metalness: 0.92 },
  plastic: { roughness: 0.62, metalness: 0.04 },
  glass: { roughness: 0.05, metalness: 0.02, transparent: true, opacity: 0.32 },
  wood: { roughness: 0.85, metalness: 0.02 },
  emissive: { roughness: 0.3, metalness: 0.1, emissiveIntensity: 0.8 },
  rubber: { roughness: 0.95, metalness: 0.0 },
  ceramic: { roughness: 0.35, metalness: 0.0 },
  carbon: { roughness: 0.45, metalness: 0.3 }
};

let wireframe = false;

function materialFor(object) {
  const preset = MATERIAL_PRESETS[object.material] || MATERIAL_PRESETS.plastic;
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(object.color || '#c8c8c8'),
    roughness: object.roughness ?? preset.roughness,
    metalness: object.metalness ?? preset.metalness,
    transparent: Boolean(preset.transparent) || (object.opacity ?? 1) < 1,
    opacity: object.opacity ?? preset.opacity ?? 1,
    wireframe,
    side: THREE.DoubleSide,
    flatShading: false
  });
  if (object.material === 'emissive') {
    material.emissive = new THREE.Color(object.color || '#c8c8c8');
    material.emissiveIntensity = preset.emissiveIntensity;
  }
  return material;
}

/* ------------------------------------------------------------ render */

let dirty = true;
const markDirty = () => { dirty = true; };

function rebuildViewport() {
  while (group.children.length) {
    const child = group.children.pop();
    child.geometry?.dispose();
    child.material?.dispose();
  }

  for (const object of kernel.objects.values()) {
    if (!object.visible) continue;
    let world;
    try { world = worldMesh(object); } catch { continue; }
    if (!world.indices.length) continue;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(world.vertices, 3));
    geometry.setIndex(world.indices);
    geometry.computeVertexNormals();

    const mesh = new THREE.Mesh(geometry, materialFor(object));
    mesh.userData.id = object.id;
    group.add(mesh);

    if (kernel.selection.has(object.id)) {
      const outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry, 25),
        new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 })
      );
      outline.userData.id = object.id;
      group.add(outline);
    }
  }
}

function makeCamera(projection) {
  return projection === 'orthographic'
    ? new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 1000)
    : new THREE.PerspectiveCamera(45, 1, 0.05, 1000);
}

function syncCamera() {
  if (!camera || !controls) return;
  const c = kernel.camera;
  const wantOrtho = c.projection === 'orthographic';
  // Swap the projection kind while preserving the current placement.
  if (wantOrtho !== Boolean(camera.isOrthographicCamera)) {
    const next = makeCamera(c.projection);
    next.position.set(...c.position);
    camera = next;
    controls.object = camera;
  }
  camera.position.set(...c.position);
  controls.target.set(...c.target);
  camera.near = c.near ?? camera.near;
  camera.far = c.far ?? camera.far;
  if (Array.isArray(c.up)) camera.up.set(...c.up);
  if (camera.isOrthographicCamera) {
    // The kernel's fov doubles as the frustum size at the current distance,
    // so framing behaves the same way in both projections.
    const distance = Math.max(0.1, camera.position.distanceTo(controls.target));
    const halfHeight = Math.tan(((c.fov || 45) / 2) * (Math.PI / 180)) * distance;
    camera.left = -halfHeight * camera.aspect;
    camera.right = halfHeight * camera.aspect;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
  } else {
    camera.fov = c.fov;
  }
  camera.updateProjectionMatrix();
  controls.update();
}

let lastCameraSignature = '';

/**
 * The environment tool is not a no-op: background, exposure, ambient level,
 * shadows and the post chain are read here and applied to the renderer every
 * time the kernel state changes.
 */
function syncEnvironment() {
  const env = kernel.environment;
  if (view) {
    try { view.background = new THREE.Color(env.background || '#0d0d0d'); } catch { /* bad colour string */ }
  }
  if (renderer) {
    renderer.toneMappingExposure = env.exposure ?? 1;
    const tonemap = env.post?.tonemap || 'aces';
    renderer.toneMapping = tonemap === 'none' ? THREE.NoToneMapping
      : tonemap === 'linear' ? THREE.LinearToneMapping
        : THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = Boolean(env.shadows);
  }
  if (hemi) hemi.intensity = (env.ambient_intensity ?? 0.35) * 1.6;
  const vignette = document.querySelector('.viewport-vignette');
  if (vignette) vignette.style.opacity = String(Math.min(1, Math.max(0, env.post?.vignette ?? 0.15)));
}

function tick() {
  requestAnimationFrame(tick);

  // The panels, scene graph and call stream must keep updating even with no
  // WebGL context — only the 3D draw is optional. Returning early here would
  // freeze the entire UI on machines without hardware acceleration.
  if (dirty) {
    dirty = false;
    if (webglAvailable) {
      rebuildViewport();
      syncEnvironment();
    }
    renderUI();
  }

  if (!renderer || !camera) return;

  const signature = JSON.stringify([
    kernel.camera.position, kernel.camera.target, kernel.camera.up,
    kernel.camera.fov, kernel.camera.near, kernel.camera.far, kernel.camera.projection
  ]);
  if (signature !== lastCameraSignature) {
    lastCameraSignature = signature;
    syncCamera();
  }
  controls?.update();
  renderer.render(view, camera);
}

/* ---------------------------------------------------------------- UI */

const el = (id) => document.getElementById(id);
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let callCount = 0;

function renderUI() {
  const objects = [...kernel.objects.values()];
  let triangles = 0;
  const rows = objects.map((object) => {
    let count = 0;
    try { count = worldMesh(object).indices.length / 3; } catch { /* unbuildable */ }
    triangles += count;
    const selected = kernel.selection.has(object.id);
    return `<button class="row${selected ? ' is-selected' : ''}" data-id="${escape(object.id)}">
      <span class="row-swatch" style="background:${escape(object.color)}"></span>
      <span class="row-main">
        <span class="row-name">${escape(object.name)}</span>
        <span class="row-meta">${escape(object.type)} · ${object.material} · ${count.toLocaleString()} tris</span>
      </span>
      ${object.modifiers.length ? `<span class="row-tag">${object.modifiers.length}m</span>` : ''}
    </button>`;
  });

  el('object-list').innerHTML = rows.length ? rows.join('') : '<p class="empty">No objects. An agent has not created anything yet.</p>';
  el('stat-objects').textContent = objects.length.toLocaleString();
  el('stat-tris').textContent = Math.round(triangles).toLocaleString();
  el('selection-count').textContent = `${kernel.selection.size} selected`;

  const selectedId = [...kernel.selection][0];
  if (selectedId && kernel.objects.has(selectedId)) {
    const detail = server.call('inspect_object', { id: selectedId });
    el('object-detail').innerHTML = detail.ok ? detailMarkup(detail.object) : '<p class="empty">Unavailable.</p>';
  } else {
    el('object-detail').innerHTML = '<p class="empty">Nothing selected.</p>';
  }

  const stats = server.call('inspect_scene', {});
  if (stats.ok) {
    const s = stats.scene_bounds.size;
    el('readout-bounds').textContent = objects.length
      ? `${s[0].toFixed(2)} × ${s[1].toFixed(2)} × ${s[2].toFixed(2)} ${kernel.units} · vol ${stats.total_volume.toFixed(3)}`
      : '—';
  }

  for (const button of el('object-list').querySelectorAll('.row')) {
    button.addEventListener('click', () => {
      server.call('select_object', { id: button.dataset.id });
      markDirty();
    });
  }
}

function detailMarkup(object) {
  const rows = [
    ['id', object.id],
    ['type', object.type],
    ['kind', object.kind],
    ['position', object.position.join(', ')],
    ['rotation', object.rotation.map((r) => `${((r * 180) / Math.PI).toFixed(1)}°`).join(', ')],
    ['scale', object.scale.join(', ')],
    ['material', `${object.material} · r${(object.roughness ?? 0).toFixed(2)} · m${(object.metalness ?? 0).toFixed(2)}`],
    ['size', object.world_bounds.size.join(' × ')],
    ['volume', object.volume],
    ['surface', object.surface_area],
    ['triangles', object.triangles.toLocaleString()],
    ['vertices', object.vertices.toLocaleString()],
    ['watertight', object.manifold.closed ? 'yes' : 'no'],
    ['genus', object.manifold.genus ?? '—'],
    ['modifiers', object.modifiers.length ? object.modifiers.join(' → ') : 'none']
  ];
  return `<dl class="kv">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${escape(v)}</dd></div>`).join('')}</dl>`;
}

/* -------------------------------------------------------- call stream */

const logEl = () => el('call-log');

server.subscribe((event) => {
  callCount += 1;
  el('stat-calls').textContent = callCount.toLocaleString();

  const failed = event.type === 'error' || event.result?.ok === false;
  const entry = document.createElement('div');
  entry.className = `call${failed ? ' is-error' : ''}`;
  const args = JSON.stringify(event.args ?? {});
  entry.innerHTML = `
    <div class="call-head">
      <code>${escape(event.tool)}</code>
      <span class="call-ms">${event.ms}ms</span>
    </div>
    <div class="call-args">${escape(args.length > 160 ? `${args.slice(0, 160)}…` : args)}</div>
    ${failed ? `<div class="call-error">${escape(event.result?.error || 'failed')}${event.result?.hint ? `<br><em>${escape(event.result.hint)}</em>` : ''}</div>` : ''}
  `;

  const container = logEl();
  if (container.querySelector('.empty')) container.innerHTML = '';
  container.prepend(entry);
  while (container.children.length > 120) container.lastChild.remove();

  if (!/^(inspect_|list_|get_|measure)/.test(event.tool)) markDirty();
});

/* --------------------------------------------------------- controls */

for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => {
    const preset = button.dataset.view;
    server.call('set_camera', preset === 'frame' ? { frame_all: true } : { preset });
    markDirty();
  });
}

el('toggle-grid').addEventListener('click', (event) => {
  grid.visible = !grid.visible;
  event.currentTarget.classList.toggle('is-on', grid.visible);
});

el('toggle-wire').addEventListener('click', (event) => {
  wireframe = !wireframe;
  event.currentTarget.classList.toggle('is-on', wireframe);
  markDirty();
});

el('clear-log').addEventListener('click', () => {
  logEl().innerHTML = '<p class="empty">Cleared.</p>';
});

function runConsole() {
  const input = el('console-input');
  const raw = input.value.trim();
  if (!raw) return;
  const space = raw.indexOf(' ');
  const tool = space < 0 ? raw : raw.slice(0, space);
  const argText = space < 0 ? '' : raw.slice(space + 1).trim();
  let args = {};
  if (argText) {
    try {
      args = JSON.parse(argText);
    } catch (error) {
      el('status-message').textContent = `Invalid JSON arguments: ${error.message}`;
      return;
    }
  }
  const result = server.call(tool, args);
  el('status-message').textContent = result.ok === false
    ? `${tool} failed — ${result.error}`
    : `${tool} ok`;
  input.value = '';
  markDirty();
}

el('console-run').addEventListener('click', runConsole);
el('console-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') runConsole();
});

const QUICK = [
  ['cube', 'create_object {"type":"cube","material":"metal"}'],
  ['sphere', 'create_object {"type":"sphere","material":"plastic","color":"#e5e5e5"}'],
  ['torus', 'create_object {"type":"torus","material":"metal"}'],
  ['union', 'boolean_operation {"operation":"union"}'],
  ['subtract', 'boolean_operation {"operation":"subtract"}'],
  ['validate', 'validate_scene {}'],
  ['capabilities', 'list_capabilities {}'],
  ['undo', 'undo {}'],
  ['clear', 'clear_scene {}']
];
el('console-quick').innerHTML = QUICK.map(([label, command]) =>
  `<button data-cmd="${escape(command)}">${escape(label)}</button>`).join('');
for (const button of el('console-quick').querySelectorAll('button')) {
  button.addEventListener('click', () => {
    el('console-input').value = button.dataset.cmd;
    runConsole();
  });
}

/* ---------------------------------------------------------- picking */

if (renderer && camera) {
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  renderer.domElement.addEventListener('pointerdown', (event) => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(group.children.filter((c) => c.isMesh), false)[0];
    server.call('select_object', hit ? { id: hit.object.userData.id } : { none: true });
    markDirty();
  });
}

/* ------------------------------------------------------------- boot */

el('bridge-label').textContent = `${bridges.length} bridge${bridges.length === 1 ? '' : 's'} · ${bridges.join(' · ')}`;
el('status-tools').textContent = `${server.toolNames().length} tools`;
el('status-message').innerHTML = 'Orbit kernel ready — <code>window.orbit.call(tool, args)</code>';

// A tiny opening scene so the viewport is never an empty void. This is the one
// place the shell touches the kernel, and it goes through the tool surface like
// any agent would.
server.batch([
  { tool: 'create_object', args: { type: 'rounded_box', name: 'Chassis', position: [0, 0.5, 0], params: { width: 2.4, height: 0.5, depth: 1.6, radius: 0.14 }, material: 'metal', color: '#d6d6d6' } },
  { tool: 'create_object', args: { type: 'cylinder', name: 'Hub', position: [0, 1.05, 0], params: { radius: 0.42, height: 0.6, segments: 48 }, material: 'metal', color: '#ffffff' } },
  { tool: 'create_object', args: { type: 'torus', name: 'Ring', position: [0, 1.05, 0], rotation: [Math.PI / 2, 0, 0], params: { radius: 1.05, tube: 0.07, radial_segments: 64, tubular_segments: 20 }, material: 'metal', color: '#9a9a9a' } },
  { tool: 'set_camera', args: { frame_all: true } }
]);

resize();
markDirty();
tick();

// Keep the viewport honest when the kernel is driven from outside this module
// (an agent over WebMCP, the console, or postMessage) rather than through the
// subscribe() hook. Declared before use: a `let` read inside the interval body
// would sit in the temporal dead zone if the timer ever fired first.
let lastSignature = '';
setInterval(() => {
  const signature = `${kernel.objects.size}:${kernel.historyIndex}:${[...kernel.selection].join(',')}|${JSON.stringify(kernel.environment)}`;
  if (signature !== lastSignature) {
    lastSignature = signature;
    markDirty();
  }
}, 250);

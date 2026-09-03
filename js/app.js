/*
 * Orbit browser shell.
 *
 * The shell is deliberately a *viewer*, not an editor. It renders whatever the
 * agent-owned scene kernel contains and streams the tool-call log. There are
 * no approval cards, no permission toggles, no proposal staging and no
 * human-authored mutations — the human watches, the agent builds.
 *
 * Layout: the console (tool-call stream, scene graph, tiny invocation line)
 * lives in a narrow left column; the live canvas owns everything else, with a
 * fading ground grid, world X/Y/Z axes and a small corner orientation gizmo.
 *
 * Everything geometric happens in the framework-free kernel; Three.js is used
 * purely to draw the mesh arrays it produces.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createOrbitServer, registerOrbit } from './webmcp.js';
import { worldMesh } from './scene.js';
import {
  createGroundGrid, createWorldAxes, createGroundShadow, gizmoDirections,
  paletteForBackground, DECOR_PALETTES
} from './viewport-decor.js';

/* ------------------------------------------------------------- kernel */

const server = createOrbitServer();
const bridges = registerOrbit(server, window);
const { scene: kernel } = server;

/* Read-only kernel queries for the panels go straight at the tool table so
 * the shell's own refreshes never masquerade as agent traffic in the stream. */
const peek = (name, args) => {
  try { return server.tools[name](args || {}); } catch { return { ok: false }; }
};

/* --------------------------------------------------------------- dom */

const el = (id) => document.getElementById(id);
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* -------------------------------------------------------------- theme */

const THEME_KEY = 'orbit.theme';
const KERNEL_DEFAULT_BACKGROUND = '#0d0d0d';

/** Background the agent asked for explicitly, if any — overrides the theme. */
let agentBackground = null;
let theme = 'light';

function readStoredTheme() {
  try { return localStorage.getItem(THEME_KEY); } catch { return null; }
}
function writeStoredTheme(value) {
  try { localStorage.setItem(THEME_KEY, value); } catch { /* private mode */ }
}

/** The colour the canvas clears to: agent's choice first, theme second. */
function effectiveBackground() {
  return agentBackground || (theme === 'dark' ? '#0d0d0d' : '#f7f7f7');
}

/** Overlay palette that stays legible on whatever the canvas background is. */
function effectivePalette() {
  return agentBackground
    ? paletteForBackground(agentBackground, theme)
    : DECOR_PALETTES[theme];
}

/* ------------------------------------------------------------- three */

const viewportEl = document.getElementById('viewport');
let renderer = null;
let camera = null;
let controls = null;
let webglAvailable = true;

const view = new THREE.Scene();
view.background = new THREE.Color(effectiveBackground());

const group = new THREE.Group();
view.add(group);

/* the 3D-space furniture: grid, world axes, contact shadow */
const grid = createGroundGrid({ size: 24, step: 0.25, majorEvery: 4 });
grid.position.y = 0.0016; // a hair above the shadow catcher, no z-fighting
view.add(grid);

const axes = createWorldAxes({ length: 2.1, labelScale: 0.2 });
axes.position.y = 0.0016;
view.add(axes);

const groundShadow = createGroundShadow({ size: 60 });
view.add(groundShadow);

const hemi = new THREE.HemisphereLight(0xffffff, 0x8f8f8f, 0.62);
view.add(hemi);
const key = new THREE.DirectionalLight(0xffffff, 2.15);
key.position.set(5, 8, 6);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 0.5;
key.shadow.camera.far = 40;
key.shadow.camera.left = -9;
key.shadow.camera.right = 9;
key.shadow.camera.top = 9;
key.shadow.camera.bottom = -9;
key.shadow.bias = -0.0006;
key.shadow.normalBias = 0.02;
view.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.4);
fill.position.set(-6, 3, -4);
view.add(fill);
const rim = new THREE.DirectionalLight(0xffffff, 0.75);
rim.position.set(0, 2, -8);
view.add(rim);

/**
 * A greyscale studio environment: a vertical ramp with two soft boxes baked
 * into a tiny equirect canvas, then convolved by PMREM. Metals have no diffuse
 * term at all, so without something to reflect they read as black cut-outs —
 * this is what makes chrome look like chrome, in strictly black and white.
 */
function studioEnvironment(rendererRef) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const ramp = ctx.createLinearGradient(0, 0, 0, 128);
  ramp.addColorStop(0, '#ffffff');
  ramp.addColorStop(0.42, '#dedede');
  ramp.addColorStop(0.52, '#a3a3a3');
  ramp.addColorStop(1, '#3f3f3f');
  ctx.fillStyle = ramp;
  ctx.fillRect(0, 0, 256, 128);
  // two softboxes, one broad and one narrow, for readable speculars
  for (const [cx, cy, rx, ry, alpha] of [[70, 34, 46, 26, 0.95], [196, 44, 26, 18, 0.7]]) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(rx, ry);
    const box = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    box.addColorStop(0, `rgba(255,255,255,${alpha})`);
    box.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = box;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  const source = new THREE.CanvasTexture(canvas);
  source.mapping = THREE.EquirectangularReflectionMapping;
  source.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(rendererRef);
  const envMap = pmrem.fromEquirectangular(source).texture;
  source.dispose();
  pmrem.dispose();
  return envMap;
}

try {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  viewportEl.appendChild(renderer.domElement);

  try { view.environment = studioEnvironment(renderer); } catch { /* env map is a nicety */ }

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
// The canvas has to follow the left panel collapsing, not just the window.
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => resize()).observe(viewportEl);
}

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
    flatShading: false,
    envMapIntensity: 0.95
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

/** Objects that appeared in the last refresh get a one-shot outline flash. */
const spawned = new Map(); // id → performance.now()
let knownIds = new Set();
const SPAWN_FLASH_MS = 620;

function trackSpawns(objects) {
  const now = performance.now();
  const next = new Set();
  for (const object of objects) {
    next.add(object.id);
    if (!knownIds.has(object.id)) spawned.set(object.id, now);
  }
  for (const id of [...spawned.keys()]) {
    if (!next.has(id)) spawned.delete(id);
  }
  knownIds = next;
}

function rebuildViewport() {
  while (group.children.length) {
    const child = group.children.pop();
    child.geometry?.dispose();
    child.material?.dispose();
  }

  const palette = effectivePalette();
  const objects = [...kernel.objects.values()];
  trackSpawns(objects);

  for (const object of objects) {
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
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);

    if (kernel.selection.has(object.id)) {
      const outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry, 25),
        new THREE.LineBasicMaterial({ color: new THREE.Color(palette.selection), transparent: true, opacity: 0.85, toneMapped: false })
      );
      outline.userData.id = object.id;
      group.add(outline);
    }

    const bornAt = spawned.get(object.id);
    if (bornAt !== undefined) {
      const flash = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry, 1),
        new THREE.LineBasicMaterial({
          color: new THREE.Color(palette.selection), transparent: true,
          opacity: 0.9, depthTest: false, toneMapped: false
        })
      );
      flash.renderOrder = 800;
      flash.userData.flashFor = object.id;
      group.add(flash);
    }
  }
}

/** Fade the spawn outlines out; drops them once they are gone. */
function updateSpawnFlashes(now) {
  if (!spawned.size || !group.children.length) return;
  for (const child of group.children) {
    const id = child.userData?.flashFor;
    if (!id) continue;
    const bornAt = spawned.get(id);
    const age = bornAt === undefined ? Infinity : Math.max(0, now - bornAt);
    if (age >= SPAWN_FLASH_MS) {
      spawned.delete(id);
      child.material.opacity = 0;
      child.visible = false;
    } else {
      child.material.opacity = 0.9 * (1 - age / SPAWN_FLASH_MS) ** 1.6;
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
    next.up.copy(camera.up);
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
const cameraSignature = () => JSON.stringify([
  kernel.camera.position, kernel.camera.target, kernel.camera.up,
  kernel.camera.fov, kernel.camera.near, kernel.camera.far, kernel.camera.projection
]);

let lastDecorSignature = '';

/**
 * Recolour the canvas background and every overlay (grid, axes, labels,
 * contact shadow, selection outlines) for the current theme — but only when
 * something actually changed, because the axis labels are canvas textures and
 * re-baking them on every tool call would be silly.
 */
function syncDecor() {
  const background = effectiveBackground();
  const signature = `${background}|${theme}|${agentBackground || ''}`;
  if (signature === lastDecorSignature) return false;
  lastDecorSignature = signature;

  const palette = effectivePalette();
  try { view.background.set(background); } catch { /* bad colour string */ }
  grid.userData.recolor(palette);
  axes.userData.recolor(palette);
  groundShadow.userData.recolor(palette);
  hemi.groundColor.set(palette.hemisphereGround);
  return true;
}

function syncEnvironment() {
  const env = kernel.environment;
  const explicit = env.background && env.background !== KERNEL_DEFAULT_BACKGROUND
    ? String(env.background)
    : null;
  if (explicit) agentBackground = explicit;

  syncDecor();

  if (renderer) {
    renderer.toneMappingExposure = env.exposure ?? 1;
    const tonemap = env.post?.tonemap || 'aces';
    renderer.toneMapping = tonemap === 'none' ? THREE.NoToneMapping
      : tonemap === 'linear' ? THREE.LinearToneMapping
        : THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = Boolean(env.shadows);
  }
  if (hemi) hemi.intensity = (env.ambient_intensity ?? 0.35) * 1.7;
  const vignette = document.querySelector('.viewport-vignette');
  if (vignette) {
    vignette.style.opacity = String(Math.min(1, Math.max(0, (env.post?.vignette ?? 0.15) * 2 + 0.45)));
  }
}

/* ---------------------------------------------------- camera motion */

/** Normalised timeline position, pinned to 0…1 whatever the clock says. */
const clamp01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t);

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2);
const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - (2 ** (-9 * t)));

const cameraTween = {
  active: false,
  start: 0,
  duration: 640,
  ease: easeInOutCubic,
  fromPosition: new THREE.Vector3(),
  toPosition: new THREE.Vector3(),
  fromTarget: new THREE.Vector3(),
  toTarget: new THREE.Vector3()
};

function tweenCamera(toPosition, toTarget, duration = 640, ease = easeInOutCubic) {
  if (!camera || !controls) return;
  cameraTween.fromPosition.copy(camera.position);
  cameraTween.fromTarget.copy(controls.target);
  cameraTween.toPosition.copy(toPosition);
  cameraTween.toTarget.copy(toTarget);
  cameraTween.duration = Math.max(1, duration);
  cameraTween.ease = ease;
  cameraTween.start = performance.now();
  cameraTween.active = true;
}

function updateCameraTween(now) {
  if (!cameraTween.active || !camera || !controls) return;
  const k = clamp01((now - cameraTween.start) / cameraTween.duration);
  const eased = cameraTween.ease(k);
  camera.position.lerpVectors(cameraTween.fromPosition, cameraTween.toPosition, eased);
  controls.target.lerpVectors(cameraTween.fromTarget, cameraTween.toTarget, eased);
  if (k >= 1) cameraTween.active = false;
}

/** Opening dolly: the scene settles into frame instead of appearing. */
const intro = { active: false, start: 0, duration: 1300 };

function updateIntro(now) {
  if (!intro.active) return;
  const k = clamp01((now - intro.start) / intro.duration);
  group.scale.setScalar(0.955 + 0.045 * easeOutExpo(k));
  if (k >= 1) {
    intro.active = false;
    group.scale.setScalar(1);
  }
}

/**
 * Ask the kernel for a new camera, then fly there. The kernel stays the source
 * of truth (an agent reading `inspect_scene` mid-flight sees the destination),
 * the shell just animates the trip.
 */
function gotoView(args, duration = 640) {
  if (!camera || !controls) return server.call('set_camera', args);
  const fromPosition = camera.position.clone();
  const fromTarget = controls.target.clone();
  const result = server.call('set_camera', args);
  if (result.ok === false) return result;
  lastCameraSignature = cameraSignature();
  syncCamera(); // projection, fov, up, near/far — the position is ours now
  camera.position.copy(fromPosition);
  controls.target.copy(fromTarget);
  tweenCamera(
    new THREE.Vector3(...kernel.camera.position),
    new THREE.Vector3(...kernel.camera.target),
    duration
  );
  return result;
}

/* ------------------------------------------------------- axis gizmo */

const gizmoEl = el('axis-gizmo');
const gizmoNodes = gizmoEl ? {
  pos: Object.fromEntries(['x', 'y', 'z'].map((axis) => {
    const node = gizmoEl.querySelector(`[data-axis="${axis}"]`);
    return [axis, {
      group: node,
      line: node?.querySelector('line'),
      knob: node?.querySelector('.gizmo-knob'),
      text: node?.querySelector('text')
    }];
  })),
  neg: Object.fromEntries(['x', 'y', 'z'].map((axis) => [axis, gizmoEl.querySelector(`[data-neg="${axis}"]`)]))
} : null;

const GIZMO_RADIUS = 30;

/** Keep the corner indicator locked to the live camera, every frame. */
function updateGizmo() {
  if (!gizmoNodes || !camera || !axes.visible) return;
  for (const entry of gizmoDirections(camera)) {
    const node = gizmoNodes.pos[entry.axis];
    const neg = gizmoNodes.neg[entry.axis];
    if (!node) continue;
    const x = (entry.x * GIZMO_RADIUS).toFixed(2);
    const y = (entry.y * GIZMO_RADIUS).toFixed(2);
    node.line.setAttribute('x1', '0');
    node.line.setAttribute('y1', '0');
    node.line.setAttribute('x2', x);
    node.line.setAttribute('y2', y);
    node.knob.setAttribute('cx', x);
    node.knob.setAttribute('cy', y);
    node.text.setAttribute('x', x);
    node.text.setAttribute('y', y);
    // depth: +1 facing the viewer, -1 pointing away
    const facing = (entry.depth + 1) / 2;
    node.group.style.opacity = (0.35 + 0.65 * facing).toFixed(3);
    node.line.style.strokeWidth = (1.2 + 0.9 * facing).toFixed(2);
    if (neg) {
      neg.setAttribute('x1', '0');
      neg.setAttribute('y1', '0');
      neg.setAttribute('x2', (-entry.x * GIZMO_RADIUS * 0.62).toFixed(2));
      neg.setAttribute('y2', (-entry.y * GIZMO_RADIUS * 0.62).toFixed(2));
      neg.style.strokeOpacity = (0.12 + 0.34 * (1 - facing)).toFixed(3);
    }
  }
}

function setGizmoVisibility(visible) {
  if (!gizmoEl) return;
  gizmoEl.classList.toggle('is-hidden', !visible);
  gizmoEl.setAttribute('aria-hidden', String(!visible));
}

/* ------------------------------------------------------------ loop */

function tick() {
  requestAnimationFrame(tick);

  // The panels, scene graph and call stream must keep updating even with no
  // WebGL context — only the 3D draw is optional. Returning early here would
  // freeze the entire UI on machines without hardware acceleration.
  const now = performance.now();

  if (dirty) {
    dirty = false;
    if (webglAvailable) {
      rebuildViewport();
      syncEnvironment();
    }
    renderUI();
  }

  if (!renderer || !camera) return;

  const signature = cameraSignature();
  if (signature !== lastCameraSignature && !cameraTween.active) {
    lastCameraSignature = signature;
    syncCamera();
  }

  updateIntro(now);
  updateCameraTween(now);
  updateSpawnFlashes(now);
  controls?.update();
  updateGizmo();
  renderer.render(view, camera);
}

/* ---------------------------------------------------------------- UI */

let callCount = 0;

/* Repaint guards — the panels refresh on every kernel change, so entrance
 * motion is scoped to the renders where the content really did change. */
let lastObjectCount = -1;
let listAnimTimer = 0;
let lastDetailId;
let detailAnimTimer = 0;

/** Count a stat up to its new value instead of snapping — small, but alive. */
const counters = new WeakMap();
function setStat(node, value) {
  if (!node) return;
  const target = Number(value) || 0;
  const state = counters.get(node) || { displayed: 0, target: 0, raf: 0 };
  counters.set(node, state);
  state.target = target;
  if (state.displayed === target) {
    node.textContent = target.toLocaleString();
    return;
  }
  // A batch of calls lands in one synchronous burst, so always animate from
  // what is actually on screen — never from a target that never rendered.
  const from = state.displayed;
  const start = performance.now();
  const duration = 420;
  cancelAnimationFrame(state.raf);
  node.classList.add('is-counting');
  const step = (now) => {
    if (state.target !== target) return; // a newer count took over
    const k = clamp01((now - start) / duration);
    state.displayed = Math.round(from + (target - from) * easeOutExpo(k));
    node.textContent = state.displayed.toLocaleString();
    if (k < 1) state.raf = requestAnimationFrame(step);
    else node.classList.remove('is-counting');
  };
  state.raf = requestAnimationFrame(step);
}

function bump(node) {
  if (!node) return;
  node.classList.remove('is-bumped');
  void node.offsetWidth;
  node.classList.add('is-bumped');
  setTimeout(() => node.classList.remove('is-bumped'), 260);
}

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

  const listEl = el('object-list');
  // Rows only play their entrance when the scene graph actually changed shape;
  // repainting the same list must not make it flicker.
  if (objects.length !== lastObjectCount) {
    lastObjectCount = objects.length;
    listEl.classList.add('is-animating');
    clearTimeout(listAnimTimer);
    listAnimTimer = setTimeout(() => listEl.classList.remove('is-animating'), 620);
  }

  listEl.innerHTML = rows.length ? rows.join('') : '<p class="empty">No objects. An agent has not created anything yet.</p>';
  setStat(el('stat-objects'), objects.length);
  setStat(el('stat-tris'), Math.round(triangles));
  el('tab-count-objects').textContent = String(objects.length);
  el('selection-count').textContent = `${kernel.selection.size} selected`;

  const selectedId = [...kernel.selection][0];
  const detailEl = el('object-detail');
  if (selectedId && kernel.objects.has(selectedId)) {
    const detail = peek('inspect_object', { id: selectedId });
    if (selectedId !== lastDetailId) {
      lastDetailId = selectedId;
      detailEl.classList.add('is-animating');
      clearTimeout(detailAnimTimer);
      detailAnimTimer = setTimeout(() => detailEl.classList.remove('is-animating'), 520);
    }
    detailEl.innerHTML = detail.ok ? detailMarkup(detail.object) : '<p class="empty">Unavailable.</p>';
  } else {
    if (lastDetailId !== null) {
      lastDetailId = null;
      detailEl.classList.add('is-animating');
      clearTimeout(detailAnimTimer);
      detailAnimTimer = setTimeout(() => detailEl.classList.remove('is-animating'), 520);
    }
    detailEl.innerHTML = '<p class="empty">Nothing selected.</p>';
  }

  const stats = peek('inspect_scene', {});
  if (stats.ok) {
    const s = stats.scene_bounds.size;
    el('readout-bounds').textContent = objects.length
      ? `${s[0].toFixed(2)} × ${s[1].toFixed(2)} × ${s[2].toFixed(2)} ${kernel.units} · vol ${stats.total_volume.toFixed(3)}`
      : '—';
  }

  for (const button of listEl.querySelectorAll('.row')) {
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

/* --------------------------------------------------------------- tabs */

const tabsRoot = document.querySelector('.tabs');
const tabIndicator = document.querySelector('.tab-indicator');

function moveTabIndicator() {
  const active = tabsRoot?.querySelector('.tab.is-active');
  if (!active || !tabIndicator || !tabsRoot) return;
  const tabRect = active.getBoundingClientRect();
  const rootRect = tabsRoot.getBoundingClientRect();
  if (!tabRect.width) return;
  tabIndicator.style.width = `${tabRect.width}px`;
  tabIndicator.style.transform = `translateX(${tabRect.left - rootRect.left}px)`;
}

function activateTab(name, { focus = false } = {}) {
  for (const tab of document.querySelectorAll('.tab')) {
    const on = tab.dataset.tab === name;
    tab.classList.toggle('is-active', on);
    tab.setAttribute('aria-selected', String(on));
    if (on && focus) tab.focus();
  }
  for (const pane of document.querySelectorAll('.tab-pane')) {
    const on = pane.dataset.pane === name;
    pane.classList.toggle('is-active', on);
    pane.hidden = !on;
  }
  moveTabIndicator();
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => activateTab(tab.dataset.tab));
  tab.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll('.tab')];
    const index = tabs.indexOf(tab);
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    activateTab(next.dataset.tab, { focus: true });
  });
}

/* ------------------------------------------------------ panel folding */

const workspace = el('workspace');
const panelToggle = el('panel-toggle');

function setPanelCollapsed(collapsed) {
  workspace.dataset.collapsed = String(collapsed);
  document.body.dataset.panelCollapsed = String(collapsed);
  panelToggle.classList.toggle('is-collapsed', collapsed);
  panelToggle.setAttribute('aria-expanded', String(!collapsed));
  panelToggle.title = collapsed ? 'Expand console' : 'Collapse console';
  // Let the width animation finish before re-measuring the tab pill.
  window.setTimeout(moveTabIndicator, collapsed ? 0 : 640);
  window.setTimeout(moveTabIndicator, 60);
}

panelToggle.addEventListener('click', () => {
  setPanelCollapsed(workspace.dataset.collapsed !== 'true');
});

/* ------------------------------------------------------------- theme */

function applyTheme(next, { animate = true } = {}) {
  theme = next === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  writeStoredTheme(theme);
  if (animate) {
    el('theme-toggle')?.animate?.(
      [{ transform: 'rotate(0deg) scale(1)' }, { transform: 'rotate(180deg) scale(0.86)' }, { transform: 'rotate(360deg) scale(1)' }],
      { duration: 520, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
    );
  }
  markDirty(); // repaint canvas background, grid, axes, selection outlines
}

el('theme-toggle').addEventListener('click', () => {
  applyTheme(theme === 'dark' ? 'light' : 'dark');
});

/* -------------------------------------------------------- call stream */

const logEl = () => el('call-log');
const pulseEl = el('viewport-pulse');

function pulseCanvas() {
  if (!pulseEl) return;
  pulseEl.classList.remove('is-on');
  void pulseEl.offsetWidth;
  pulseEl.classList.add('is-on');
}

/** The hairline sweep above the console while a call is being reported. */
const appEl = document.querySelector('.app');
let busyTimer = 0;
function flashBusy() {
  if (!appEl) return;
  appEl.classList.add('is-busy');
  clearTimeout(busyTimer);
  busyTimer = setTimeout(() => appEl.classList.remove('is-busy'), 720);
}

/** Roll a number up from 0 — used for the per-call millisecond readout. */
function countUpMs(node, target) {
  if (!target) { node.textContent = '0ms'; return; }
  const start = performance.now();
  const duration = Math.min(320, 120 + target * 2);
  const step = (now) => {
    const k = clamp01((now - start) / duration);
    node.textContent = `${Math.round(target * easeOutExpo(k))}ms`;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

server.subscribe((event) => {
  callCount += 1;
  setStat(el('stat-calls'), callCount);
  el('tab-count-calls').textContent = String(callCount);
  bump(el('tab-count-calls'));

  if (event.tool === 'set_environment' && event.args?.background) {
    agentBackground = String(event.args.background);
  }

  const failed = event.type === 'error' || event.result?.ok === false;
  const entry = document.createElement('div');
  entry.className = `call${failed ? ' is-error' : ''}`;
  const args = JSON.stringify(event.args ?? {});
  entry.innerHTML = `
    <div class="call-head">
      <code>${escape(event.tool)}</code>
      <span class="call-ms">0ms</span>
    </div>
    <div class="call-args">${escape(args.length > 150 ? `${args.slice(0, 150)}…` : args)}</div>
    ${failed ? `<div class="call-error">${escape(event.result?.error || 'failed')}${event.result?.hint ? `<br><em>${escape(event.result.hint)}</em>` : ''}</div>` : ''}
  `;
  countUpMs(entry.querySelector('.call-ms'), event.ms || 0);

  const container = logEl();
  if (container.querySelector('.empty')) container.innerHTML = '';
  container.prepend(entry);
  while (container.children.length > 120) container.lastChild.remove();
  entry.classList.add('is-fresh');
  setTimeout(() => entry.classList.remove('is-fresh'), 420);

  if (!/^(inspect_|list_|get_|measure)/.test(event.tool)) {
    markDirty();
    pulseCanvas();
    flashBusy();
  }
});

/* --------------------------------------------------------- controls */

const VIEW_UP = { top: [0, 0, -1], bottom: [0, 0, 1] };

function setActiveView(name) {
  for (const button of document.querySelectorAll('[data-view]')) {
    button.classList.toggle('is-on', button.dataset.view === name);
  }
}

for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => {
    const preset = button.dataset.view;
    setActiveView(preset);
    if (preset === 'frame') gotoView({ frame_all: true });
    else gotoView({ preset, up: VIEW_UP[preset] || [0, 1, 0] });
  });
}

// Clicking an axis of the corner gizmo flies the camera to that elevation.
for (const node of document.querySelectorAll('#axis-gizmo [data-axis]')) {
  const go = () => {
    const preset = node.dataset.preset;
    setActiveView(preset);
    gotoView({ preset, up: VIEW_UP[preset] || [0, 1, 0] }, 560);
  };
  node.addEventListener('click', go);
  node.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); go(); }
  });
}

el('toggle-grid').addEventListener('click', (event) => {
  grid.visible = !grid.visible;
  groundShadow.visible = grid.visible;
  event.currentTarget.classList.toggle('is-on', grid.visible);
});

el('toggle-axes').addEventListener('click', (event) => {
  axes.visible = !axes.visible;
  event.currentTarget.classList.toggle('is-on', axes.visible);
  setGizmoVisibility(axes.visible);
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
for (const eventName of ['focus', 'blur']) {
  el('console-input').addEventListener(eventName, (event) => {
    event.currentTarget.closest('.console-row')?.classList.toggle('is-focused', eventName === 'focus');
  });
}

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
  `<button data-cmd="${escape(command)}" type="button">${escape(label)}</button>`).join('');
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
  // A drag or click cancels any camera flight — the viewer always wins.
  renderer.domElement.addEventListener('pointerdown', () => { cameraTween.active = false; });
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

applyTheme(readStoredTheme() || 'light', { animate: false });
activateTab('calls');

// The tab pill is measured, so re-measure it once the fonts have landed.
window.addEventListener('resize', moveTabIndicator);
window.addEventListener('load', moveTabIndicator);
document.fonts?.ready?.then(moveTabIndicator).catch(() => {});

el('bridge-label').textContent = `${bridges.length} bridge${bridges.length === 1 ? '' : 's'} · ${bridges.join(' · ')}`;
el('status-tools').textContent = `${server.toolNames().length} tools`;
el('status-message').innerHTML = 'Orbit kernel ready — <code>window.orbit.call(tool, args)</code>';

// A tiny opening scene so the viewport is never an empty void. This is the one
// place the shell touches the kernel, and it goes through the tool surface like
// any agent would.
server.batch([
  { tool: 'create_object', args: { type: 'rounded_box', name: 'Chassis', position: [0, 0.25, 0], params: { width: 2.4, height: 0.5, depth: 1.6, radius: 0.14 }, material: 'metal', color: '#d6d6d6' } },
  { tool: 'create_object', args: { type: 'cylinder', name: 'Hub', position: [0, 0.8, 0], params: { radius: 0.42, height: 0.6, segments: 48 }, material: 'metal', color: '#ffffff' } },
  { tool: 'create_object', args: { type: 'torus', name: 'Ring', position: [0, 0.8, 0], rotation: [Math.PI / 2, 0, 0], params: { radius: 1.05, tube: 0.07, radial_segments: 64, tubular_segments: 20 }, material: 'metal', color: '#9a9a9a' } },
  { tool: 'set_camera', args: { frame_all: true } }
]);

resize();
markDirty();

// Opening move: pull back, then fly into the framed scene as the shell fades up.
if (camera && controls) {
  lastCameraSignature = cameraSignature();
  syncCamera();
  const framed = camera.position.clone();
  const target = controls.target.clone();
  const offset = framed.clone().sub(target).multiplyScalar(1.85);
  offset.y += 1.4;
  camera.position.copy(target.clone().add(offset));
  tweenCamera(framed, target, 1500, easeOutExpo);
  intro.active = true;
  intro.start = performance.now();
  setActiveView('frame');
}

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

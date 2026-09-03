/*
 * Viewport decoration — the "3D space" furniture around the meshes.
 *
 * Everything here is drawing sugar, not geometry: a fading ground grid, the
 * world X/Y/Z axes with lettered ends, a soft contact-shadow catcher, and the
 * maths that projects those axes into the little corner orientation gizmo.
 *
 * Pure Three.js, no DOM. app.js owns the scene graph, the lights and the
 * kernel; this module owns the overlays.
 *
 * Colour notes: line and basic materials are created with `toneMapped: false`
 * so the overlay colours land on screen exactly as authored (matching the CSS
 * chrome) instead of being dragged through the ACES filmic curve that the
 * meshes use.
 */

import * as THREE from 'three';

/* ----------------------------------------------------------- palettes */

export const DECOR_PALETTES = {
  light: {
    gridMinor: '#dcdcdc',
    gridMajor: '#b6b6b6',
    axis: '#6e6e6e',
    axisNegative: '#b0b0b0',
    labelInk: '#0d0d0d',
    labelPaper: '#ffffff',
    selection: '#0d0d0d',
    groundShadow: 0.2,
    hemisphereGround: 0x8f8f8f
  },
  dark: {
    gridMinor: '#1f1f1f',
    gridMajor: '#3a3a3a',
    axis: '#9a9a9a',
    axisNegative: '#4a4a4a',
    labelInk: '#f5f5f5',
    labelPaper: '#101010',
    selection: '#ffffff',
    groundShadow: 0.55,
    hemisphereGround: 0x101014
  }
};

const _probe = new THREE.Color();

/** Relative luminance of a CSS colour string, 0 = black, 1 = white. */
export function luminance(color) {
  try { _probe.set(color); } catch { return 0.5; }
  // .set() lands in the working (linear) space, which is fine for a threshold.
  return 0.2126 * _probe.r + 0.7152 * _probe.g + 0.0722 * _probe.b;
}

/** Pick the overlay palette that stays legible on top of `background`. */
export function paletteForBackground(background, fallback = 'light') {
  const light = luminance(background) > 0.42;
  return DECOR_PALETTES[light ? 'light' : 'dark'] || DECOR_PALETTES[fallback];
}

/** Convert an authored sRGB colour to the linear working space Three expects. */
function linear(color) {
  return new THREE.Color(color).toArray();
}

/* --------------------------------------------------------------- grid */

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0 || 1)));
  return t * t * (3 - 2 * t);
}

/**
 * A ground grid in the idiom of every 3D package: fine minor lines, heavier
 * major lines every `majorEvery` steps, both fading out toward the horizon so
 * the plane reads as infinite rather than as a hard-edged tile.
 *
 * Each line is emitted as a chain of short segments rather than one pair of
 * endpoints, because the fade lives in per-vertex alpha: two vertices at the
 * rim would interpolate the fade backwards across the whole span.
 *
 * @returns {THREE.LineSegments} with `userData.recolor(palette)`
 */
export function createGroundGrid(options = {}) {
  const size = options.size ?? 24;
  const step = options.step ?? 0.25;
  const majorEvery = options.majorEvery ?? 4;
  const fadeFrom = options.fadeFrom ?? 0.45; // fraction of the half-size kept at full strength
  const piece = options.piece ?? 1;          // world units per fade sample

  const half = size / 2;
  const n = Math.max(2, Math.round(size / step));
  const pieces = Math.max(1, Math.round(size / piece));
  const positions = [];
  const colors = [];
  const fades = [];
  const majors = [];

  const pushLine = (ax, az, bx, bz, major) => {
    for (let p = 0; p < pieces; p += 1) {
      const t0 = p / pieces;
      const t1 = (p + 1) / pieces;
      for (const t of [t0, t1]) {
        const x = ax + (bx - ax) * t;
        const z = az + (bz - az) * t;
        positions.push(x, 0, z);
        colors.push(0, 0, 0, 0); // filled in by recolor()
        // Fade on distance from the origin, so the middle stays crisp and the
        // rim dissolves instead of ending in a hard edge.
        fades.push(smoothstep(1, fadeFrom, Math.hypot(x, z) / half));
        majors.push(major);
      }
    }
  };

  for (let k = 0; k <= n; k += 1) {
    const t = -half + (k * size) / n;
    const major = k % majorEvery === 0;
    pushLine(-half, t, half, t, major); // running along X
    pushLine(t, -half, t, half, major); // running along Z
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  // itemSize 4 → Three enables per-vertex alpha (USE_COLOR_ALPHA).
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));

  const material = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    toneMapped: false
  });

  const grid = new THREE.LineSegments(geometry, material);
  grid.renderOrder = -2;
  grid.userData.recolor = (palette) => {
    const minor = linear(palette.gridMinor);
    const major = linear(palette.gridMajor);
    const attribute = geometry.getAttribute('color');
    for (let i = 0; i < fades.length; i += 1) {
      const isMajor = majors[i];
      const source = isMajor ? major : minor;
      // Major lines stay stronger than minor ones across the whole fade.
      const alpha = fades[i] * (isMajor ? 0.95 : 0.68);
      attribute.setXYZW(i, source[0], source[1], source[2], alpha);
    }
    attribute.needsUpdate = true;
  };
  grid.userData.dispose = () => { geometry.dispose(); material.dispose(); };
  return grid;
}

/* --------------------------------------------------------------- axes */

function labelTexture(letter, palette) {
  // No document (Node) or no 2D context (headless): the axes still draw, they
  // just lose their lettered discs. Keeps this module importable outside a
  // browser, like the rest of the kernel.
  if (typeof document === 'undefined') return null;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, size, size);

  const cx = size / 2;
  ctx.beginPath();
  ctx.arc(cx, cx, size * 0.4, 0, Math.PI * 2);
  ctx.fillStyle = palette.labelInk;
  ctx.fill();
  ctx.lineWidth = size * 0.055;
  ctx.strokeStyle = palette.labelPaper;
  ctx.stroke();

  ctx.fillStyle = palette.labelPaper;
  ctx.font = `600 ${Math.round(size * 0.44)}px Inter, "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, cx, cx + size * 0.015);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

const AXIS_DEFS = [
  { key: 'x', letter: 'X', dir: new THREE.Vector3(1, 0, 0) },
  { key: 'y', letter: 'Y', dir: new THREE.Vector3(0, 1, 0) },
  { key: 'z', letter: 'Z', dir: new THREE.Vector3(0, 0, 1) }
];

/**
 * World axis indicator: solid positive half with an arrowhead and a lettered
 * disc, dashed negative half — the orientation cue every 3D viewport has.
 *
 * @returns {THREE.Group} with `userData.recolor(palette)`
 */
export function createWorldAxes(options = {}) {
  const length = options.length ?? 2.1;
  const negative = options.negative ?? 0.62;
  const labelScale = options.labelScale ?? 0.2;

  const group = new THREE.Group();
  group.name = 'world-axes';

  const parts = [];
  const up = new THREE.Vector3(0, 1, 0);

  for (const axis of AXIS_DEFS) {
    const positive = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), axis.dir.clone().multiplyScalar(length)]),
      new THREE.LineBasicMaterial({ transparent: true, opacity: 0.92, depthWrite: false, toneMapped: false })
    );

    const negativeLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), axis.dir.clone().multiplyScalar(-negative)]),
      new THREE.LineDashedMaterial({
        dashSize: 0.07, gapSize: 0.07, transparent: true, opacity: 0.55,
        depthWrite: false, toneMapped: false
      })
    );
    negativeLine.computeLineDistances();

    const head = new THREE.Mesh(
      new THREE.ConeGeometry(0.036, 0.13, 18),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95, toneMapped: false })
    );
    head.position.copy(axis.dir).multiplyScalar(length + 0.055);
    head.quaternion.setFromUnitVectors(up, axis.dir);

    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ depthTest: false, depthWrite: false, transparent: true, toneMapped: false })
    );
    sprite.position.copy(axis.dir).multiplyScalar(length + 0.24);
    sprite.scale.setScalar(labelScale);
    sprite.renderOrder = 900;

    group.add(positive, negativeLine, head, sprite);
    parts.push({ axis: axis.key, letter: axis.letter, positive, negativeLine, head, sprite });
  }

  group.userData.parts = parts;
  group.userData.recolor = (palette) => {
    for (const part of parts) {
      part.positive.material.color.set(palette.axis);
      part.negativeLine.material.color.set(palette.axisNegative);
      part.head.material.color.set(palette.axis);
      const map = labelTexture(part.letter, palette);
      if (map) {
        part.sprite.material.map?.dispose();
        part.sprite.material.map = map;
        part.sprite.visible = true;
      } else {
        part.sprite.visible = false; // no 2D canvas: hide the disc rather than draw it blank
      }
      part.sprite.material.needsUpdate = true;
    }
  };
  group.userData.dispose = () => {
    for (const part of parts) {
      part.positive.geometry.dispose();
      part.positive.material.dispose();
      part.negativeLine.geometry.dispose();
      part.negativeLine.material.dispose();
      part.head.geometry.dispose();
      part.head.material.dispose();
      part.sprite.material.map?.dispose();
      part.sprite.material.dispose();
    }
  };
  return group;
}

/* ------------------------------------------------------ contact shadow */

/**
 * An invisible plane that only ever draws the shadow falling on it — the reason
 * white-on-white scenes still read as solid objects sitting on a floor.
 */
export function createGroundShadow(options = {}) {
  const size = options.size ?? 60;
  const material = new THREE.ShadowMaterial({ opacity: 0.2, color: 0x000000, transparent: true, depthWrite: false });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
  plane.rotation.x = -Math.PI / 2;
  plane.receiveShadow = true;
  plane.renderOrder = -3;
  plane.userData.recolor = (palette) => { material.opacity = palette.groundShadow; };
  plane.userData.dispose = () => { plane.geometry.dispose(); material.dispose(); };
  return plane;
}

/* ------------------------------------------------- corner gizmo maths */

const _viewMatrix = new THREE.Matrix4();
const _rotation = new THREE.Matrix3();
const _axis = new THREE.Vector3();

/**
 * Project the three world axes into gizmo space for the corner indicator.
 *
 * Returns, per axis, the unit-screen direction (y already flipped for SVG's
 * downward y) and `depth` in -1…1 where **positive means "toward the viewer"**
 * — view space looks down its own -Z, so an axis with a positive view-space z
 * is pointing back at the eye. The caller uses it to dim the axes pointing
 * away and thicken the ones pointing out of the screen.
 */
export function gizmoDirections(camera) {
  camera.updateMatrixWorld();
  _viewMatrix.copy(camera.matrixWorld).invert();
  _rotation.setFromMatrix4(_viewMatrix);

  return AXIS_DEFS.map((axis) => {
    _axis.copy(axis.dir).applyMatrix3(_rotation);
    return { axis: axis.key, x: _axis.x, y: -_axis.y, depth: _axis.z };
  });
}

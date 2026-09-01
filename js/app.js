import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { routePrompt, extractRestoreTarget } from './agent-router.js';

/*
 * Orbit is deliberately client-side: the visual studio and the WebMCP tools
 * operate on the same scene state. This keeps every agent operation visible,
 * reversible, and inspectable by the human collaborator.
 */
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const els = {
  canvas: $('#canvas-container'),
  objectList: $('#object-list'),
  objectCountTop: $('#object-count-top'),
  sceneSummaryText: $('#scene-summary-text'),
  sceneSummaryCount: $('#scene-summary-count'),
  selectedStatus: $('#selected-status'),
  inspectorEmpty: $('#inspector-empty'),
  inspectorContent: $('#inspector-content'),
  nameInput: $('#object-name-input'),
  typeBadge: $('#object-type-badge'),
  objectId: $('#object-id-label'),
  selectionHud: $('#selection-hud'),
  selectionHudName: $('#selection-hud-name'),
  emptyCanvas: $('#empty-canvas'),
  constraintList: $('#constraint-list'),
  commentList: $('#comment-list'),
  commentInput: $('#comment-input'),
  versionList: $('#version-list'),
  proposalSlot: $('#proposal-slot'),
  conversation: $('#conversation'),
  activityList: $('#activity-list'),
  activityCount: $('#activity-count'),
  planCount: $('#plan-count'),
  agentInput: $('#agent-input'),
  agentForm: $('#agent-composer'),
  agentStatusCard: $('#agent-status-card'),
  agentStatusTitle: $('#agent-status-title'),
  agentStatusCopy: $('#agent-status-copy'),
  topStatus: $('#top-status'),
  modeHint: $('#mode-hint'),
  canvasMessage: $('#canvas-message'),
  cameraReadout: $('#camera-readout'),
  toast: $('#webmcp-toast'),
  toastCopy: $('#webmcp-toast-copy'),
  footerStatus: $('#webmcp-footer-status'),
  permissionsModal: $('#permissions-modal'),
  reviewModal: $('#review-modal'),
  reviewScore: $('#review-score'),
  reviewSummary: $('#review-summary'),
  reviewMetrics: $('#review-metrics'),
  reviewFindings: $('#review-findings'),
  reviewMetricDetail: $('#review-metric-detail'),
  applyReviewButton: $('#apply-review-btn'),
  buildOverlay: $('#agent-build-overlay'),
  buildStep: $('#agent-build-step'),
  buildProgress: $('#agent-build-progress'),
  buildCount: $('#agent-build-count'),
  selectionContext: $('#selection-context'),
  selectionContextValue: $('#selection-context-value'),
  selectionContextRevision: $('#selection-context-revision'),
  permissionTierLabel: $('#permission-tier-label'),
  permissionTierCopy: $('#permission-tier-copy'),
  timeTravelOverlay: $('#time-travel-overlay'),
  timeTravelOverlayTitle: $('#time-travel-overlay-title'),
  timeTravelRange: $('#time-travel-range'),
  timeTravelCaption: $('#time-travel-caption'),
  exitTimeTravelButton: $('#exit-time-travel-btn'),
  exitTimeTravelCanvasButton: $('#exit-time-travel-canvas'),
  gestureHud: $('#gesture-hud'),
  gestureHudName: $('#gesture-hud-name'),
  preferenceChips: $('#preference-chips'),
  personaSelect: $('#persona-select'),
  teachAgentButton: $('#teach-agent-btn'),
  voiceButton: $('#voice-agent-btn'),
  voiceStatus: $('#voice-status')
};

const TYPES = ['cube', 'sphere', 'cylinder', 'cone', 'torus', 'plane'];
const TYPE_LABELS = {
  cube: 'Cube', sphere: 'Sphere', cylinder: 'Cylinder', cone: 'Cone', torus: 'Torus', plane: 'Plane'
};
const TYPE_SYMBOLS = { cube: '◇', sphere: '○', cylinder: '▤', cone: '△', torus: '⊙', plane: '▱' };
const BASE_DIMENSIONS = {
  cube: [1, 1, 1], sphere: [1, 1, 1], cylinder: [1, 1, 1], cone: [1, 1, 1], torus: [1, .3, 1], plane: [1, .025, 1]
};
/*
 * The studio is intentionally monochrome: every surface is described by value
 * (light to dark) plus a finish, so agent edits read clearly in the viewport.
 */
const MATERIALS = {
  metal: { label: 'Metal', color: '#c8c8c8', metalness: .92, roughness: .21 },
  plastic: { label: 'Matte', color: '#9c9c9c', metalness: .04, roughness: .62 },
  glass: { label: 'Glass', color: '#e6e6e6', metalness: .02, roughness: .05, transparent: true, opacity: .34 },
  wood: { label: 'Grain', color: '#8a8a8a', metalness: .02, roughness: .85 },
  emissive: { label: 'Emissive', color: '#ffffff', metalness: .1, roughness: .3, emissive: true }
};

/*
 * Procedural greyscale textures. They are generated on a 2D canvas so the studio has
 * no binary assets, and every texture an agent applies is fully reproducible from state.
 */
const TEXTURES = {
  none: { label: 'None' },
  grid: { label: 'Grid' },
  brushed: { label: 'Brushed' },
  noise: { label: 'Grain' },
  checker: { label: 'Checker' },
  hatch: { label: 'Hatch' },
  dots: { label: 'Dots' }
};
const TEXTURE_NAMES = Object.keys(TEXTURES);
const DETAIL_LEVELS = { low: 'Low poly', standard: 'Standard', high: 'High' };
const COLOR_WORDS = {
  black: '#111111', ink: '#111111', charcoal: '#2b2b2b', graphite: '#3d3d3d',
  dark: '#3d3d3d', grey: '#8a8a8a', gray: '#8a8a8a', mid: '#8a8a8a',
  steel: '#a5a5a5', silver: '#c8c8c8', light: '#d6d6d6', ash: '#d6d6d6',
  chalk: '#efefef', white: '#fafafa', bone: '#efefef'
};

const state = {
  objects: [],
  selectedId: null,
  hoveredId: null,
  constraints: [],
  comments: [],
  designContext: { intent: '', style: 'Exploratory', updatedAt: null, preferences: [], persona: 'Adaptive co-designer' },
  history: [],
  historyIndex: -1,
  versions: [],
  currentVersionId: null,
  pendingProposal: null,
  lastAgentRun: null,
  activeRun: null,
  locks: {},
  selectionRevision: 0,
  selectionContext: { selected_object: null, pointed_object: null, revision: 0, updated_at: null },
  timeTravel: { active: false, eventId: null, liveSnapshot: null },
  activity: [],
  currentMode: 'planning',
  permissions: { read: true, create: true, modify: true, delete: false, export: false, share: false }
};

let scene;
let camera;
let renderer;
let controls;
let modelGroup;
let selectionBox;
let hoverBox;
let viewportReady = false;
let pointerDown = null;
let dragState = null;
let speechRecognition = null;
let hoverClearTimer;
let toastTimer;
let agentRequestNonce = 0;
let currentReview = null;
const toolRegistry = new Map();

const clone = (value) => JSON.parse(JSON.stringify(value));
const delay = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const safeNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

function makeId(prefix = 'obj') {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
}

function titleCase(value) {
  return String(value || '').replace(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function validColor(color) {
  return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color);
}

function cleanVector(value, fallback, { min = -100, max = 100 } = {}) {
  const source = Array.isArray(value) ? value : fallback;
  return [0, 1, 2].map((index) => clamp(safeNumber(source[index], fallback[index]), min, max));
}

function defaultPosition(type) {
  if (type === 'plane') return [0, 0, 0];
  if (type === 'sphere' || type === 'cylinder' || type === 'cone') return [0, .5, 0];
  if (type === 'torus') return [0, .22, 0];
  return [0, .5, 0];
}

function defaultRotation(type) {
  return type === 'plane' ? [-Math.PI / 2, 0, 0] : [0, 0, 0];
}

function nextObjectName(type) {
  const sequence = state.objects.filter((object) => object.type === type).length + 1;
  return `${TYPE_LABELS[type] || 'Object'} ${String(sequence).padStart(2, '0')}`;
}

function normaliseDesignContext(raw = {}) {
  return {
    intent: String(raw.intent || '').slice(0, 300),
    style: String(raw.style || 'Exploratory').slice(0, 48),
    updatedAt: raw.updatedAt || null,
    preferences: Array.isArray(raw.preferences) ? [...new Set(raw.preferences.map((preference) => String(preference).trim().slice(0, 70)).filter(Boolean))].slice(0, 12) : [],
    persona: String(raw.persona || 'Adaptive co-designer').slice(0, 48)
  };
}

function normaliseObject(raw = {}) {
  const type = TYPES.includes(raw.type) ? raw.type : 'cube';
  const defaultColor = MATERIALS[raw.material]?.color || MATERIALS.plastic.color;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : makeId('obj'),
    name: String(raw.name || nextObjectName(type)).slice(0, 48),
    type,
    position: cleanVector(raw.position, defaultPosition(type)),
    rotation: cleanVector(raw.rotation, defaultRotation(type), { min: -Math.PI * 8, max: Math.PI * 8 }),
    scale: cleanVector(raw.scale, [1, 1, 1], { min: .05, max: 30 }),
    material: MATERIALS[raw.material] ? raw.material : 'plastic',
    color: validColor(raw.color) ? raw.color : defaultColor,
    texture: TEXTURES[raw.texture] ? raw.texture : 'none',
    textureScale: clamp(safeNumber(raw.textureScale, 1), .25, 8),
    roughness: isNumber(raw.roughness) ? clamp(raw.roughness, 0, 1) : null,
    metalness: isNumber(raw.metalness) ? clamp(raw.metalness, 0, 1) : null,
    detail: DETAIL_LEVELS[raw.detail] ? raw.detail : 'standard',
    tags: Array.isArray(raw.tags) ? raw.tags.map((tag) => String(tag).slice(0, 32)).slice(0, 12) : []
  };
}

/* A compact, agent-readable description of one object's surface treatment. */
function materialSummary(object) {
  const preset = MATERIALS[object.material] || MATERIALS.plastic;
  return {
    finish: object.material,
    finish_label: preset.label,
    color: object.color,
    texture: object.texture,
    texture_label: TEXTURES[object.texture]?.label || 'None',
    texture_scale: Number(object.textureScale.toFixed(2)),
    roughness: Number((isNumber(object.roughness) ? object.roughness : preset.roughness).toFixed(2)),
    metalness: Number((isNumber(object.metalness) ? object.metalness : preset.metalness).toFixed(2)),
    roughness_overridden: isNumber(object.roughness),
    metalness_overridden: isNumber(object.metalness)
  };
}

function snapshotScene() {
  return clone({
    objects: state.objects,
    selectedId: state.selectedId,
    constraints: state.constraints,
    comments: state.comments,
    designContext: state.designContext,
    // The active checkpoint pointer belongs to the scene snapshot so undo/redo and
    // time-travel never leave a restored version marked active for a different scene.
    currentVersionId: state.currentVersionId
  });
}

function hydrateScene(snapshot) {
  const source = snapshot || {};
  state.objects = Array.isArray(source.objects) ? source.objects.map(normaliseObject) : [];
  state.selectedId = state.objects.some((object) => object.id === source.selectedId) ? source.selectedId : null;
  state.constraints = Array.isArray(source.constraints) ? clone(source.constraints) : [];
  state.comments = Array.isArray(source.comments) ? clone(source.comments) : [];
  state.designContext = normaliseDesignContext(source.designContext);
  if ('currentVersionId' in source) {
    state.currentVersionId = state.versions.some((version) => version.id === source.currentVersionId) ? source.currentVersionId : null;
  }
}

function serialisedScene() {
  const statistics = getSceneStatistics();
  return {
    objects: state.objects.map((object) => ({
      ...clone(object),
      bounds: objectBounds(object),
      material_summary: materialSummary(object),
      triangle_estimate: estimateTriangles(object)
    })),
    available_textures: TEXTURE_NAMES,
    available_finishes: Object.keys(MATERIALS),
    available_detail_levels: Object.keys(DETAIL_LEVELS),
    selected_object_id: state.selectedId,
    constraints: clone(state.constraints),
    comments: clone(state.comments),
    design_context: clone(state.designContext),
    statistics,
    bounding_box: calculateSceneBounds()
  };
}

function persistWorkspace() {
  try {
    const payload = {
      scene: snapshotScene(),
      versions: state.versions.map(({ id, label, createdAt, snapshot }) => ({ id, label, createdAt, snapshot })),
      currentVersionId: state.currentVersionId
    };
    localStorage.setItem('orbit-webmcp-workspace-v2', JSON.stringify(payload));
  } catch (error) {
    // Storage is a convenience only. The editor remains fully functional without it.
    console.warn('Could not persist workspace:', error);
  }
}

function normaliseVersionRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const snapshot = raw.snapshot;
  if (!snapshot || !Array.isArray(snapshot.objects)) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : makeId('version'),
    label: String(raw.label || 'Checkpoint').slice(0, 30),
    createdAt: isNumber(raw.createdAt) ? raw.createdAt : Date.now(),
    snapshot: {
      objects: snapshot.objects.map(normaliseObject),
      selectedId: typeof snapshot.selectedId === 'string' ? snapshot.selectedId : null,
      constraints: Array.isArray(snapshot.constraints) ? clone(snapshot.constraints) : [],
      comments: Array.isArray(snapshot.comments) ? clone(snapshot.comments) : [],
      designContext: normaliseDesignContext(snapshot.designContext),
      currentVersionId: typeof snapshot.currentVersionId === 'string' ? snapshot.currentVersionId : null
    }
  };
}

/*
 * Restore the whole saved workspace — scene, checkpoints and project memory — so a
 * reload does not silently discard locally saved work. Every field is re-validated
 * because local storage is user-editable.
 */
function loadPersistedWorkspace() {
  const outcome = { restoredScene: false, restoredMemory: false, versions: [], currentVersionId: null };
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem('orbit-webmcp-workspace-v2') || 'null');
  } catch (error) {
    console.warn('Could not read the persisted workspace:', error);
    return outcome;
  }
  if (!saved || typeof saved !== 'object') return outcome;

  const memory = saved.scene?.designContext;
  if (memory) {
    state.designContext = { ...state.designContext, ...normaliseDesignContext(memory), intent: state.designContext.intent };
    outcome.restoredMemory = (state.designContext.preferences || []).length > 0;
  }

  outcome.versions = (Array.isArray(saved.versions) ? saved.versions : []).map(normaliseVersionRecord).filter(Boolean).slice(-12);

  if (saved.scene && Array.isArray(saved.scene.objects) && saved.scene.objects.length) {
    try {
      state.versions = outcome.versions;
      hydrateScene(saved.scene);
      state.currentVersionId = outcome.versions.some((version) => version.id === saved.currentVersionId) ? saved.currentVersionId : state.currentVersionId;
      outcome.currentVersionId = state.currentVersionId;
      outcome.restoredScene = true;
    } catch (error) {
      console.warn('Could not restore the persisted scene:', error);
      state.versions = [];
      hydrateScene({});
      outcome.restoredScene = false;
    }
  }
  return outcome;
}

function savePreference(preference, source = 'human') {
  if (state.timeTravel.active) throw new Error('Return to the live scene before changing project memory.');
  const clean = String(preference || '').trim().replace(/^remember\s+(?:that\s+)?/i, '').slice(0, 70);
  if (!clean) throw new Error('Tell Orbit which preference to remember.');
  const preferences = [...new Set([...(state.designContext.preferences || []), clean])].slice(-12);
  state.designContext = normaliseDesignContext({ ...state.designContext, preferences, updatedAt: Date.now() });
  persistWorkspace();
  renderProjectMemory();
  addActivity('Saved project preference', `Orbit will carry “${clean}” into future local planning sessions.`, source);
  return clean;
}

function setProjectPersona(persona, source = 'human') {
  const allowed = ['Adaptive co-designer', 'Visual designer', 'Geometry engineer', 'Design reviewer'];
  const value = allowed.includes(persona) ? persona : 'Adaptive co-designer';
  if (source === 'agent' && !state.permissions.modify) {
    throw new Error('Modify permission is disabled; the project persona cannot be changed.');
  }
  if (state.timeTravel.active) {
    setCanvasMessage('Return to the live scene before changing Orbit’s role');
    return value;
  }
  state.designContext = normaliseDesignContext({ ...state.designContext, persona: value, updatedAt: Date.now() });
  persistWorkspace();
  renderProjectMemory();
  addActivity('Changed Orbit project persona', `${value} is now the persistent collaboration role.`, source);
  return value;
}

function removePreference(preference) {
  if (state.timeTravel.active) {
    setCanvasMessage('Return to the live scene before changing project memory');
    return;
  }
  state.designContext = normaliseDesignContext({ ...state.designContext, preferences: (state.designContext.preferences || []).filter((item) => item !== preference), updatedAt: Date.now() });
  persistWorkspace();
  renderProjectMemory();
  addActivity('Forgot project preference', `Removed “${preference}” from local project memory.`, 'human');
}

function effectiveStyle(text) {
  const explicit = detectStyle(text);
  if (explicit !== 'Exploratory') return explicit;
  const memory = (state.designContext.preferences || []).join(' ').toLowerCase();
  if (/low[ -]?poly/.test(memory)) return 'Low-poly';
  if (/futur|sci[ -]?fi/.test(memory)) return 'Futuristic';
  if (/minimal|clean/.test(memory)) return 'Minimal';
  if (/industrial|utility/.test(memory)) return 'Industrial';
  return 'Exploratory';
}

function applyMutation(meta, mutate) {
  const before = snapshotScene();
  const result = mutate();
  const after = snapshotScene();
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  let entry = null;

  if (changed) {
    state.history = state.history.slice(0, state.historyIndex + 1);
    entry = {
      id: makeId('change'),
      label: meta.label || 'Updated scene',
      source: meta.source || 'human',
      why: meta.why || '',
      runId: meta.runId || null,
      timestamp: Date.now(),
      before,
      after
    };
    state.history.push(entry);
    if (state.history.length > 60) state.history.shift();
    state.historyIndex = state.history.length - 1;
  }

  refreshUI({ scene: true });
  persistWorkspace();
  return { result, entry, changed, before, after };
}

function undoLastChange() {
  if (state.activeRun) { interruptActiveRun(); return false; }
  if (state.historyIndex < 0) {
    setCanvasMessage('Nothing to undo');
    return false;
  }
  const entry = state.history[state.historyIndex];
  state.historyIndex -= 1;
  hydrateScene(entry.before);
  refreshUI({ scene: true });
  persistWorkspace();
  addActivity(`Undid “${entry.label}”`, 'Human returned to the previous shared state.', 'human');
  return true;
}

function redoLastChange() {
  if (state.activeRun) { interruptActiveRun(); return false; }
  if (state.historyIndex >= state.history.length - 1) {
    setCanvasMessage('Nothing to redo');
    return false;
  }
  state.historyIndex += 1;
  const entry = state.history[state.historyIndex];
  hydrateScene(entry.after);
  refreshUI({ scene: true });
  persistWorkspace();
  addActivity(`Redid “${entry.label}”`, 'Restored a shared scene state.', 'human');
  return true;
}

const VIEWPORT = {
  background: '#0c0c0c',
  floor: 0x161616,
  grid: 0x242424,
  gridStrong: 0x3a3a3a,
  selection: 0xffffff,
  hover: 0x9a9a9a
};

/*
 * Procedural greyscale texture generation. Textures are cached per pattern and repeat
 * so repeated agent refinements do not allocate a new GPU texture on every frame.
 */
const textureCache = new Map();

function drawTexturePattern(context, pattern, size) {
  context.fillStyle = '#b4b4b4';
  context.fillRect(0, 0, size, size);
  if (pattern === 'grid') {
    context.strokeStyle = '#5e5e5e';
    context.lineWidth = size / 64;
    for (let step = 0; step <= 8; step += 1) {
      const offset = (step / 8) * size;
      context.beginPath(); context.moveTo(offset, 0); context.lineTo(offset, size); context.stroke();
      context.beginPath(); context.moveTo(0, offset); context.lineTo(size, offset); context.stroke();
    }
    return;
  }
  if (pattern === 'checker') {
    context.fillStyle = '#6e6e6e';
    for (let row = 0; row < 8; row += 1) {
      for (let column = 0; column < 8; column += 1) {
        if ((row + column) % 2 === 0) context.fillRect((column * size) / 8, (row * size) / 8, size / 8, size / 8);
      }
    }
    return;
  }
  if (pattern === 'hatch') {
    context.strokeStyle = '#666666';
    context.lineWidth = size / 96;
    for (let step = -size; step < size * 2; step += size / 14) {
      context.beginPath(); context.moveTo(step, 0); context.lineTo(step + size, size); context.stroke();
    }
    return;
  }
  if (pattern === 'dots') {
    context.fillStyle = '#6a6a6a';
    for (let row = 0; row < 10; row += 1) {
      for (let column = 0; column < 10; column += 1) {
        context.beginPath();
        context.arc(((column + .5) * size) / 10, ((row + .5) * size) / 10, size / 42, 0, Math.PI * 2);
        context.fill();
      }
    }
    return;
  }
  if (pattern === 'brushed') {
    for (let line = 0; line < size * 1.4; line += 1) {
      const value = 150 + Math.round((Math.random() - .5) * 58);
      context.strokeStyle = `rgb(${value},${value},${value})`;
      context.lineWidth = 1;
      const y = Math.random() * size;
      context.beginPath(); context.moveTo(0, y); context.lineTo(size, y); context.stroke();
    }
    return;
  }
  if (pattern === 'noise') {
    const image = context.getImageData(0, 0, size, size);
    for (let index = 0; index < image.data.length; index += 4) {
      const value = 130 + Math.round(Math.random() * 74);
      image.data[index] = value;
      image.data[index + 1] = value;
      image.data[index + 2] = value;
      image.data[index + 3] = 255;
    }
    context.putImageData(image, 0, 0);
  }
}

function getProceduralTexture(pattern, repeat = 1) {
  if (!pattern || pattern === 'none' || !TEXTURES[pattern]) return null;
  const key = `${pattern}@${repeat.toFixed(2)}`;
  if (textureCache.has(key)) return textureCache.get(key);
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  drawTexturePattern(context, pattern, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.anisotropy = 8;
  texture.colorSpace = THREE.SRGBColorSpace;
  textureCache.set(key, texture);
  return texture;
}

function supportsWebGL() {
  try {
    const probe = document.createElement('canvas');
    return Boolean(window.WebGLRenderingContext && (probe.getContext('webgl2') || probe.getContext('webgl')));
  } catch (_) {
    return false;
  }
}

/*
 * If WebGL is unavailable the studio must still be usable: the object list, inspector,
 * history and every WebMCP tool keep working against the same state, only the
 * rasterised viewport is replaced with an explanation.
 */
function showViewportFallback(message) {
  viewportReady = false;
  els.canvas.replaceChildren();
  const panel = node('div', 'viewport-fallback');
  panel.append(
    node('strong', '', 'The 3D viewport is unavailable'),
    node('p', '', message),
    node('p', '', 'Scene state, the inspector, history and all WebMCP tools remain fully functional.')
  );
  els.canvas.append(panel);
}

/* Three.js canvas */
function initThree() {
  if (!supportsWebGL()) {
    showViewportFallback('This browser did not provide a WebGL context.');
    return;
  }
  try {
    buildViewport();
    viewportReady = true;
  } catch (error) {
    console.error('Could not initialise the 3D viewport:', error);
    showViewportFallback(error.message || 'The renderer could not start.');
  }
}

function buildViewport() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(VIEWPORT.background);
  scene.fog = new THREE.FogExp2(VIEWPORT.background, .028);

  camera = new THREE.PerspectiveCamera(48, 1, .1, 100);
  camera.position.set(8.4, 6.4, 9.5);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  els.canvas.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.2, 0);
  controls.enableDamping = true;
  controls.dampingFactor = .055;
  controls.minDistance = 2.2;
  controls.maxDistance = 32;
  controls.maxPolarAngle = Math.PI / 2.03;

  const grid = new THREE.GridHelper(18, 36, VIEWPORT.gridStrong, VIEWPORT.grid);
  grid.position.y = -.01;
  grid.material.transparent = true;
  grid.material.opacity = .42;
  scene.add(grid);

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(9.1, 64),
    new THREE.MeshBasicMaterial({ color: VIEWPORT.floor, transparent: true, opacity: .5, depthWrite: false })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -.025;
  scene.add(floor);

  // Neutral three-point studio lighting: no colour casts, so value reads honestly.
  scene.add(new THREE.HemisphereLight(0xffffff, 0x202020, 1.15));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(4.4, 9.4, 5.6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.normalBias = .02;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, .75);
  fill.position.set(-6.2, 4.2, 4.4);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 1.1);
  rim.position.set(-2.4, 3.6, -7.4);
  scene.add(rim);

  modelGroup = new THREE.Group();
  modelGroup.name = 'Collaborative model';
  scene.add(modelGroup);

  selectionBox = new THREE.BoxHelper(undefined, VIEWPORT.selection);
  selectionBox.material.transparent = true;
  selectionBox.material.opacity = .92;
  selectionBox.material.depthTest = false;
  selectionBox.visible = false;
  scene.add(selectionBox);

  hoverBox = new THREE.BoxHelper(undefined, VIEWPORT.hover);
  hoverBox.material.transparent = true;
  hoverBox.material.opacity = .58;
  hoverBox.material.depthTest = false;
  hoverBox.visible = false;
  scene.add(hoverBox);

  const resize = () => {
    const width = Math.max(1, els.canvas.clientWidth);
    const height = Math.max(1, els.canvas.clientHeight);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  };
  new ResizeObserver(resize).observe(els.canvas);
  window.addEventListener('resize', resize);
  resize();

  renderer.domElement.addEventListener('pointerdown', beginCanvasPointer, { capture: true });
  renderer.domElement.addEventListener('pointermove', moveCanvasPointer, { capture: true });
  renderer.domElement.addEventListener('pointerup', endCanvasPointer, { capture: true });
  renderer.domElement.addEventListener('pointercancel', endCanvasPointer, { capture: true });
  renderer.domElement.addEventListener('pointerleave', () => {
    // Keep the last pointing target briefly so a user can move from canvas to mic button
    // and say “make that taller” without losing spatial grounding.
    window.clearTimeout(hoverClearTimer);
    hoverClearTimer = window.setTimeout(() => { if (!dragState) setHoveredObject(null); }, 4200);
  });

  const animate = () => {
    requestAnimationFrame(animate);
    controls.update();
    if (selectionBox.visible) selectionBox.update();
    if (hoverBox.visible) hoverBox.update();
    renderer.render(scene, camera);
    updateCameraReadout();
  };
  animate();
}

function disposeMesh(mesh) {
  if (mesh.geometry) mesh.geometry.dispose();
  if (Array.isArray(mesh.material)) mesh.material.forEach((material) => material.dispose());
  else if (mesh.material) mesh.material.dispose();
}

/*
 * Geometry resolution is part of the editable model, so "make it low poly" is a real
 * geometry change an agent can request and a human can see immediately.
 */
const DETAIL_FACTOR = { low: .34, standard: 1, high: 2 };

function makeGeometry(type, detail = 'standard') {
  const factor = DETAIL_FACTOR[detail] ?? 1;
  const segments = (base, minimum = 3) => Math.max(minimum, Math.round(base * factor));
  switch (type) {
    case 'sphere': return new THREE.SphereGeometry(.5, segments(36, 4), segments(24, 3));
    case 'cylinder': return new THREE.CylinderGeometry(.5, .5, 1, segments(36, 3));
    case 'cone': return new THREE.ConeGeometry(.5, 1, segments(36, 3));
    case 'torus': return new THREE.TorusGeometry(.35, .14, segments(16, 3), segments(36, 4));
    case 'plane': return new THREE.PlaneGeometry(1, 1, segments(1, 1), segments(1, 1));
    case 'cube':
    default: {
      const divisions = detail === 'high' ? 4 : 1;
      return new THREE.BoxGeometry(1, 1, 1, divisions, divisions, divisions);
    }
  }
}

function makeMaterial(object) {
  const preset = MATERIALS[object.material] || MATERIALS.plastic;
  const parameters = {
    color: new THREE.Color(validColor(object.color) ? object.color : preset.color),
    metalness: isNumber(object.metalness) ? object.metalness : preset.metalness,
    roughness: isNumber(object.roughness) ? object.roughness : preset.roughness,
    transparent: Boolean(preset.transparent),
    opacity: preset.opacity ?? 1
  };
  const texture = getProceduralTexture(object.texture, object.textureScale);
  if (texture) {
    parameters.map = texture;
    parameters.bumpMap = texture;
    parameters.bumpScale = .05;
    parameters.roughnessMap = texture;
  }
  if (preset.emissive) {
    parameters.emissive = new THREE.Color(validColor(object.color) ? object.color : preset.color);
    parameters.emissiveIntensity = .8;
  }
  return new THREE.MeshStandardMaterial(parameters);
}

function renderModel() {
  if (!modelGroup) return;
  while (modelGroup.children.length) {
    const child = modelGroup.children[0];
    modelGroup.remove(child);
    disposeMesh(child);
  }
  state.objects.forEach((object) => {
    const mesh = new THREE.Mesh(makeGeometry(object.type, object.detail), makeMaterial(object));
    mesh.name = object.name;
    mesh.userData = { isModelObject: true, objectId: object.id };
    mesh.position.set(...object.position);
    mesh.rotation.set(...object.rotation);
    mesh.scale.set(...object.scale);
    mesh.castShadow = object.material !== 'glass';
    mesh.receiveShadow = true;
    if (object.material === 'glass') mesh.renderOrder = 1;
    modelGroup.add(mesh);
  });
  updateSelectionVisual();
  updateHoverVisual();
  publishSelectionContext();
}

function raycastCanvas(event) {
  if (!viewportReady) return null;
  const rect = renderer.domElement.getBoundingClientRect();
  const pointer = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(pointer, camera);
  return raycaster;
}

function objectHitFromPointer(event) {
  const raycaster = raycastCanvas(event);
  if (!raycaster) return null;
  const intersections = raycaster.intersectObjects(modelGroup.children, false);
  return intersections.length ? intersections[0].object : null;
}

function beginCanvasPointer(event) {
  if (event.shiftKey) {
    const mesh = objectHitFromPointer(event);
    const objectId = mesh?.userData?.objectId;
    if (objectId) {
      if (!guardHumanEdit(objectId)) return;
      const object = state.objects.find((candidate) => candidate.id === objectId);
      dragState = {
        id: objectId,
        before: snapshotScene(),
        plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), -object.position[1]),
        pointerId: event.pointerId
      };
      controls.enabled = false;
      renderer.domElement.setPointerCapture?.(event.pointerId);
      renderer.domElement.style.cursor = 'grabbing';
      event.preventDefault();
      event.stopImmediatePropagation();
      setCanvasMessage(`Moving ${object.name} — release to commit`);
      return;
    }
  }
  pointerDown = { x: event.clientX, y: event.clientY };
}

function moveCanvasPointer(event) {
  if (!dragState) {
    if (!pointerDown) setHoveredObject(objectHitFromPointer(event)?.userData?.objectId || null);
    return;
  }
  if (event.pointerId !== dragState.pointerId) return;
  const target = new THREE.Vector3();
  if (!raycastCanvas(event).ray.intersectPlane(dragState.plane, target)) return;
  const object = state.objects.find((candidate) => candidate.id === dragState.id);
  const mesh = modelGroup.children.find((candidate) => candidate.userData.objectId === dragState.id);
  if (!object || !mesh) return;
  object.position[0] = Number(target.x.toFixed(2));
  object.position[2] = Number(target.z.toFixed(2));
  mesh.position.set(...object.position);
  updateSelectionVisual();
  event.preventDefault();
}

function endCanvasPointer(event) {
  if (dragState && (event.pointerId === dragState.pointerId || event.type === 'pointercancel')) {
    const drag = dragState;
    dragState = null;
    controls.enabled = true;
    try { renderer.domElement.releasePointerCapture?.(event.pointerId); } catch (_) { /* Pointer may already be released. */ }
    renderer.domElement.style.cursor = '';
    const entry = recordTransaction({ label: `Moved ${objectNameForId(drag.id)}`, source: 'human', why: 'Human repositioned a form directly in the viewport.' }, drag.before);
    if (entry) {
      refreshUI({ scene: true });
      addActivity(`Moved ${objectNameForId(drag.id)}`, 'Human used Shift + drag to reposition a form in the viewport.', 'human');
      setCanvasMessage(`${objectNameForId(drag.id)} moved`);
    }
    return;
  }
  if (!pointerDown) return;
  const travel = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y);
  pointerDown = null;
  if (travel < 6) selectFromPointer(event);
}

function selectFromPointer(event) {
  const mesh = objectHitFromPointer(event);
  selectObject(mesh?.userData?.objectId || null);
}
function selectObject(id) {
  state.selectedId = state.objects.some((object) => object.id === id) ? id : null;
  renderObjectList();
  renderInspector();
  updateSelectionVisual();
  updateHoverVisual();
  publishSelectionContext();
  if (state.selectedId) {
    const selected = getSelectedObject();
    setCanvasMessage(`${selected.name} selected`);
  }
}

function getSelectedObject() {
  return state.objects.find((object) => object.id === state.selectedId) || null;
}

function getHoveredObject() {
  return state.objects.find((object) => object.id === state.hoveredId) || null;
}

function getInteractionTarget(preferHover = false) {
  // A deliberate click is normally strongest context. When the human says “that”,
  // active spatial pointing wins so voice + hover feels naturally grounded.
  const selected = getSelectedObject();
  const hovered = getHoveredObject();
  return preferHover ? (hovered || selected) : (selected || hovered);
}

function getLiveAgentContext() {
  const readable = state.permissions.read;
  const selected = readable ? getSelectedObject() : null;
  const pointed = readable ? getHoveredObject() : null;
  return {
    read_permission: readable,
    selected_object: clone(selected),
    pointed_object: clone(pointed),
    gesture: pointed ? { type: 'pointing_at', object_id: pointed.id } : null,
    selection_revision: state.selectionRevision,
    selection_updated_at: state.selectionContext.updated_at,
    timeline_preview_active: state.timeTravel.active,
    active_locks: Object.entries(state.locks).map(([objectId, lock]) => ({ object_id: objectId, ...lock })),
    pending_proposal_id: state.pendingProposal?.id || null,
    pending_proposal_status: state.pendingProposal?.status || null
  };
}

function publishSelectionContext() {
  const selected = getSelectedObject();
  const pointed = getHoveredObject();
  state.selectionRevision += 1;
  state.selectionContext = {
    selected_object: clone(selected),
    pointed_object: clone(pointed),
    revision: state.selectionRevision,
    updated_at: Date.now()
  };
  els.selectionContextValue.textContent = selected ? selected.name : pointed ? `Pointing at ${pointed.name}` : 'No object selected';
  els.selectionContextRevision.textContent = `context v${state.selectionRevision}`;
  els.selectionContext.classList.toggle('has-selection', Boolean(selected || pointed));

  // Local and native integrations can subscribe instead of guessing whether a selection changed.
  const detail = getLiveAgentContext();
  window.dispatchEvent(new CustomEvent('webmcp-selection-context', { detail }));
  const bridge = navigator.modelContext;
  const publish = bridge?.setContext || bridge?.updateContext;
  if (typeof publish === 'function') {
    try { Promise.resolve(publish.call(bridge, { selection_context: detail })).catch(() => {}); }
    catch (_) { /* Optional native context APIs are not available in every implementation. */ }
  }
}

function isObjectLocked(id) {
  return Boolean(id && state.locks[id]);
}

function describeLock(id) {
  const lock = state.locks[id];
  return lock ? `Orbit is applying step ${lock.step} of ${lock.total} to this form.` : '';
}

function guardHumanEdit(id) {
  if (state.timeTravel.active) {
    setCanvasMessage('Return to the live scene before editing');
    showToast('Time-travel preview is read-only', 'error');
    return false;
  }
  // A streamed agent run is one atomic history transaction. Selection and comments remain live,
  // but model mutations wait for a safe boundary so unrelated human edits are never swallowed
  // into the agent batch.
  if (state.activeRun) {
    const message = isObjectLocked(id)
      ? describeLock(id)
      : 'Orbit is streaming an atomic scene update. Interrupt the run to edit another form.';
    setCanvasMessage(message || 'This form is temporarily locked while Orbit edits it.');
    showToast('Scene edit paused while the agent run is in progress', 'error');
    return false;
  }
  return true;
}

function actionTargetIds(action) {
  if (action.objectIds?.length) return action.objectIds;
  if (action.objectId) return [action.objectId];
  if (action.kind === 'symmetrize' || action.kind === 'restore_version') return state.objects.map((object) => object.id);
  return [];
}

function lockActionObjects(actions, runId) {
  actions.forEach((action, index) => {
    actionTargetIds(action).forEach((id) => {
      if (state.objects.some((object) => object.id === id)) state.locks[id] = { run_id: runId, step: index + 1, total: actions.length, reason: actionLabel(action) };
    });
  });
  renderObjectList();
  renderInspector();
}

function unlockRunObjects(runId) {
  Object.entries(state.locks).forEach(([id, lock]) => { if (lock.run_id === runId) delete state.locks[id]; });
  renderObjectList();
  renderInspector();
}

function setHoveredObject(id) {
  window.clearTimeout(hoverClearTimer);
  const nextId = state.objects.some((object) => object.id === id) ? id : null;
  if (nextId === state.hoveredId) return;
  state.hoveredId = nextId;
  updateHoverVisual();
  publishSelectionContext();
}

function updateHoverVisual() {
  if (!hoverBox) return;
  const hovered = getHoveredObject();
  const mesh = hovered && modelGroup.children.find((child) => child.userData.objectId === hovered.id);
  if (!mesh || hovered?.id === state.selectedId) {
    hoverBox.visible = false;
  } else {
    hoverBox.setFromObject(mesh);
    hoverBox.visible = true;
  }
  els.gestureHud.classList.toggle('active', Boolean(hovered));
  els.gestureHudName.textContent = hovered ? `Pointing at ${hovered.name} · say “make that…”` : 'Point at a form to ground “that”';
}

function updateSelectionVisual() {
  if (!selectionBox) return;
  const selected = getSelectedObject();
  const mesh = selected && modelGroup.children.find((child) => child.userData.objectId === selected.id);
  if (!mesh) {
    selectionBox.visible = false;
    els.selectionHud.classList.add('hidden');
    return;
  }
  selectionBox.setFromObject(mesh);
  selectionBox.visible = true;
  els.selectionHudName.textContent = selected.name;
  els.selectionHud.classList.remove('hidden');
}

function updateCameraReadout() {
  if (!camera || !els.cameraReadout) return;
  const distance = camera.position.distanceTo(controls.target);
  els.cameraReadout.textContent = `ISO ${distance.toFixed(1).padStart(4, '0')}`;
}

function resetView() {
  if (!viewportReady) return;
  camera.position.set(8.4, 6.4, 9.5);
  controls.target.set(0, 1.2, 0);
  controls.update();
  setCanvasMessage('Isometric view restored');
}

function focusScene() {
  if (!viewportReady) return;
  if (!state.objects.length) {
    resetView();
    return;
  }
  const box = new THREE.Box3().setFromObject(modelGroup);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z, 1);
  const distance = maxDimension / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.65;
  const direction = new THREE.Vector3(1, .72, 1).normalize();
  camera.position.copy(center.clone().add(direction.multiplyScalar(distance)));
  controls.target.copy(center);
  controls.update();
  setCanvasMessage('Focused complete scene');
}

/* UI rendering */
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function refreshUI({ scene = false } = {}) {
  if (scene) renderModel();
  renderObjectList();
  renderInspector();
  renderConstraints();
  renderComments();
  renderProjectMemory();
  renderVersions();
  renderProposal();
  renderActivity();
  renderPermissionTier();
  updateSummary();
}

function updateSummary() {
  const count = state.objects.length;
  els.objectCountTop.textContent = `${count} object${count === 1 ? '' : 's'}`;
  els.sceneSummaryCount.textContent = String(count).padStart(2, '0');
  els.sceneSummaryText.textContent = count ? `${count} form${count === 1 ? '' : 's'} in shared scene` : 'Ready for an idea';
  els.emptyCanvas.classList.toggle('hidden', count > 0);
  els.planCount.textContent = state.pendingProposal ? '1' : '0';
}

function renderObjectList() {
  els.objectList.replaceChildren();
  if (!state.objects.length) {
    els.objectList.append(node('p', 'object-list-empty', 'Your forms will appear here. Add a primitive or ask Orbit to plan a design.'));
    return;
  }
  state.objects.forEach((object) => {
    const locked = isObjectLocked(object.id);
    const button = node('button', `object-row${object.id === state.selectedId ? ' active' : ''}${locked ? ' locked' : ''}`);
    button.type = 'button';
    button.dataset.objectId = object.id;
    button.title = locked ? describeLock(object.id) : object.name;
    const symbol = node('span', 'object-row-symbol', TYPE_SYMBOLS[object.type] || '◇');
    const name = node('span', 'object-row-name', object.name);
    const type = node('span', 'object-row-type', object.type);
    button.append(symbol, name, type);
    if (locked) button.append(node('span', 'object-row-lock', '⌁'));
    button.addEventListener('click', () => selectObject(object.id));
    els.objectList.append(button);
  });
}

function renderInspector() {
  const object = getSelectedObject();
  const locked = object && isObjectLocked(object.id);
  els.selectedStatus.textContent = object ? (locked ? 'Locked' : 'Active') : 'None';
  els.inspectorEmpty.classList.toggle('hidden', Boolean(object));
  els.inspectorContent.classList.toggle('hidden', !object);
  if (!object) return;

  els.nameInput.value = object.name;
  els.nameInput.disabled = locked;
  els.typeBadge.textContent = TYPE_LABELS[object.type];
  els.objectId.textContent = object.id;
  $$('.number-input[data-transform]').forEach((input) => {
    const vector = object[input.dataset.transform];
    input.value = Number(vector[Number(input.dataset.axis)]).toFixed(2);
    input.disabled = locked;
  });
  $$('.material-chips button').forEach((button) => {
    button.classList.toggle('active', button.dataset.material === object.material);
    button.disabled = locked;
  });
  $$('.color-swatch').forEach((button) => {
    button.classList.toggle('active', button.dataset.color.toLowerCase() === object.color.toLowerCase());
    button.disabled = locked;
  });
  $('#object-color-input').value = validColor(object.color) ? object.color : MATERIALS[object.material].color;
  $('#object-color-input').disabled = locked;

  const surface = materialSummary(object);
  $$('#texture-chips button').forEach((button) => {
    button.classList.toggle('active', button.dataset.texture === object.texture);
    button.disabled = locked;
  });
  $$('#detail-chips button').forEach((button) => {
    button.classList.toggle('active', button.dataset.detail === object.detail);
    button.disabled = locked;
  });
  $('#object-triangles').textContent = estimateTriangles(object).toLocaleString();
  const setSlider = (selector, value, format) => {
    const input = $(selector);
    input.value = String(value);
    input.disabled = locked || (selector === '#texture-scale-input' && object.texture === 'none');
    $(`${selector}-value`.replace('-input-value', '-value')).textContent = format(value);
  };
  setSlider('#texture-scale-input', object.textureScale, (value) => `${value.toFixed(2)}×`);
  setSlider('#roughness-input', surface.roughness, (value) => value.toFixed(2));
  setSlider('#metalness-input', surface.metalness, (value) => value.toFixed(2));
  $('#duplicate-btn').disabled = locked;
  $('#delete-btn').disabled = locked;
}

function renderConstraints() {
  els.constraintList.replaceChildren();
  state.constraints.forEach((constraint) => {
    const row = node('div', 'constraint-row');
    row.append(node('i'), node('span', '', constraint.label || titleCase(constraint.type)));
    const remove = node('button', '', '×');
    remove.type = 'button';
    remove.title = 'Remove constraint';
    remove.addEventListener('click', () => removeConstraint(constraint.id));
    row.append(remove);
    els.constraintList.append(row);
  });
}

function renderComments() {
  els.commentList.replaceChildren();
  const selectedComments = state.selectedId ? state.comments.filter((comment) => comment.objectId === state.selectedId) : state.comments.slice(-3);
  if (!selectedComments.length) {
    els.commentList.append(node('p', 'comment-empty', state.selectedId ? 'No annotations on this form yet.' : 'Select a form to leave a focused note.'));
    return;
  }
  selectedComments.slice(-5).reverse().forEach((comment) => {
    const item = node('article', 'comment-item');
    item.append(node('strong', '', comment.author || 'Human collaborator'), node('p', '', comment.text));
    els.commentList.append(item);
  });
}

function renderProjectMemory() {
  els.preferenceChips.replaceChildren();
  els.personaSelect.value = state.designContext.persona || 'Adaptive co-designer';
  els.personaSelect.disabled = state.timeTravel.active;
  const preferences = state.designContext.preferences || [];
  if (!preferences.length) {
    els.preferenceChips.append(node('span', 'preference-empty', 'No saved preferences'));
    return;
  }
  preferences.slice(-3).forEach((preference) => {
    const chip = node('button', 'preference-chip');
    chip.type = 'button';
    chip.disabled = state.timeTravel.active;
    chip.title = `Forget preference: ${preference}`;
    chip.append(node('span', '', preference), node('i', '', '×'));
    chip.addEventListener('click', () => removePreference(preference));
    els.preferenceChips.append(chip);
  });
}

function renderVersions() {
  els.versionList.replaceChildren();
  state.versions.forEach((version) => {
    const button = node('button', `version-button${version.id === state.currentVersionId ? ' active' : ''}`);
    button.type = 'button';
    button.title = `Restore ${version.label}`;
    button.append(node('i'), node('span', '', version.label));
    button.addEventListener('click', () => requestRestoreVersion(version.id));
    els.versionList.append(button);
  });
}

function actionLabel(action) {
  if (action.kind === 'add') return `Add ${action.object.name || TYPE_LABELS[action.object.type] || 'form'}`;
  if (action.kind === 'modify') return action.label || `Refine ${objectNameForId(action.objectId)}`;
  if (action.kind === 'delete') return `Remove ${objectNameForId(action.objectId)}`;
  if (action.kind === 'symmetrize') return 'Balance mirrored forms';
  if (action.kind === 'snap') return 'Snap selected forms to grid';
  if (action.kind === 'add_constraint') return `Add ${action.constraint.label || titleCase(action.constraint.type)} constraint`;
  if (action.kind === 'restore_version') return `Restore ${action.versionLabel || 'saved version'}`;
  if (action.kind === 'export') return 'Export STL model';
  if (action.kind === 'share') return 'Create shareable scene link';
  return 'Refine shared scene';
}

function actionCounts(actions) {
  return actions.filter((action) => action.enabled !== false).reduce((counts, action) => {
    if (action.kind === 'add') counts.add += 1;
    else if (action.kind === 'delete') counts.remove += 1;
    else counts.change += 1;
    return counts;
  }, { add: 0, change: 0, remove: 0 });
}

function renderProposal() {
  els.proposalSlot.replaceChildren();
  const proposal = state.pendingProposal;
  if (!proposal) return;

  const isDraft = proposal.status === 'draft';
  const isRunning = proposal.status === 'applying';
  const isApplied = proposal.status === 'applied' || proposal.status === 'interrupted';
  const card = node('section', `proposal-card${isApplied ? ' applied' : ''}${isRunning ? ' streaming' : ''}`);
  const heading = node('div', 'proposal-heading');
  const headingCopy = node('div');
  headingCopy.append(node('span', 'eyebrow', isApplied ? 'Completed agent run' : isRunning ? 'Live agent build' : 'Agent proposal'), node('h3', '', proposal.title));
  const stateCopy = isRunning ? 'Building live' : proposal.status === 'interrupted' ? 'Partial run' : isApplied ? 'Reversible' : 'Choose actions';
  heading.append(headingCopy, node('span', 'proposal-state', stateCopy));
  card.append(heading, node('p', 'proposal-description', proposal.description));

  if (isDraft) {
    const chooser = node('div', 'proposal-selection-controls');
    chooser.append(node('span', '', 'Choose individual operations'));
    const all = node('button', '', 'All');
    const none = node('button', '', 'None');
    all.type = 'button';
    none.type = 'button';
    all.addEventListener('click', () => { proposal.actions.forEach((action) => { action.enabled = true; }); renderProposal(); });
    none.addEventListener('click', () => { proposal.actions.forEach((action) => { action.enabled = false; }); renderProposal(); });
    chooser.append(all, none);
    card.append(chooser);
  }

  const steps = node('div', 'plan-steps granular-steps');
  proposal.actions.forEach((action, index) => {
    const step = node(isDraft ? 'label' : 'div', `plan-step granular-step${isDraft ? ' has-toggle' : ' no-toggle'}${action.enabled === false ? ' disabled' : ''}${action.status === 'complete' ? ' complete' : ''}${action.status === 'running' ? ' running' : ''}${action.status === 'skipped' ? ' skipped' : ''}`);
    if (isDraft) {
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = action.enabled !== false;
      toggle.setAttribute('aria-label', `Include ${actionLabel(action)}`);
      toggle.addEventListener('change', () => {
        action.enabled = toggle.checked;
        addActivity(`${toggle.checked ? 'Included' : 'Excluded'} ${actionLabel(action)}`, 'Human adjusted one operation before the agent run.', 'human');
        renderProposal();
      });
      step.append(toggle);
    }
    const number = node('i', '', String(index + 1));
    const copy = node('span', 'plan-step-copy');
    copy.append(node('strong', '', actionLabel(action)));
    if (isRunning || isApplied) copy.append(node('small', '', action.status === 'running' ? 'Applying now…' : action.status === 'complete' ? 'Built' : action.status === 'skipped' ? 'Skipped by you' : 'Waiting'));
    step.append(number, copy);
    if (isRunning && action.status === 'running') step.append(node('em', 'stream-dot'));
    steps.append(step);
  });
  card.append(steps);

  const counts = actionCounts(proposal.actions);
  const diff = node('div', 'proposal-diff');
  if (counts.add) diff.append(node('span', 'diff-pill add', `+ ${counts.add} form${counts.add === 1 ? '' : 's'}`));
  if (counts.change) diff.append(node('span', 'diff-pill change', `~ ${counts.change} refinement${counts.change === 1 ? '' : 's'}`));
  if (counts.remove) diff.append(node('span', 'diff-pill remove', `− ${counts.remove} removal${counts.remove === 1 ? '' : 's'}`));
  if (!counts.add && !counts.change && !counts.remove) diff.append(node('span', 'diff-pill', 'No operations selected'));
  card.append(diff);

  const why = node('p', 'proposal-why');
  why.append(node('strong', '', 'Why:'), node('span', '', proposal.why || 'It follows the current design direction.'));
  card.append(why);

  if (isDraft) {
    const actions = node('div', 'proposal-actions');
    const approve = node('button', 'button button-primary', 'Apply selected');
    approve.type = 'button';
    approve.disabled = !proposal.actions.some((action) => action.enabled !== false);
    approve.addEventListener('click', executePendingProposal);
    const refine = node('button', 'button button-quiet', 'Modify');
    refine.type = 'button';
    refine.addEventListener('click', () => {
      els.agentInput.focus();
      els.agentInput.placeholder = 'Tell Orbit what to adjust in this plan…';
      setCanvasMessage('Describe the adjustment before you approve');
    });
    const reject = node('button', 'button button-quiet', 'Reject all');
    reject.type = 'button';
    reject.addEventListener('click', discardDraftProposal);
    actions.append(approve, refine, reject);
    card.append(actions);
  } else if (isRunning) {
    const actions = node('div', 'proposal-actions applied-actions');
    const interrupt = node('button', 'button button-danger', 'Interrupt run');
    interrupt.type = 'button';
    interrupt.addEventListener('click', interruptActiveRun);
    const progress = node('button', 'button button-quiet', `${proposal.completedCount || 0}/${proposal.selectedCount || 0} live`);
    progress.type = 'button';
    progress.disabled = true;
    actions.append(interrupt, progress);
    card.append(actions);
  } else if (isApplied) {
    const actions = node('div', `proposal-actions applied-actions${proposal.historyEntryId ? '' : ' single-action'}`);
    const keep = node('button', 'button button-primary', proposal.status === 'interrupted' ? 'Keep partial run' : proposal.historyEntryId ? 'Keep changes' : 'Done');
    keep.type = 'button';
    keep.addEventListener('click', keepAppliedProposal);
    actions.append(keep);
    if (proposal.historyEntryId) {
      const undo = node('button', 'button button-quiet', 'Undo agent run');
      undo.type = 'button';
      undo.addEventListener('click', revertLastAgentRun);
      actions.append(undo);
    }
    card.append(actions);
  }
  els.proposalSlot.append(card);
}
function renderTimelineScrubber() {
  const max = Math.max(0, state.activity.length - 1);
  const activeIndex = state.timeTravel.active ? state.activity.findIndex((event) => event.id === state.timeTravel.eventId) : 0;
  els.timeTravelRange.max = String(max);
  els.timeTravelRange.value = String(Math.max(0, activeIndex));
  els.timeTravelRange.disabled = !state.activity.length;
  const inspected = state.timeTravel.active ? state.activity[activeIndex] : null;
  els.timeTravelCaption.textContent = inspected
    ? `Previewing ${new Date(inspected.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}: ${inspected.title}`
    : state.activity.length ? 'Latest scene is live. Drag backward or select an event to inspect its snapshot.' : 'Select a timeline event to inspect its scene snapshot.';
  els.exitTimeTravelButton.classList.toggle('hidden', !state.timeTravel.active);
}

function enterTimeTravel(index) {
  if (state.activeRun) {
    setCanvasMessage('Interrupt the live agent run before inspecting a historical state');
    return;
  }
  const event = state.activity[index];
  if (!event?.snapshot) {
    setCanvasMessage('No scene snapshot was captured for that event');
    return;
  }
  if (!state.timeTravel.active) state.timeTravel.liveSnapshot = snapshotScene();
  hydrateScene(clone(event.snapshot));
  state.timeTravel.active = true;
  state.timeTravel.eventId = event.id;
  state.hoveredId = null;
  els.timeTravelOverlayTitle.textContent = `${new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${event.title}`;
  els.timeTravelOverlay.classList.remove('hidden');
  setAgentStatus('waiting', 'Inspecting a historical scene state', 'Edits are paused while time-travel preview is active.');
  refreshUI({ scene: true });
}

function exitTimeTravel() {
  if (!state.timeTravel.active || !state.timeTravel.liveSnapshot) return;
  const liveSnapshot = state.timeTravel.liveSnapshot;
  state.timeTravel = { active: false, eventId: null, liveSnapshot: null };
  hydrateScene(liveSnapshot);
  state.hoveredId = null;
  els.timeTravelOverlay.classList.add('hidden');
  setAgentStatus('ready', 'Returned to the live scene', 'You can edit, direct Orbit, or inspect another point in the timeline.');
  refreshUI({ scene: true });
  setCanvasMessage('Returned to the latest shared scene');
}

function renderActivity() {
  els.activityList.replaceChildren();
  els.activityCount.textContent = String(state.activity.length);
  renderTimelineScrubber();
  if (!state.activity.length) {
    els.activityList.append(node('p', 'activity-empty', 'Every agent and human operation will appear here with its reason.'));
    return;
  }
  state.activity.slice(0, 35).forEach((event, index) => {
    const isActivePreview = state.timeTravel.active && state.timeTravel.eventId === event.id;
    const item = node(event.snapshot ? 'button' : 'article', `activity-item ${event.source || ''}${event.snapshot ? ' previewable' : ''}${isActivePreview ? ' previewing' : ''}`);
    if (event.snapshot) {
      item.type = 'button';
      item.title = 'Inspect this scene snapshot';
      item.addEventListener('click', () => enterTimeTravel(index));
    }
    item.append(node('i'));
    const copy = node('div');
    copy.append(node('strong', '', event.title), node('p', '', event.detail));
    const time = node('time', '', new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    item.append(copy, time);
    els.activityList.append(item);
  });
}

function addActivity(title, detail, source = 'agent', metadata = {}) {
  const snapshot = state.timeTravel.active ? null : snapshotScene();
  state.activity.unshift({
    id: makeId('event'),
    title,
    detail,
    source,
    timestamp: Date.now(),
    snapshot,
    tool_call: metadata.tool_call || null
  });
  if (state.activity.length > 80) state.activity.pop();
  renderActivity();
}

function addMessage(role, text) {
  const message = node('article', `message ${role === 'human' ? 'human-message' : 'agent-message'}`);
  if (role !== 'human') message.append(node('div', 'message-avatar', '✦'));
  const bubble = node('div', 'message-bubble');
  bubble.append(node('span', 'message-label', role === 'human' ? 'You' : 'Orbit Agent'), node('p', '', text));
  message.append(bubble);
  els.conversation.append(message);
  requestAnimationFrame(() => { els.conversation.parentElement.scrollTop = els.conversation.parentElement.scrollHeight; });
}

function setAgentStatus(mode, title, copy) {
  els.agentStatusCard.classList.remove('ready', 'thinking', 'waiting', 'blocked');
  els.agentStatusCard.classList.add(mode);
  els.agentStatusTitle.textContent = title;
  els.agentStatusCopy.textContent = copy;
  els.topStatus.textContent = mode === 'thinking' ? 'Agent thinking' : mode === 'waiting' ? 'Awaiting approval' : mode === 'blocked' ? 'Action blocked' : 'Agent ready';
}

function renderPermissionTier() {
  let label = 'Guided creation';
  let copy = 'Orbit may prepare create and modify work; you approve every plan.';
  if (!state.permissions.read) {
    label = 'Private canvas';
    copy = 'Scene reading is off, so Orbit cannot inspect the model.';
  } else if (!state.permissions.create && !state.permissions.modify) {
    label = 'Observe only';
    copy = 'Orbit may inspect and review, but cannot prepare geometry edits.';
  } else if (state.permissions.delete || state.permissions.export || state.permissions.share) {
    label = 'Extended, approval-gated';
    copy = 'Extra capabilities are enabled, while delete, export, and share remain explicit approval steps.';
  }
  els.permissionTierLabel.textContent = label;
  els.permissionTierCopy.textContent = copy;
}

function setCanvasMessage(message) {
  els.canvasMessage.textContent = message;
  window.clearTimeout(els.canvasMessage._timer);
  els.canvasMessage._timer = window.setTimeout(() => { els.canvasMessage.textContent = ''; }, 3200);
}

function showToast(message, type = 'success') {
  els.toastCopy.textContent = message;
  els.toast.classList.toggle('error', type === 'error');
  els.toast.style.opacity = '1';
  els.toast.style.transform = 'translateY(0)';
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    els.toast.style.opacity = '.74';
  }, 4200);
}

function initialiseVoiceInput() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    els.voiceButton.disabled = true;
    els.voiceStatus.textContent = '⌁ Hover grounding ready · voice unavailable here';
    return;
  }
  speechRecognition = new Recognition();
  speechRecognition.lang = navigator.language || 'en-IN';
  speechRecognition.interimResults = true;
  speechRecognition.continuous = false;
  speechRecognition.onstart = () => {
    els.voiceButton.classList.add('listening');
    els.voiceStatus.textContent = '● Listening — point at a form, then speak';
    setAgentStatus('thinking', 'Listening for your direction', 'Your pointer and selected form are retained as live spatial context.');
  };
  speechRecognition.onresult = (event) => {
    const transcript = [...event.results].map((result) => result[0].transcript).join(' ').trim();
    els.agentInput.value = transcript;
    const isFinal = [...event.results].some((result) => result.isFinal);
    if (isFinal && transcript) handleAgentRequest(transcript);
  };
  speechRecognition.onerror = (event) => {
    const expectedAbort = event.error === 'aborted' || event.error === 'no-speech';
    els.voiceStatus.textContent = expectedAbort ? '⌁ Voice cancelled · hover grounding ready' : `⌁ Voice input: ${event.error}`;
    if (!expectedAbort) showToast(`Voice input error: ${event.error}`, 'error');
  };
  speechRecognition.onend = () => {
    els.voiceButton.classList.remove('listening');
    if (!els.voiceStatus.textContent.includes('error')) els.voiceStatus.textContent = '⌁ Voice + hover grounding ready';
  };
}

function toggleVoiceInput() {
  if (!speechRecognition) {
    showToast('Voice recognition is not available in this browser', 'error');
    return;
  }
  try {
    if (els.voiceButton.classList.contains('listening')) speechRecognition.stop();
    else speechRecognition.start();
  } catch (_) {
    // Calling start twice can throw in some Chromium builds; stopping is safest.
    speechRecognition.stop();
  }
}

/* Object creation and edits */
function createPrimitive(type, overrides = {}, source = 'human') {
  if (!TYPES.includes(type)) throw new Error(`Unsupported primitive: ${type}`);
  if (source === 'human' && !guardHumanEdit()) return null;
  let created;
  const spreadIndex = state.objects.length % 5;
  const defaultX = state.objects.length ? (spreadIndex - 2) * .64 : 0;
  const fallback = defaultPosition(type);
  const object = normaliseObject({
    type,
    name: overrides.name || nextObjectName(type),
    position: overrides.position || [defaultX, fallback[1], 0],
    rotation: overrides.rotation || defaultRotation(type),
    scale: overrides.scale || [1, 1, 1],
    material: overrides.material || 'plastic',
    color: overrides.color,
    tags: overrides.tags || []
  });
  const result = applyMutation({ label: `Added ${object.name}`, source, why: 'A new form was added to the shared scene.' }, () => {
    state.objects.push(object);
    state.selectedId = object.id;
    created = object;
  });
  if (result.changed) {
    addActivity(`Added ${object.name}`, source === 'agent' ? 'Agent created a requested form.' : 'Human added a form by hand.', source);
    setCanvasMessage(`${object.name} added`);
  }
  return created;
}

/*
 * Sanitise an incoming patch once, so a human inspector edit, an agent tool call and a
 * streamed proposal operation can never diverge in what they are allowed to change.
 */
function sanitisePatch(object, patch = {}) {
  const cleanPatch = {};
  if (typeof patch.name === 'string' && patch.name.trim()) cleanPatch.name = patch.name.trim().slice(0, 48);
  if (TYPES.includes(patch.type)) cleanPatch.type = patch.type;
  if (patch.position) cleanPatch.position = cleanVector(patch.position, object.position);
  if (patch.rotation) cleanPatch.rotation = cleanVector(patch.rotation, object.rotation, { min: -Math.PI * 8, max: Math.PI * 8 });
  if (patch.scale) cleanPatch.scale = cleanVector(patch.scale, object.scale, { min: .05, max: 30 });
  if (MATERIALS[patch.material]) cleanPatch.material = patch.material;
  if (validColor(patch.color)) cleanPatch.color = patch.color;
  if (TEXTURES[patch.texture]) cleanPatch.texture = patch.texture;
  if (isNumber(patch.textureScale)) cleanPatch.textureScale = clamp(patch.textureScale, .25, 8);
  if (isNumber(patch.roughness)) cleanPatch.roughness = clamp(patch.roughness, 0, 1);
  else if (patch.roughness === null) cleanPatch.roughness = null;
  if (isNumber(patch.metalness)) cleanPatch.metalness = clamp(patch.metalness, 0, 1);
  else if (patch.metalness === null) cleanPatch.metalness = null;
  if (DETAIL_LEVELS[patch.detail]) cleanPatch.detail = patch.detail;
  if (Array.isArray(patch.tags)) cleanPatch.tags = patch.tags.map((tag) => String(tag).slice(0, 32)).slice(0, 12);
  return cleanPatch;
}

function patchObject(objectId, patch, source = 'human', label) {
  const object = state.objects.find((candidate) => candidate.id === objectId);
  if (!object) throw new Error(`Object ${objectId} was not found.`);
  if (source === 'human' && !guardHumanEdit(objectId)) return object;
  const cleanPatch = sanitisePatch(object, patch);

  const result = applyMutation({ label: label || `Refined ${object.name}`, source, why: 'A form was refined in the shared scene.' }, () => Object.assign(object, cleanPatch));
  if (result.changed) addActivity(label || `Refined ${object.name}`, source === 'agent' ? 'Agent applied an approved targeted refinement.' : 'Human refined the selected form.', source);
  return state.objects.find((candidate) => candidate.id === objectId);
}

function duplicateSelected() {
  const selected = getSelectedObject();
  if (!selected) return setCanvasMessage('Select a form to duplicate');
  if (!guardHumanEdit(selected.id)) return;
  const duplicate = clone(selected);
  duplicate.id = makeId('obj');
  duplicate.name = `${selected.name} copy`;
  duplicate.position = [selected.position[0] + .55, selected.position[1] + .2, selected.position[2] + .35];
  const result = applyMutation({ label: `Duplicated ${selected.name}`, source: 'human', why: 'The human collaborator created a variation.' }, () => {
    state.objects.push(normaliseObject(duplicate));
    state.selectedId = duplicate.id;
  });
  if (result.changed) addActivity(`Duplicated ${selected.name}`, 'Human created a nearby variation.', 'human');
}

function deleteSelected() {
  const selected = getSelectedObject();
  if (!selected) return setCanvasMessage('Select a form to delete');
  if (!guardHumanEdit(selected.id)) return;
  if (!window.confirm(`Delete “${selected.name}”? You can undo this change with Ctrl/Cmd + Z.`)) return;
  const result = applyMutation({ label: `Deleted ${selected.name}`, source: 'human', why: 'The human collaborator removed a form.' }, () => {
    state.objects = state.objects.filter((object) => object.id !== selected.id);
    state.comments = state.comments.filter((comment) => comment.objectId !== selected.id);
    state.selectedId = null;
  });
  if (result.changed) addActivity(`Deleted ${selected.name}`, 'Human removed a form from the shared scene.', 'human');
}

function snapSelectedToGrid() {
  const selected = getSelectedObject();
  if (!selected) return setCanvasMessage('Select a form to snap');
  if (!guardHumanEdit(selected.id)) return;
  patchObject(selected.id, {
    position: selected.position.map((value) => Math.round(value)),
    rotation: selected.rotation.map((value) => Math.round(value / (Math.PI / 12)) * (Math.PI / 12))
  }, 'human', `Snapped ${selected.name} to grid`);
  setCanvasMessage(`${selected.name} snapped to grid`);
}

function objectNameForId(id) {
  return state.objects.find((object) => object.id === id)?.name || 'selected form';
}

/* Constraints, comments, and versions */
function addConstraint(type, objectIds = null, source = 'human') {
  if (!['symmetry', 'ground'].includes(type)) throw new Error('Unsupported constraint type.');
  if (source === 'human' && !guardHumanEdit()) return null;
  const existing = state.constraints.find((constraint) => constraint.type === type && JSON.stringify(constraint.objectIds || []) === JSON.stringify(objectIds || []));
  if (existing) {
    setCanvasMessage('That constraint is already active');
    return existing;
  }
  const constraint = {
    id: makeId('constraint'),
    type,
    objectIds: objectIds || null,
    label: type === 'symmetry' ? 'Mirror across center axis' : 'Keep forms on ground plane',
    createdAt: Date.now()
  };
  const result = applyMutation({ label: `Added ${constraint.label}`, source, why: 'A design guardrail was added.' }, () => state.constraints.push(constraint));
  if (result.changed) addActivity(`Constraint active: ${type === 'symmetry' ? 'symmetry' : 'on ground'}`, 'Orbit will include this guardrail in future reviews.', source);
  return constraint;
}

function removeConstraint(id) {
  if (!guardHumanEdit()) return;
  const constraint = state.constraints.find((item) => item.id === id);
  if (!constraint) return;
  const result = applyMutation({ label: `Removed ${constraint.label}`, source: 'human', why: 'The human collaborator removed a guardrail.' }, () => {
    state.constraints = state.constraints.filter((item) => item.id !== id);
  });
  if (result.changed) addActivity(`Removed ${constraint.label}`, 'Human changed the active design guardrails.', 'human');
}

function addComment(text, objectId = state.selectedId, author = 'Human collaborator', source = 'human') {
  if (!objectId || !state.objects.some((object) => object.id === objectId)) throw new Error('Select a form before leaving an annotation.');
  const cleanText = String(text || '').trim().slice(0, 160);
  if (!cleanText) throw new Error('Annotation text is required.');
  const comment = { id: makeId('comment'), objectId, author: String(author).slice(0, 40), text: cleanText, source, createdAt: Date.now(), resolved: false };
  const result = applyMutation({ label: `Annotated ${objectNameForId(objectId)}`, source, why: 'Feedback was attached directly to a form.' }, () => state.comments.push(comment));
  if (result.changed) addActivity(`Annotated ${objectNameForId(objectId)}`, `${author} added in-context feedback.`, source);
  return comment;
}

function createVersion(label, source = 'human', announce = true) {
  if (source === 'human' && !guardHumanEdit()) return null;
  const cleanLabel = String(label || `Checkpoint ${state.versions.length + 1}`).trim().slice(0, 30) || `Checkpoint ${state.versions.length + 1}`;
  const version = { id: makeId('version'), label: cleanLabel, createdAt: Date.now(), snapshot: snapshotScene() };
  state.versions.push(version);
  if (state.versions.length > 12) state.versions.shift();
  state.currentVersionId = version.id;
  renderVersions();
  persistWorkspace();
  if (announce) addActivity(`Saved ${version.label}`, source === 'agent' ? 'Agent saved a comparison point.' : 'Human saved a recoverable design version.', source);
  setCanvasMessage(`${version.label} saved`);
  return version;
}

function findVersionsByLabel(requested) {
  const query = String(requested || '').trim().toLowerCase();
  if (!query) return [];
  const byId = state.versions.filter((version) => version.id.toLowerCase() === query);
  if (byId.length) return byId;
  const exact = state.versions.filter((version) => version.label.toLowerCase() === query);
  if (exact.length) return exact;

  // Fall back to distinguishing tokens only: "checkpoint 2" must not match "checkpoint 3".
  const generic = new Set(['version', 'versions', 'checkpoint', 'checkpoints', 'save', 'saved', 'state', 'scene', 'my', 'the', 'a', 'to', 'back']);
  const tokens = query.split(/\s+/).filter((token) => token && !generic.has(token));
  if (!tokens.length) return [];
  const scored = state.versions
    .map((version) => {
      const label = version.label.toLowerCase();
      const hits = tokens.filter((token) => label.includes(token)).length;
      return { version, hits };
    })
    .filter((candidate) => candidate.hits === tokens.length);
  return scored.map((candidate) => candidate.version);
}

function requestRestoreVersion(id) {
  if (!guardHumanEdit()) return;
  const version = state.versions.find((candidate) => candidate.id === id);
  if (!version || version.id === state.currentVersionId) return;
  if (!window.confirm(`Restore “${version.label}”? Your current state stays in the undo history.`)) return;
  // The version pointer moves inside the transaction so undo restores it with the scene.
  const result = applyMutation({ label: `Restored ${version.label}`, source: 'human', why: 'The human collaborator chose a prior version.' }, () => {
    hydrateScene(version.snapshot);
    state.currentVersionId = version.id;
  });
  if (result.changed) addActivity(`Restored ${version.label}`, 'Human returned to a prior design branch.', 'human');
}

/* Diagnostics: deterministic scene reading for agents and humans */
/*
 * World-space axis-aligned bounds. Nominal half extents are transformed through the
 * object's full rotation so rotated forms report correct intersections, ground checks
 * and review scores instead of their unrotated footprint.
 */
function objectBounds(object) {
  const dimensions = BASE_DIMENSIONS[object.type] || BASE_DIMENSIONS.cube;
  const half = dimensions.map((dimension, index) => Math.abs(dimension * object.scale[index]) / 2);
  const [rx, ry, rz] = object.rotation || [0, 0, 0];
  const isRotated = Math.abs(rx) > 1e-6 || Math.abs(ry) > 1e-6 || Math.abs(rz) > 1e-6;

  let extent = half;
  if (isRotated) {
    // Intrinsic XYZ rotation matrix, matching THREE.Euler's default order.
    const [cx, sx] = [Math.cos(rx), Math.sin(rx)];
    const [cy, sy] = [Math.cos(ry), Math.sin(ry)];
    const [cz, sz] = [Math.cos(rz), Math.sin(rz)];
    const m = [
      [cy * cz, sx * sy * cz - cx * sz, cx * sy * cz + sx * sz],
      [cy * sz, sx * sy * sz + cx * cz, cx * sy * sz - sx * cz],
      [-sy, sx * cy, cx * cy]
    ];
    // For a box, the rotated AABB half extent is |M| * half.
    extent = m.map((row) => row.reduce((total, value, index) => total + Math.abs(value) * half[index], 0));
  }

  return {
    min: object.position.map((value, index) => value - extent[index]),
    max: object.position.map((value, index) => value + extent[index]),
    center: [...object.position],
    size: extent.map((value) => value * 2)
  };
}

function calculateSceneBounds() {
  if (!state.objects.length) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0] };
  const boxes = state.objects.map(objectBounds);
  const min = [0, 1, 2].map((axis) => Math.min(...boxes.map((box) => box.min[axis])));
  const max = [0, 1, 2].map((axis) => Math.max(...boxes.map((box) => box.max[axis])));
  return { min, max, size: max.map((value, index) => Number((value - min[index]).toFixed(2))), center: max.map((value, index) => Number(((value + min[index]) / 2).toFixed(2))) };
}

function boundsOverlap(first, second) {
  return [0, 1, 2].every((axis) => first.min[axis] < second.max[axis] - .045 && first.max[axis] > second.min[axis] + .045);
}

function findOverlaps() {
  const overlaps = [];
  for (let first = 0; first < state.objects.length; first += 1) {
    for (let second = first + 1; second < state.objects.length; second += 1) {
      const a = state.objects[first];
      const b = state.objects[second];
      if (a.type === 'plane' || b.type === 'plane' || a.tags.includes('detail') || b.tags.includes('detail')) continue;
      if (boundsOverlap(objectBounds(a), objectBounds(b))) overlaps.push({ first: a.id, second: b.id });
    }
  }
  return overlaps;
}

function checkSymmetry() {
  const sided = state.objects.filter((object) => Math.abs(object.position[0]) > .22 && !object.tags.includes('asymmetric'));
  if (sided.length < 2) return { score: 100, unmatched: [], pairs: 0 };
  const used = new Set();
  const unmatched = [];
  let pairs = 0;
  sided.forEach((object) => {
    if (used.has(object.id)) return;
    const mirror = sided.find((candidate) => candidate.id !== object.id && !used.has(candidate.id)
      && candidate.type === object.type
      && Math.abs(candidate.position[0] + object.position[0]) < .22
      && Math.abs(candidate.position[1] - object.position[1]) < .28
      && Math.abs(candidate.position[2] - object.position[2]) < .28);
    if (mirror) {
      used.add(object.id);
      used.add(mirror.id);
      pairs += 1;
    } else {
      used.add(object.id);
      unmatched.push(object.id);
    }
  });
  return { score: clamp(Math.round(100 * (1 - unmatched.length / sided.length)), 0, 100), unmatched, pairs };
}

function validateConstraints() {
  const results = [];
  state.constraints.forEach((constraint) => {
    if (constraint.type === 'symmetry') {
      const symmetry = checkSymmetry();
      results.push({ constraint: constraint.label, valid: symmetry.score >= 92, message: symmetry.score >= 92 ? 'Mirrored forms are aligned.' : `${symmetry.unmatched.length} form${symmetry.unmatched.length === 1 ? '' : 's'} has no mirrored partner.`, score: symmetry.score });
    }
    if (constraint.type === 'ground') {
      const floating = state.objects.filter((object) => !object.tags.includes('flying') && object.type !== 'plane' && objectBounds(object).min[1] > .08);
      results.push({ constraint: constraint.label, valid: floating.length === 0, message: floating.length ? `${floating.length} form${floating.length === 1 ? '' : 's'} floats above the ground plane.` : 'All applicable forms meet the ground plane.', objectIds: floating.map((object) => object.id) });
    }
  });
  return results;
}

function findObjectsBySemanticQuery(query) {
  const ignoredWords = new Set(['the', 'a', 'an', 'all', 'my', 'scene', 'object', 'objects', 'please']);
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean).filter((word) => !ignoredWords.has(word)).map((word) => word.endsWith('s') && word.length > 3 ? word.slice(0, -1) : word);
  const aliases = {
    left: ['left', 'port'], right: ['right', 'starboard'], front: ['front', 'forward'], rear: ['rear', 'back'],
    wheel: ['wheel', 'propulsion'], window: ['window', 'glass'], engine: ['engine', 'propulsion']
  };
  return state.objects.filter((object) => {
    const corpus = `${object.name} ${object.type} ${object.material} ${object.tags.join(' ')}`.toLowerCase();
    return words.every((word) => (aliases[word] || [word]).some((term) => corpus.includes(term)));
  });
}

/* A cheap, deterministic triangle estimate so agents can reason about model weight. */
function estimateTriangles(object) {
  const factor = DETAIL_FACTOR[object.detail] ?? 1;
  const base = { cube: 12, sphere: 1600, cylinder: 140, cone: 100, torus: 1100, plane: 2 }[object.type] ?? 12;
  return Math.max(2, Math.round(base * (object.type === 'cube' ? (object.detail === 'high' ? 8 : 1) : factor * factor)));
}

function getSceneStatistics() {
  const bounds = calculateSceneBounds();
  const materials = [...new Set(state.objects.map((object) => object.material))];
  const colors = [...new Set(state.objects.map((object) => object.color.toLowerCase()))];
  const symmetry = checkSymmetry();
  return {
    object_count: state.objects.length,
    selected_object_id: state.selectedId,
    types: state.objects.reduce((result, object) => { result[object.type] = (result[object.type] || 0) + 1; return result; }, {}),
    material_count: materials.length,
    color_count: colors.length,
    textures: state.objects.reduce((result, object) => { result[object.texture] = (result[object.texture] || 0) + 1; return result; }, {}),
    detail_levels: state.objects.reduce((result, object) => { result[object.detail] = (result[object.detail] || 0) + 1; return result; }, {}),
    triangle_estimate: state.objects.reduce((total, object) => total + estimateTriangles(object), 0),
    bounding_box: bounds,
    symmetry_score: symmetry.score,
    constraint_count: state.constraints.length,
    version_count: state.versions.length
  };
}

function analyseDesign() {
  if (!state.objects.length) {
    return {
      score: 0, symmetry: 0, composition: 0, materials: 0, geometry: 0,
      findings: [{ severity: 'info', title: 'Start with a direction', detail: 'Describe a model or add a primitive so Orbit can inspect the scene.' }],
      metric_details: {
        symmetry: { title: 'Symmetry evidence', detail: 'No forms exist yet to compare.', objectIds: [] },
        composition: { title: 'Composition evidence', detail: 'No silhouette exists yet to assess.', objectIds: [] },
        geometry: { title: 'Geometry evidence', detail: 'No structural forms exist yet to validate.', objectIds: [] },
        materials: { title: 'Material evidence', detail: 'No finishes have been assigned yet.', objectIds: [] }
      },
      recommendations: []
    };
  }
  const symmetry = checkSymmetry();
  const overlaps = findOverlaps();
  const bounds = calculateSceneBounds();
  const distinctMaterials = new Set(state.objects.map((object) => object.material)).size;
  const count = state.objects.length;
  const nonZeroBounds = bounds.size.filter((value) => value > .01);
  const smallestDimension = Math.max(Math.min(...nonZeroBounds, 1), .1);
  const aspectRatio = Math.max(...bounds.size) / smallestDimension;
  const composition = clamp(Math.round(56 + Math.min(count, 9) * 4 + (bounds.size[0] > .4 && bounds.size[1] > .4 ? 8 : 0) - (aspectRatio > 12 ? 12 : 0)), 32, 98);
  const materials = clamp(72 + Math.min(distinctMaterials, 3) * 8 - (distinctMaterials > 4 ? 7 : 0), 42, 96);
  const geometry = clamp(96 - overlaps.length * 11, 25, 96);
  const constraintResults = validateConstraints();
  const failedConstraints = constraintResults.filter((result) => !result.valid);
  const score = clamp(Math.round((symmetry.score * .28) + (composition * .25) + (materials * .19) + (geometry * .28) - failedConstraints.length * 3), 0, 99);
  const findings = [];
  const recommendations = [];
  const unmatchedNames = symmetry.unmatched.map(objectNameForId);
  const overlapNames = overlaps.map((pair) => `${objectNameForId(pair.first)} ↔ ${objectNameForId(pair.second)}`);
  const metricDetails = {
    symmetry: {
      title: `Symmetry evidence · ${symmetry.score}%`,
      detail: symmetry.score >= 90
        ? `${symmetry.pairs} mirrored pair${symmetry.pairs === 1 ? '' : 's'} align across the center axis. Centered forms are intentionally ignored.`
        : `Unmatched side form${unmatchedNames.length === 1 ? '' : 's'}: ${unmatchedNames.join(', ') || 'none identified'}. Orbit compares type and mirrored X/Y/Z positions within a small tolerance.`,
      objectIds: symmetry.unmatched
    },
    composition: {
      title: `Composition evidence · ${composition}%`,
      detail: `${count} form${count === 1 ? '' : 's'} spans ${bounds.size.map((value) => value.toFixed(1)).join(' × ')} scene units. The heuristic rewards a readable multi-form silhouette and flags extreme bounding-box ratios.`,
      objectIds: state.objects.map((object) => object.id)
    },
    geometry: {
      title: `Geometry evidence · ${geometry}%`,
      detail: overlaps.length ? `Potential structural intersections: ${overlapNames.join('; ')}. Decorative forms are excluded from this simple bounding-box check.` : 'No potential structural intersections were found between non-decorative forms.',
      objectIds: overlaps.flatMap((pair) => [pair.first, pair.second])
    },
    materials: {
      title: `Material evidence · ${materials}%`,
      detail: `${distinctMaterials} finish${distinctMaterials === 1 ? '' : 'es'} across ${new Set(state.objects.map((object) => object.color.toLowerCase())).size} accent color${new Set(state.objects.map((object) => object.color.toLowerCase())).size === 1 ? '' : 's'}: ${[...new Set(state.objects.map((object) => MATERIALS[object.material]?.label || object.material))].join(', ')}.`,
      objectIds: state.objects.map((object) => object.id)
    }
  };

  findings.push({ severity: symmetry.score >= 90 ? 'success' : 'warning', title: `Symmetry · ${symmetry.score}%`, detail: symmetry.score >= 90 ? 'The side-to-side balance reads consistently.' : `${symmetry.unmatched.length} form${symmetry.unmatched.length === 1 ? '' : 's'} could be mirrored or intentionally offset.`, objectIds: symmetry.unmatched, metric: 'symmetry' });
  if (overlaps.length) {
    findings.push({ severity: 'warning', title: `${overlaps.length} potential intersection${overlaps.length === 1 ? '' : 's'}`, detail: 'Some structural forms occupy the same volume. Inspect them before export.', objectIds: metricDetails.geometry.objectIds, metric: 'geometry' });
  } else {
    findings.push({ severity: 'success', title: 'Clear form spacing', detail: 'No unintentional structural intersections were detected.', objectIds: [], metric: 'geometry' });
  }
  findings.push({ severity: materials >= 88 ? 'success' : 'info', title: `Material clarity · ${materials}%`, detail: distinctMaterials > 1 ? 'The finish palette gives the silhouette readable hierarchy.' : 'A secondary finish could clarify functional accents.', objectIds: metricDetails.materials.objectIds, metric: 'materials' });
  failedConstraints.forEach((result) => findings.push({ severity: 'warning', title: result.constraint, detail: result.message, objectIds: result.objectIds || [], metric: 'constraints' }));
  if (symmetry.score < 92) recommendations.push('Prepare mirrored counterparts for unmatched side forms.');
  if (overlaps.length) recommendations.push('Review the intersecting structural forms before final export.');
  if (distinctMaterials < 2 && count > 2) recommendations.push('Use one accent finish to strengthen visual hierarchy.');

  return { score, symmetry: symmetry.score, composition, materials, geometry, overlaps, findings, recommendations, metric_details: metricDetails, constraint_results: constraintResults };
}

function showMetricDetail(metric) {
  const detail = currentReview?.metric_details?.[metric];
  if (!detail) {
    els.reviewMetricDetail.textContent = 'Select a score to inspect the evidence behind it.';
    return;
  }
  els.reviewMetricDetail.replaceChildren();
  const heading = node('strong', '', detail.title);
  const description = node('p', '', detail.detail);
  const evidence = node('small', '', detail.objectIds?.length ? `Evidence linked to ${detail.objectIds.length} form${detail.objectIds.length === 1 ? '' : 's'} — click a related finding to focus it.` : 'No problematic form needs focus for this metric.');
  els.reviewMetricDetail.append(heading, description, evidence);
  $$('.metric-card[data-metric]').forEach((card) => card.classList.toggle('active', card.dataset.metric === metric));
}

function showDesignReview() {
  currentReview = analyseDesign();
  els.reviewScore.textContent = state.objects.length ? currentReview.score : '—';
  els.reviewSummary.textContent = state.objects.length
    ? `Orbit inspected ${state.objects.length} shared form${state.objects.length === 1 ? '' : 's'} using composition, symmetry, material clarity, and geometry checks.`
    : 'Add a model to receive a visual and geometric review.';
  els.reviewMetrics.replaceChildren();
  [
    ['symmetry', 'Symmetry', currentReview.symmetry], ['composition', 'Composition', currentReview.composition], ['geometry', 'Geometry', currentReview.geometry], ['materials', 'Materials', currentReview.materials]
  ].forEach(([key, label, value]) => {
    const card = node('button', 'metric-card');
    card.type = 'button';
    card.dataset.metric = key;
    card.title = `Show ${label.toLowerCase()} evidence`;
    const meter = node('span', 'metric-meter');
    const fill = node('i');
    fill.style.width = `${value}%`;
    meter.append(fill);
    card.append(node('span', '', label), node('strong', '', state.objects.length ? `${value}%` : '—'), meter);
    card.addEventListener('click', () => showMetricDetail(key));
    els.reviewMetrics.append(card);
  });
  els.reviewFindings.replaceChildren();
  currentReview.findings.forEach((finding) => {
    const canFocusObject = finding.objectIds?.length;
    const item = node(canFocusObject ? 'button' : 'article', `review-finding${finding.severity === 'warning' ? ' warning' : ''}${canFocusObject ? ' focusable' : ''}`);
    if (canFocusObject) {
      item.type = 'button';
      item.title = 'Focus related form in canvas';
      item.addEventListener('click', () => {
        selectObject(finding.objectIds[0]);
        if (finding.metric) showMetricDetail(finding.metric);
        setCanvasMessage(`Focused evidence: ${objectNameForId(finding.objectIds[0])}`);
      });
    }
    item.append(node('i', '', finding.severity === 'warning' ? '!' : finding.severity === 'success' ? '✓' : '•'));
    const copy = node('div');
    copy.append(node('strong', '', finding.title), node('p', '', finding.detail));
    item.append(copy);
    els.reviewFindings.append(item);
  });
  showMetricDetail('symmetry');
  els.applyReviewButton.classList.toggle('hidden', !currentReview.recommendations?.length);
  openModal('review-modal');
  addActivity('Completed design review', state.objects.length ? `Overall collaboration score: ${currentReview.score}/100.` : 'The scene is still empty.', 'agent');
}

function validateScene() {
  const review = analyseDesign();
  const issues = review.findings.filter((finding) => finding.severity === 'warning').map((finding) => ({ severity: 'warning', message: finding.detail, title: finding.title }));
  return { valid: issues.length === 0, issues, review, constraints: validateConstraints(), statistics: getSceneStatistics() };
}

/* Agent planning and human approval */
function detectColor(text) {
  const lower = String(text).toLowerCase();
  return Object.entries(COLOR_WORDS).find(([word]) => new RegExp(`\\b${word}\\b`).test(lower))?.[1] || null;
}

function detectTexture(text) {
  const lower = String(text).toLowerCase();
  if (/\bbrushed\b|\bbrush\b|streak/.test(lower)) return 'brushed';
  if (/\bgrid\b|panel(?:ed|ling)?/.test(lower)) return 'grid';
  if (/\bgrain(?:y)?\b|\bnoise\b|speckle/.test(lower)) return 'noise';
  if (/\bchecker(?:ed|board)?\b/.test(lower)) return 'checker';
  if (/\bhatch(?:ed|ing)?\b|diagonal lines/.test(lower)) return 'hatch';
  if (/\bdot(?:s|ted)\b|perforat/.test(lower)) return 'dots';
  if (/(?:remove|clear|no) (?:the )?texture|untextured|plain surface/.test(lower)) return 'none';
  return null;
}

function detectStyle(text) {
  const lower = String(text).toLowerCase();
  if (/futur|sci[ -]?fi|cyber|space/.test(lower)) return 'Futuristic';
  if (/minimal|simple|clean/.test(lower)) return 'Minimal';
  if (/industrial|heavy|utility/.test(lower)) return 'Industrial';
  if (/organic|soft|nature/.test(lower)) return 'Organic';
  return 'Exploratory';
}

function descriptor(type, name, position, scale, material = 'plastic', color, tags = [], rotation) {
  return {
    kind: 'add',
    object: {
      type, name, position, scale, material,
      color: color || MATERIALS[material]?.color,
      tags,
      rotation: rotation || defaultRotation(type)
    }
  };
}

function rocketPlan(input) {
  const color = detectColor(input) || '#8876ff';
  return {
    title: 'Symmetrical exploration rocket',
    description: 'A clean primitive study with a tall metal body, four balanced fins, and a luminous viewing detail.',
    why: 'A cylindrical body and mirrored fins make the requested rocket readable from every orbit angle.',
    intent: input,
    style: 'Futuristic',
    actions: [
      descriptor('cylinder', 'Rocket body', [0, 2.05, 0], [1.18, 3.85, 1.18], 'metal', color, ['body']),
      descriptor('cone', 'Rocket nose', [0, 4.5, 0], [1.22, 1.55, 1.22], 'metal', color, ['body']),
      descriptor('sphere', 'Navigation window', [0, 2.65, .99], [.45, .45, .45], 'glass', '#8ccff5', ['detail']),
      descriptor('cube', 'Port fin', [-1.15, .78, 0], [.42, .75, 1.34], 'metal', color, ['fin']),
      descriptor('cube', 'Starboard fin', [1.15, .78, 0], [.42, .75, 1.34], 'metal', color, ['fin']),
      descriptor('cube', 'Front fin', [0, .78, 1.15], [1.34, .75, .42], 'metal', color, ['fin']),
      descriptor('cube', 'Rear fin', [0, .78, -1.15], [1.34, .75, .42], 'metal', color, ['fin']),
      descriptor('cylinder', 'Engine glow', [0, .3, 0], [.58, .55, .58], 'emissive', '#52dfc3', ['detail'])
    ]
  };
}

function dronePlan(input) {
  const color = detectColor(input) || '#8876ff';
  const armMaterial = 'metal';
  const actions = [
    descriptor('sphere', 'Compact drone core', [0, 2.42, 0], [2.25, .88, 1.34], 'metal', color, ['body', 'flying']),
    descriptor('cube', 'Drone chassis', [0, 2.24, 0], [3.25, .32, 1.08], armMaterial, color, ['body', 'flying']),
    descriptor('cylinder', 'Port-front propulsion', [-2.12, 2.32, 1.28], [.6, .22, .6], 'metal', color, ['propulsion', 'flying']),
    descriptor('cylinder', 'Starboard-front propulsion', [2.12, 2.32, 1.28], [.6, .22, .6], 'metal', color, ['propulsion', 'flying']),
    descriptor('cylinder', 'Port-rear propulsion', [-2.12, 2.32, -1.28], [.6, .22, .6], 'metal', color, ['propulsion', 'flying']),
    descriptor('cylinder', 'Starboard-rear propulsion', [2.12, 2.32, -1.28], [.6, .22, .6], 'metal', color, ['propulsion', 'flying']),
    descriptor('sphere', 'Forward camera', [0, 1.92, 1.18], [.42, .42, .42], 'glass', '#8ccff5', ['detail', 'flying']),
    descriptor('cube', 'Status beacon', [0, 3.27, 0], [.34, .16, .34], 'emissive', '#52dfc3', ['detail', 'flying'])
  ];
  return {
    title: 'Compact delivery drone',
    description: 'A hovering central body with four balanced propulsion units, a forward camera, and a clear status beacon.',
    why: 'The compact, symmetric layout keeps the requested drone lightweight while making its delivery purpose legible.',
    intent: input,
    style: 'Futuristic',
    actions
  };
}

function robotPlan(input) {
  const color = detectColor(input) || '#8876ff';
  return {
    title: 'Friendly floating robot',
    description: 'A compact robot built from readable primitives, with a glowing face and deliberately balanced arms.',
    why: 'The modular silhouette makes future human edits to its proportions simple and reversible.',
    intent: input,
    style: effectiveStyle(input),
    actions: [
      descriptor('cube', 'Robot torso', [0, 2.25, 0], [1.7, 1.8, .92], 'metal', color, ['body']),
      descriptor('cube', 'Robot head', [0, 3.85, 0], [1.3, 1.05, .92], 'plastic', color, ['body']),
      descriptor('sphere', 'Left eye', [-.34, 3.87, .49], [.16, .16, .16], 'emissive', '#52dfc3', ['detail']),
      descriptor('sphere', 'Right eye', [.34, 3.87, .49], [.16, .16, .16], 'emissive', '#52dfc3', ['detail']),
      descriptor('cylinder', 'Port arm', [-1.23, 2.35, 0], [.28, 1.45, .28], 'metal', color, ['arm'], [0, 0, Math.PI / 2]),
      descriptor('cylinder', 'Starboard arm', [1.23, 2.35, 0], [.28, 1.45, .28], 'metal', color, ['arm'], [0, 0, Math.PI / 2]),
      descriptor('sphere', 'Hover core', [0, 1.08, 0], [.56, .32, .56], 'emissive', '#52dfc3', ['detail', 'flying'])
    ]
  };
}

function genericConceptPlan(input) {
  const color = detectColor(input) || '#8876ff';
  const style = effectiveStyle(input);
  return {
    title: 'Starter concept study',
    description: 'A flexible three-form composition that gives us a body, a focal point, and an accent to refine together.',
    why: 'Starting with a small readable composition lets you redirect the agent without committing to unnecessary geometry.',
    intent: input,
    style,
    actions: [
      descriptor('cube', 'Concept base', [0, .55, 0], [2.4, 1.1, 1.5], style === 'Futuristic' ? 'metal' : 'plastic', color, ['body']),
      descriptor('sphere', 'Concept focal form', [0, 1.65, 0], [1.15, 1.15, 1.15], 'glass', '#8ccff5', ['detail']),
      descriptor('cylinder', 'Concept accent', [0, 2.55, 0], [.35, .7, .35], 'emissive', '#52dfc3', ['detail'])
    ]
  };
}

function selectedEditPlan(input) {
  const lower = input.toLowerCase();
  const selected = getInteractionTarget(/\b(that|there|pointed)\b/.test(lower));
  if (!selected) return null;
  const patch = {};
  let title = `Refine ${selected.name}`;
  let description = `A focused refinement to the currently selected ${selected.type}.`;
  let why = 'Selection-aware editing keeps your instruction anchored to the form you chose.';

  const color = detectColor(lower);
  if (color) {
    patch.color = color;
    if (/metal|metallic|chrome/.test(lower)) patch.material = 'metal';
    title = `Recolor ${selected.name}`;
    description = `Apply a focused ${Object.entries(COLOR_WORDS).find(([, value]) => value === color)?.[0] || 'accent'} finish to the selected form.`;
  }
  // Texture refinement vocabulary
  const texture = detectTexture(lower);
  if (texture) { patch.texture = texture; title = `Apply ${TEXTURES[texture].label.toLowerCase()} texture to ${selected.name}`; description = `Apply the procedural ${TEXTURES[texture].label.toLowerCase()} texture to the selected form.`; }
  if (/\brough(?:er|en)?\b|\bmatte?\b|\bcoarse(?:r)?\b/.test(lower)) { patch.roughness = clamp((isNumber(selected.roughness) ? selected.roughness : MATERIALS[selected.material].roughness) + .25, 0, 1); title = `Roughen ${selected.name}`; }
  if (/\bsmooth(?:er)?\b|\bpolish(?:ed)?\b|\bgloss(?:y)?\b|\bshin(?:y|ier)\b/.test(lower)) { patch.roughness = clamp((isNumber(selected.roughness) ? selected.roughness : MATERIALS[selected.material].roughness) - .28, 0, 1); title = `Polish ${selected.name}`; }
  if (/\b(finer|tighter|smaller) (?:texture|pattern|grain)\b/.test(lower)) { patch.textureScale = clamp(selected.textureScale * 1.8, .25, 8); }
  if (/\b(coarser|bigger|larger) (?:texture|pattern|grain)\b/.test(lower)) { patch.textureScale = clamp(selected.textureScale / 1.8, .25, 8); }
  // Geometry resolution vocabulary
  if (/low[ -]?poly|faceted|fewer (?:polygons|triangles)/.test(lower)) { patch.detail = 'low'; title = `Make ${selected.name} low poly`; }
  if (/high[ -]?(?:poly|res)|denser mesh|more (?:polygons|triangles)|smoother mesh/.test(lower)) { patch.detail = 'high'; title = `Increase ${selected.name} mesh resolution`; }
  if (/\btaller\b|stretch (?:it )?up/.test(lower)) { patch.scale = [selected.scale[0], Number((selected.scale[1] * 1.4).toFixed(2)), selected.scale[2]]; title = `Stretch ${selected.name} taller`; }
  if (/\bwider\b|stretch (?:it )?(?:out|sideways)/.test(lower)) { patch.scale = [Number((selected.scale[0] * 1.4).toFixed(2)), selected.scale[1], selected.scale[2]]; title = `Widen ${selected.name}`; }
  if (/\bflatter\b|squash|flatten/.test(lower)) { patch.scale = [selected.scale[0], Number((selected.scale[1] * .6).toFixed(2)), selected.scale[2]]; title = `Flatten ${selected.name}`; }
  if (/\brotate\b|\bturn\b|\bspin\b/.test(lower)) { patch.rotation = [selected.rotation[0], selected.rotation[1] + Math.PI / 8, selected.rotation[2]]; title = `Rotate ${selected.name}`; }
  const convertTo = TYPES.find((type) => new RegExp(`(?:into|to) an? ${type}`).test(lower));
  if (convertTo && convertTo !== selected.type) { patch.type = convertTo; title = `Convert ${selected.name} to a ${convertTo}`; }
  if (/transparent|glass/.test(lower)) { patch.material = 'glass'; title = `Make ${selected.name} transparent`; }
  if (/glow|emissive|light/.test(lower)) { patch.material = 'emissive'; title = `Illuminate ${selected.name}`; }
  if (/metal|metallic|chrome/.test(lower) && !patch.material) { patch.material = 'metal'; title = `Make ${selected.name} metallic`; }
  if (/bigger|larger|grow|increase/.test(lower)) { patch.scale = selected.scale.map((value) => Number((value * 1.25).toFixed(2))); title = `Enlarge ${selected.name}`; }
  if (/smaller|compact|reduce|shrink/.test(lower)) { patch.scale = selected.scale.map((value) => Number((value * .78).toFixed(2))); title = `Compact ${selected.name}`; }
  if (/left/.test(lower)) { patch.position = [selected.position[0] - .6, selected.position[1], selected.position[2]]; title = `Move ${selected.name} left`; }
  if (/right/.test(lower)) { patch.position = [selected.position[0] + .6, selected.position[1], selected.position[2]]; title = `Move ${selected.name} right`; }
  if (/up|higher|raise/.test(lower)) { patch.position = [selected.position[0], selected.position[1] + .6, selected.position[2]]; title = `Raise ${selected.name}`; }
  if (/down|lower/.test(lower)) { patch.position = [selected.position[0], Math.max(.05, selected.position[1] - .6), selected.position[2]]; title = `Lower ${selected.name}`; }
  if (/duplicate|copy/.test(lower)) {
    const copy = clone(selected);
    copy.id = makeId('obj');
    copy.name = `${selected.name} variation`;
    copy.position = [selected.position[0] + .75, selected.position[1], selected.position[2] + .4];
    return { title: `Create a variation of ${selected.name}`, description: 'A nearby duplicate lets you compare two directions side by side.', why: 'Variants help you keep the original while exploring an alternative.', intent: input, style: effectiveStyle(input), actions: [{ kind: 'add', object: copy }] };
  }
  if (!Object.keys(patch).length) return null;
  return { title, description, why, intent: input, style: effectiveStyle(input), actions: [{ kind: 'modify', objectId: selected.id, patch }] };
}

function primitivePlan(input) {
  const match = TYPES.find((type) => new RegExp(`\\b${type}\\b`, 'i').test(input));
  if (!match) return null;
  const color = detectColor(input);
  const material = /metal|metallic/.test(input) ? 'metal' : /glass|transparent/.test(input) ? 'glass' : /glow|emissive/.test(input) ? 'emissive' : 'plastic';
  return {
    title: `Add a ${TYPE_LABELS[match].toLowerCase()}`,
    description: `Place a new ${match} in the active shared scene so you can refine it by hand or with Orbit.`,
    why: 'This is the smallest reversible step that matches your request.',
    intent: input,
    style: effectiveStyle(input),
    actions: [descriptor(match, nextObjectName(match), defaultPosition(match), [1, 1, 1], material, color || MATERIALS[material].color)]
  };
}

function buildPlan(input) {
  const lower = input.toLowerCase();
  if (/rocket/.test(lower)) return rocketPlan(input);
  if (/delivery drone|drone|quadcopter/.test(lower)) return dronePlan(input);
  if (/robot/.test(lower)) return robotPlan(input);
  if (/symmetr|mirror|balanced/.test(lower) && state.objects.length) {
    return {
      title: 'Balance the shared model', description: 'Inspect side forms and create only the missing mirrored counterparts.',
      why: 'Symmetry is an explicit goal in your direction and is verified after the change.', intent: input, style: effectiveStyle(input), actions: [{ kind: 'symmetrize' }]
    };
  }
  if (/clear|delete everything|empty scene/.test(lower)) {
    return {
      title: 'Clear the shared scene', description: 'Remove all model forms and annotations. This destructive action remains reversible through history.',
      why: 'You asked to begin again with an empty canvas.', intent: input, style: effectiveStyle(input), actions: state.objects.map((object) => ({ kind: 'delete', objectId: object.id }))
    };
  }
  const selectedPlan = selectedEditPlan(input);
  if (selectedPlan) return selectedPlan;
  const shapePlan = primitivePlan(input);
  if (shapePlan) return shapePlan;
  return genericConceptPlan(input);
}

function refinePendingProposal(input) {
  const proposal = state.pendingProposal;
  if (!proposal || proposal.status !== 'draft') return false;
  const lower = input.toLowerCase();
  const color = detectColor(lower);
  let changed = false;
  if (/without|skip|don'?t add|no /.test(lower) && /wing|fin/.test(lower)) {
    const before = proposal.actions.length;
    proposal.actions = proposal.actions.filter((action) => action.kind !== 'add' || !/wing|fin/i.test(action.object.name));
    changed = proposal.actions.length !== before;
  }
  if (/without|skip|don'?t add|no /.test(lower) && /camera/.test(lower)) {
    const before = proposal.actions.length;
    proposal.actions = proposal.actions.filter((action) => action.kind !== 'add' || !/camera/i.test(action.object.name));
    changed = proposal.actions.length !== before || changed;
  }
  if (/compact|smaller/.test(lower)) {
    proposal.actions.forEach((action) => {
      if (action.kind === 'add' && /body|core|chassis|base/i.test(action.object.name)) {
        action.object.scale = action.object.scale.map((value) => Number((value * .78).toFixed(2)));
        changed = true;
      }
    });
  }
  if (/larger|bigger/.test(lower) && /fin|wing/.test(lower)) {
    proposal.actions.forEach((action) => {
      if (action.kind === 'add' && /fin|wing/i.test(action.object.name)) {
        action.object.scale = action.object.scale.map((value, index) => Number((value * (index === 1 ? 1.15 : 1.3)).toFixed(2)));
        changed = true;
      }
    });
  }
  if (color) {
    proposal.actions.forEach((action) => {
      if (action.kind === 'add' && !action.object.tags?.includes('detail')) { action.object.color = color; changed = true; }
      if (action.kind === 'modify') { action.patch.color = color; changed = true; }
    });
  }
  if (/metal|metallic/.test(lower)) {
    proposal.actions.forEach((action) => {
      if (action.kind === 'add' && !action.object.tags?.includes('detail')) { action.object.material = 'metal'; changed = true; }
      if (action.kind === 'modify') { action.patch.material = 'metal'; changed = true; }
    });
  }
  if (!changed) return false;
  proposal.description = `${proposal.description} Refined with your latest direction: “${input.slice(0, 80)}”.`;
  proposal.why = 'The plan was revised before execution so your feedback remains in control.';
  renderProposal();
  addMessage('agent', 'I updated the proposal before applying anything. Review the revised change list when you are ready.');
  addActivity('Revised pending plan', 'Orbit incorporated human feedback before execution.', 'agent');
  return true;
}

function stageProposal(plan) {
  const proposal = {
    id: makeId('proposal'),
    title: String(plan.title || 'Scene refinement').slice(0, 80),
    description: String(plan.description || 'A set of reversible scene changes.').slice(0, 240),
    why: String(plan.why || '').slice(0, 240),
    intent: String(plan.intent || '').slice(0, 300),
    style: plan.style || effectiveStyle(plan.intent || ''),
    actions: clone(plan.actions || []).map((action, index) => ({
      ...action,
      id: action.id || `operation_${index + 1}_${makeId('step')}`,
      enabled: action.enabled !== false,
      status: 'pending'
    })),
    selectedCount: 0,
    completedCount: 0,
    status: 'draft',
    createdAt: Date.now()
  };
  state.pendingProposal = proposal;
  state.designContext = { ...state.designContext, intent: proposal.intent, style: proposal.style, updatedAt: Date.now() };
  renderProposal();
  updateSummary();
  setAgentStatus('waiting', 'Plan ready for your approval', 'Inspect the exact diff, revise it, or reject it.');
  addActivity(`Prepared “${proposal.title}”`, `${proposal.actions.length} planned operation${proposal.actions.length === 1 ? '' : 's'} await human approval.`, 'agent');
  return proposal;
}

function permissionForAction(action) {
  if (action.kind === 'add') return 'create';
  if (action.kind === 'delete' || action.kind === 'restore_version') return 'delete';
  if (action.kind === 'export') return 'export';
  if (action.kind === 'share') return 'share';
  return 'modify';
}

function findBlockedPermissions(actions) {
  const required = [...new Set(actions.map(permissionForAction))];
  return required.filter((permission) => !state.permissions[permission]);
}

function executeAction(action) {
  if (action.kind === 'add') {
    const object = normaliseObject(action.object);
    if (state.objects.some((candidate) => candidate.id === object.id)) object.id = makeId('obj');
    if (state.objects.some((candidate) => candidate.name === object.name)) object.name = `${object.name} ${state.objects.filter((candidate) => candidate.name.startsWith(object.name)).length + 1}`;
    state.objects.push(object);
    state.selectedId = object.id;
    return;
  }
  if (action.kind === 'modify') {
    const object = state.objects.find((candidate) => candidate.id === action.objectId);
    if (!object) throw new Error(`Could not refine missing object ${action.objectId}.`);
    Object.assign(object, sanitisePatch(object, action.patch || {}));
    return;
  }
  if (action.kind === 'delete') {
    state.objects = state.objects.filter((object) => object.id !== action.objectId);
    state.comments = state.comments.filter((comment) => comment.objectId !== action.objectId);
    if (state.selectedId === action.objectId) state.selectedId = null;
    return;
  }
  if (action.kind === 'symmetrize') {
    mirrorUnpairedObjects(action.objectIds);
    return;
  }
  if (action.kind === 'snap') {
    const targetIds = action.objectIds || (state.selectedId ? [state.selectedId] : []);
    targetIds.forEach((id) => {
      const object = state.objects.find((candidate) => candidate.id === id);
      if (!object) return;
      object.position = object.position.map((value) => Math.round(value));
      object.rotation = object.rotation.map((value) => Math.round(value / (Math.PI / 12)) * (Math.PI / 12));
    });
    return;
  }
  if (action.kind === 'add_constraint') {
    const constraint = action.constraint;
    if (!state.constraints.some((candidate) => candidate.type === constraint.type)) state.constraints.push({ ...constraint, id: constraint.id || makeId('constraint') });
    return;
  }
  if (action.kind === 'restore_version') {
    const version = state.versions.find((candidate) => candidate.id === action.versionId);
    if (!version) throw new Error('Saved version was not found.');
    hydrateScene(version.snapshot);
    state.currentVersionId = version.id;
  }
}

function mirrorUnpairedObjects(targetIds = null) {
  const targets = targetIds?.length ? state.objects.filter((object) => targetIds.includes(object.id)) : state.objects.filter((object) => Math.abs(object.position[0]) > .22 && !object.tags.includes('detail'));
  const additions = [];
  targets.forEach((object) => {
    const counterpart = state.objects.find((candidate) => candidate.id !== object.id && candidate.type === object.type
      && Math.abs(candidate.position[0] + object.position[0]) < .22
      && Math.abs(candidate.position[1] - object.position[1]) < .28
      && Math.abs(candidate.position[2] - object.position[2]) < .28);
    if (counterpart || Math.abs(object.position[0]) <= .22) return;
    const mirrored = clone(object);
    mirrored.id = makeId('obj');
    mirrored.name = object.position[0] > 0 ? `${object.name} mirror` : `${object.name} mirror`;
    mirrored.position[0] = -object.position[0];
    mirrored.rotation[1] = -mirrored.rotation[1];
    mirrored.tags = [...new Set([...mirrored.tags, 'mirrored'])];
    additions.push(normaliseObject(mirrored));
  });
  state.objects.push(...additions);
  if (additions.length) state.selectedId = additions[additions.length - 1].id;
}

function recordTransaction(meta, before) {
  const after = snapshotScene();
  if (JSON.stringify(before) === JSON.stringify(after)) return null;
  state.history = state.history.slice(0, state.historyIndex + 1);
  const entry = {
    id: makeId('change'),
    label: meta.label || 'Agent run',
    source: meta.source || 'agent',
    why: meta.why || '',
    runId: meta.runId || null,
    timestamp: Date.now(),
    before,
    after
  };
  state.history.push(entry);
  if (state.history.length > 60) state.history.shift();
  state.historyIndex = state.history.length - 1;
  persistWorkspace();
  return entry;
}

function updateBuildOverlay(proposal, action) {
  const total = proposal.selectedCount || 0;
  const completed = proposal.completedCount || 0;
  els.buildOverlay.classList.remove('hidden');
  els.buildStep.textContent = action ? actionLabel(action) : 'Preparing shared scene…';
  els.buildCount.textContent = `${completed} / ${total} operation${total === 1 ? '' : 's'}`;
  els.buildProgress.style.width = `${total ? Math.round((completed / total) * 100) : 0}%`;
}

function hideBuildOverlay() {
  els.buildOverlay.classList.add('hidden');
  els.buildProgress.style.width = '0%';
}

function interruptActiveRun() {
  const run = state.activeRun;
  if (!run || run.finished) return;
  run.interrupted = true;
  setAgentStatus('waiting', 'Stopping after current safe step', 'Orbit will preserve completed work and return control to you.');
  addActivity('Interrupt requested', 'Human asked Orbit to stop the live build after its current safe boundary.', 'human');
  setCanvasMessage('Stopping agent run at the next safe step');
}

async function executePendingProposal({ autoApproved = false } = {}) {
  // Guard against a second execution starting while the first run is still streaming.
  if (state.activeRun && !state.activeRun.finished) {
    return { success: false, message: 'An agent run is already streaming into the scene.' };
  }
  const proposal = state.pendingProposal;
  if (!proposal || proposal.status !== 'draft') return { success: false, message: 'There is no pending proposal to apply.' };
  const selectedActions = proposal.actions.filter((action) => action.enabled !== false);
  if (!selectedActions.length) return { success: false, message: 'Choose at least one operation before applying the proposal.' };
  const blocked = findBlockedPermissions(selectedActions);
  if (blocked.length) {
    const readable = blocked.map(titleCase).join(', ');
    setAgentStatus('blocked', 'Action blocked by permission', `Enable ${readable} in Agent permissions to continue.`);
    addMessage('agent', `I paused this plan because ${readable.toLowerCase()} permission is off. You can change that in the settings control.`);
    addActivity('Proposal blocked', `${readable} permission is disabled by the human collaborator.`, 'warning');
    showToast(`Permission required: ${readable}`, 'error');
    return { success: false, message: `Permission required: ${readable}` };
  }

  proposal.status = 'applying';
  proposal.selectedCount = selectedActions.length;
  proposal.completedCount = 0;
  proposal.actions.forEach((action) => { action.status = action.enabled === false ? 'skipped' : 'pending'; });
  const run = {
    id: makeId('run'),
    proposalId: proposal.id,
    before: snapshotScene(),
    selectedActions,
    interrupted: false,
    finished: false
  };
  state.activeRun = run;
  lockActionObjects(selectedActions, run.id);
  updateBuildOverlay(proposal);
  renderProposal();
  setAgentStatus('thinking', `Building 0/${selectedActions.length} live`, 'Each approved operation is appearing in the shared canvas as it completes.');
  addActivity(`Started live build: ${proposal.title}`, `${selectedActions.length} selected operation${selectedActions.length === 1 ? '' : 's'} will stream into the canvas.`, 'agent');

  for (let index = 0; index < selectedActions.length; index += 1) {
    const action = selectedActions[index];
    if (run.interrupted) break;
    // Defensive: never keep mutating for a proposal that is no longer the active one.
    if (state.pendingProposal !== proposal || state.activeRun !== run) {
      run.interrupted = true;
      break;
    }
    action.status = 'running';
    updateBuildOverlay(proposal, action);
    renderProposal();
    setAgentStatus('thinking', `Building ${index + 1}/${selectedActions.length} live`, actionLabel(action));
    await delay(310);
    if (run.interrupted) {
      action.status = 'pending';
      break;
    }
    try {
      executeAction(action);
      action.status = 'complete';
      proposal.completedCount += 1;
      renderModel();
      refreshUI({ scene: false });
      updateBuildOverlay(proposal, action);
      addActivity(`Built ${actionLabel(action)}`, proposal.why || 'The approved operation appeared in the shared scene.', 'agent');
      await delay(150);
    } catch (error) {
      action.status = 'error';
      action.error = error.message;
      addActivity(`Could not complete ${actionLabel(action)}`, error.message, 'warning');
    }
  }

  const completed = proposal.completedCount;
  const interrupted = run.interrupted;
  const entry = recordTransaction({ label: interrupted ? `${proposal.title} (partial)` : proposal.title, why: proposal.why, runId: proposal.id, source: 'agent' }, run.before);
  proposal.status = interrupted ? 'interrupted' : 'applied';
  proposal.historyEntryId = entry?.id || null;
  proposal.before = run.before;
  state.lastAgentRun = entry ? { proposalId: proposal.id, historyEntryId: entry.id, before: run.before } : null;
  run.finished = true;
  unlockRunObjects(run.id);
  state.activeRun = null;
  hideBuildOverlay();

  // Side effects run only after the streamed model state is complete and remain proposal-gated.
  if (!interrupted && selectedActions.some((action) => action.kind === 'export')) exportSTL();
  if (!interrupted && selectedActions.some((action) => action.kind === 'share')) await shareScene();

  renderProposal();
  refreshUI({ scene: false });
  if (interrupted) {
    setAgentStatus('ready', 'Live build interrupted', `${completed} of ${selectedActions.length} selected operations completed; keep or undo the partial run.`);
    addMessage('agent', `Stopped safely. I completed ${completed} of ${selectedActions.length} selected operations, and the partial result is still reversible.`);
    addActivity(`Interrupted “${proposal.title}”`, `${completed} operation${completed === 1 ? '' : 's'} completed before human interruption.`, 'human');
    setCanvasMessage(`Live build stopped after ${completed} operation${completed === 1 ? '' : 's'}`);
  } else {
    setAgentStatus('ready', 'Live build complete — your call', 'Keep the streamed run, undo it, or direct the next iteration.');
    addMessage('agent', `Finished “${proposal.title}” one operation at a time. ${proposal.why || 'The full batch is still reversible while you review it.'}`);
    addActivity(`Completed “${proposal.title}”`, `${completed} approved operation${completed === 1 ? '' : 's'} streamed into the shared scene.`, 'agent');
    setCanvasMessage(autoApproved ? 'Direct mode streamed the agent run' : 'Live agent run complete — review it');
  }
  if (run.queuedRequest) {
    window.setTimeout(() => handleAgentRequest(run.queuedRequest, { alreadyLogged: true }), 40);
  }
  return { success: true, proposal_id: proposal.id, completed_operations: completed, interrupted, message: interrupted ? 'Partial agent run stopped safely.' : 'Approved proposal applied incrementally.' };
}
function discardDraftProposal() {
  const proposal = state.pendingProposal;
  if (!proposal || proposal.status !== 'draft') return;
  state.pendingProposal = null;
  renderProposal();
  updateSummary();
  setAgentStatus('ready', 'Plan dismissed', 'Nothing changed in the shared scene. Give me another direction when ready.');
  addMessage('agent', 'Understood — I discarded that plan and did not change the scene.');
  addActivity(`Rejected “${proposal.title}”`, 'Human declined the proposal before execution.', 'human');
}

function keepAppliedProposal() {
  const proposal = state.pendingProposal;
  // Interrupted runs are a terminal state too — the "Keep partial run" control has to close them.
  if (!proposal || !['applied', 'interrupted'].includes(proposal.status)) return;
  state.pendingProposal = null;
  renderProposal();
  updateSummary();
  setAgentStatus('ready', 'Run accepted', 'The shared scene is ready for the next collaborative step.');
  addActivity(`Kept “${proposal.title}”`, proposal.status === 'interrupted' ? 'Human accepted the partial agent run.' : 'Human accepted the completed agent run.', 'human');
}

function revertLastAgentRun() {
  const run = state.lastAgentRun;
  const historyIndex = run?.historyEntryId ? state.history.findIndex((entry) => entry.id === run.historyEntryId) : -1;
  if (!run || historyIndex < 0 || historyIndex !== state.historyIndex) {
    setCanvasMessage('That agent run is no longer the latest change; use version history or undo instead.');
    return { success: false, message: 'The agent run is no longer the latest reversible change.' };
  }
  hydrateScene(run.before);
  state.historyIndex = historyIndex - 1;
  const proposalTitle = state.pendingProposal?.title || 'agent run';
  state.pendingProposal = null;
  state.lastAgentRun = null;
  refreshUI({ scene: true });
  persistWorkspace();
  setAgentStatus('ready', 'Agent run reverted', 'The scene is back to the state before the approved batch.');
  addMessage('agent', 'I reverted my last run. Your earlier shared scene has been restored.');
  addActivity(`Reverted “${proposalTitle}”`, 'Human rejected the completed agent run.', 'human');
  setCanvasMessage('Agent run reverted');
  return { success: true, message: 'Most recent agent run reverted.' };
}

function planFromReview() {
  if (!currentReview?.recommendations?.length) return;
  const actions = [];
  if (currentReview.symmetry < 92) actions.push({ kind: 'symmetrize' });
  if (!actions.length) {
    addMessage('agent', 'The review found observations but no safe automatic structural change. I kept control with you rather than guessing.');
    return;
  }
  closeModal('review-modal');
  stageProposal({
    title: 'Review-informed balance pass',
    description: 'A targeted pass based on the latest deterministic design review.',
    why: 'The review found unmatched side forms, so this plan adds only missing mirrored counterparts.',
    intent: 'Apply design review recommendations',
    style: state.designContext.style,
    actions
  });
  addMessage('agent', 'I prepared only the safe, review-backed improvements for your approval.');
}

async function handleAgentRequest(text, { alreadyLogged = false } = {}) {
  const request = String(text || '').trim();
  if (!request) return;
  if (state.timeTravel.active) {
    exitTimeTravel();
    addMessage('agent', 'I returned to the live scene before interpreting your new direction.');
  }
  const lower = request.toLowerCase();
  const nonce = ++agentRequestNonce;
  const liveContext = getLiveAgentContext();
  const routedIntent = routePrompt(request, { selectedObject: getInteractionTarget(/\b(that|there|pointed)\b/.test(lower)) });
  els.agentInput.value = '';
  if (!alreadyLogged) addMessage('human', request);
  addActivity(`Intent routed to ${routedIntent.tool}`, routedIntent.reason || `Selection context v${liveContext.selection_revision} was attached automatically.`, 'agent');

  if (state.activeRun && !/^(stop|pause|wait)\b/.test(lower)) {
    state.activeRun.queuedRequest = request;
    interruptActiveRun();
    addMessage('agent', 'I received your new direction. I’m stopping at the next safe step, then I’ll plan that revision against the updated scene.');
    return;
  }

  if (routedIntent.tool === 'interrupt_agent_run') {
    if (state.activeRun) {
      interruptActiveRun();
    } else {
      setAgentStatus('ready', 'Agent paused', 'I stopped before making another change.');
      addMessage('agent', 'Paused. I will not make further changes until you give a new direction.');
      addActivity('Agent interrupted', 'Human paused the current collaboration flow.', 'human');
    }
    return;
  }
  if (routedIntent.tool === 'undo_agent_changes') {
    if (state.pendingProposal?.status === 'applied' || state.pendingProposal?.status === 'interrupted') revertLastAgentRun();
    else undoLastChange();
    return;
  }
  if (routedIntent.tool === 'save_preference') {
    try {
      const saved = savePreference(routedIntent.parameters.preference, 'human');
      setAgentStatus('ready', 'Project preference saved', `I’ll carry “${saved}” into future local planning sessions.`);
      addMessage('agent', `Saved “${saved}” to this browser’s project memory. You can remove it at any time by clicking the memory chip or saying “forget …”.`);
    } catch (error) { addMessage('agent', error.message); }
    return;
  }
  if (routedIntent.tool === 'get_preferences') {
    const preferences = state.designContext.preferences || [];
    setAgentStatus('ready', 'Project memory read', preferences.length ? `${preferences.length} saved design preference${preferences.length === 1 ? '' : 's'} active.` : 'No saved preferences yet.');
    addMessage('agent', preferences.length ? `I remember: ${preferences.join('; ')}.` : 'I do not have saved project preferences yet. Say “Remember I prefer low-poly styles” to teach me.');
    return;
  }
  if (routedIntent.tool === 'remove_preference') {
    const requested = routedIntent.parameters.preference.toLowerCase();
    const match = (state.designContext.preferences || []).find((preference) => preference.toLowerCase().includes(requested) || requested.includes(preference.toLowerCase()));
    if (match) {
      removePreference(match);
      addMessage('agent', `Forgot “${match}” from the local project memory.`);
    } else addMessage('agent', `I could not find “${routedIntent.parameters.preference}” in the saved project memory.`);
    return;
  }
  if (routedIntent.tool === 'get_activity_timeline') {
    $$('[data-agent-tab]').forEach((button) => {
      const active = button.dataset.agentTab === 'activity';
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    $('#plan-panel').classList.add('hidden');
    $('#activity-panel').classList.remove('hidden');
    setAgentStatus('ready', 'Timeline ready to inspect', `${state.activity.length} recorded human and agent event${state.activity.length === 1 ? '' : 's'} available.`);
    addMessage('agent', 'I opened the activity timeline. Click any recorded event or scrub backward to inspect the exact scene snapshot from that moment; return to live before editing.');
    return;
  }
  if (routedIntent.tool === 'set_project_persona') {
    const persona = setProjectPersona(routedIntent.parameters.persona, 'human');
    setAgentStatus('ready', 'Project persona updated', `Orbit is now collaborating as ${persona.toLowerCase()}.`);
    addMessage('agent', `Understood. I’ll take the ${persona.toLowerCase()} role for this browser-local project until you change it.`);
    return;
  }
  if (routedIntent.tool === 'get_scene') {
    const stats = getSceneStatistics();
    setAgentStatus('ready', 'Scene read complete', `${stats.object_count} form${stats.object_count === 1 ? '' : 's'} and ${stats.constraint_count} active guardrail${stats.constraint_count === 1 ? '' : 's'} are in view.`);
    addMessage('agent', stats.object_count ? `I can see ${stats.object_count} form${stats.object_count === 1 ? '' : 's'} across ${Object.keys(stats.types).join(', ')}. The current symmetry reading is ${stats.symmetry_score}%.` : 'The shared scene is empty and ready for your first design direction.');
    return;
  }
  if (routedIntent.tool === 'get_selected_object') {
    const selected = getSelectedObject();
    setAgentStatus('ready', 'Selection context read', selected ? `Following ${selected.name} automatically.` : 'No form is currently selected.');
    addMessage('agent', selected ? `This is ${selected.name}, a ${selected.type} at [${selected.position.map((value) => value.toFixed(1)).join(', ')}] with a ${MATERIALS[selected.material].label.toLowerCase()} finish.` : 'Nothing is selected yet. Click a form and I will use it as the context for “this” or “that”.');
    return;
  }
  if (routedIntent.tool === 'find_objects') {
    const matches = findObjectsBySemanticQuery(routedIntent.parameters.query);
    setAgentStatus('ready', 'Semantic search complete', `${matches.length} matching form${matches.length === 1 ? '' : 's'} found.`);
    if (matches[0]) selectObject(matches[0].id);
    addMessage('agent', matches.length ? `I found ${matches.length} match${matches.length === 1 ? '' : 'es'}: ${matches.map((object) => object.name).join(', ')}.${matches[0] ? ` I selected ${matches[0].name}.` : ''}` : `I could not find a form matching “${routedIntent.parameters.query}”.`);
    return;
  }
  if (routedIntent.tool === 'analyze_design') {
    setAgentStatus('thinking', 'Inspecting the shared scene', 'Reading geometry, material, symmetry, and active constraints.');
    await delay(260);
    if (nonce !== agentRequestNonce) return;
    showDesignReview();
    setAgentStatus('ready', 'Review ready', 'I surfaced clear findings and safe next steps.');
    addMessage('agent', 'I completed a design review. Click any score for its exact evidence, or click a linked finding to focus the related form.');
    return;
  }
  if (routedIntent.tool === 'validate_scene') {
    const validation = validateScene();
    const warnings = validation.issues.length;
    setAgentStatus('ready', 'Scene validation complete', warnings ? `${warnings} issue${warnings === 1 ? '' : 's'} needs attention.` : 'No deterministic validation issues found.');
    addMessage('agent', warnings ? `Validation found ${warnings} item${warnings === 1 ? '' : 's'} to inspect: ${validation.issues.map((issue) => issue.title).join(', ')}.` : 'Validation passed: no structural intersections or active constraint failures were found.');
    addActivity('Validated shared scene', warnings ? `${warnings} deterministic issue${warnings === 1 ? '' : 's'} reported.` : 'No deterministic issues reported.', 'agent');
    return;
  }
  if (routedIntent.tool === 'create_version') {
    const version = createVersion(routedIntent.parameters.name, 'human');
    if (version) addMessage('agent', `Saved ${version.label}. You can restore it from the version rail at any time.`);
    return;
  }
  if (routedIntent.tool === 'add_comment') {
    try {
      const comment = addComment(routedIntent.parameters.text, getSelectedObject()?.id, 'Human collaborator', 'human');
      addMessage('agent', `Added your annotation to ${objectNameForId(comment.objectId)}. I’ll retain it in the shared design context.`);
    } catch (error) { addMessage('agent', error.message); }
    return;
  }
  if (routedIntent.tool === 'add_constraint') {
    const type = routedIntent.parameters.type;
    stageProposal({
      title: `Add ${type} constraint`,
      description: type === 'symmetry' ? 'Keep future side forms mirrored across the center axis.' : 'Validate applicable forms against the ground plane.',
      why: 'Guardrails turn your design intent into a check that Orbit can verify after every proposed change.',
      intent: request,
      style: state.designContext.style,
      actions: [{ kind: 'add_constraint', constraint: { id: makeId('constraint'), type, objectIds: null, label: type === 'symmetry' ? 'Mirror across center axis' : 'Keep forms on ground plane' } }]
    });
    addMessage('agent', 'I staged that guardrail for your approval. It will appear in every subsequent validation report.');
    return;
  }
  if (routedIntent.tool === 'export_stl' || routedIntent.tool === 'share_scene') {
    const isExport = routedIntent.tool === 'export_stl';
    stageProposal({
      title: isExport ? 'Export model as STL' : 'Create shareable scene link',
      description: isExport ? 'Create a local STL download from the current shared scene.' : 'Generate and copy a local URL-safe link encoding this scene. No upload occurs.',
      why: isExport ? 'File export is sensitive and remains visible for approval.' : 'Sharing creates a transferable design state and remains visible for approval.',
      intent: request,
      style: state.designContext.style,
      actions: [{ kind: isExport ? 'export' : 'share' }]
    });
    addMessage('agent', `${isExport ? 'Export' : 'Sharing'} is staged as a sensitive action. Enable the matching permission and approve the visible card to continue.`);
    return;
  }
  if (routedIntent.tool === 'restore_version') {
    const requested = routedIntent.parameters?.version_label || extractRestoreTarget(request);
    const matches = findVersionsByLabel(requested);
    if (matches.length !== 1) {
      addMessage('agent', matches.length > 1
        ? `“${requested}” matches ${matches.length} checkpoints (${matches.map((candidate) => candidate.label).join(', ')}). Name one exactly, or pick it from the version rail.`
        : 'I need a specific saved checkpoint to restore. Choose one from the version rail, or name the checkpoint exactly in your request.');
      return;
    }
    const version = matches[0];
    if (version.id === state.currentVersionId) {
      addMessage('agent', `“${version.label}” is already the active checkpoint, so there is nothing to restore.`);
      return;
    }
    stageProposal({ title: `Restore ${version.label}`, description: 'Return the complete shared scene to the selected saved checkpoint.', why: 'Version restoration changes the full scene, so it remains a visible approval step.', intent: request, style: state.designContext.style, actions: [{ kind: 'restore_version', versionId: version.id, versionLabel: version.label }] });
    return;
  }
  if (refinePendingProposal(request)) return;

  setAgentStatus('thinking', 'Turning intent into a plan', 'I am reading the scene and preparing a visible, reversible diff.');
  await delay(330);
  if (nonce !== agentRequestNonce) return;
  const plan = buildPlan(request);
  if (!plan.actions.length) {
    setAgentStatus('ready', 'No changes proposed', 'There was nothing safe to change from that direction.');
    addMessage('agent', 'I could not find a safe scene change to propose. Try naming a form or describing the desired shape.');
    return;
  }
  stageProposal(plan);
  addMessage('agent', `I prepared “${plan.title}”. Review the steps, revise the plan, or approve it when it feels right.`);
  const includesSensitiveAction = plan.actions.some((action) => ['delete', 'restore_version', 'export', 'share'].includes(action.kind));
  if (state.currentMode === 'direct' && !includesSensitiveAction) await executePendingProposal({ autoApproved: true });
  if (state.currentMode === 'direct' && includesSensitiveAction) {
    setCanvasMessage('Sensitive actions stay approval-gated, even in Direct mode');
  }
}

/* WebMCP tools: goal-oriented and state-aware instead of a long list of UI clicks */
function summariseToolArgs(args) {
  const entries = Object.entries(args || {}).slice(0, 3).map(([key, value]) => {
    const compact = typeof value === 'string' ? value.slice(0, 36) : Array.isArray(value) ? `${value.length} item${value.length === 1 ? '' : 's'}` : typeof value === 'object' ? 'structured value' : String(value);
    return `${key}: ${compact}`;
  });
  return entries.length ? entries.join(' · ') : 'no parameters';
}

function registerTool(definition) {
  const execute = definition.execute;
  toolRegistry.set(definition.name, {
    ...definition,
    // Every tool response carries the latest live selection/lock context. This avoids
    // forcing an agent to guess whether the human changed selection between turns.
    execute: async (args = {}) => {
      const readOnlyDuringPreview = new Set(['get_scene', 'get_selected_object', 'find_objects', 'get_scene_statistics', 'get_design_context', 'get_preferences', 'get_history', 'validate_scene', 'analyze_design', 'list_constraints', 'list_versions', 'get_activity_timeline', 'get_activity_snapshot']);
      const result = state.timeTravel.active && !readOnlyDuringPreview.has(definition.name)
        ? { success: false, message: 'Time-travel preview is read-only. Return to the live scene before mutating collaboration state.' }
        : await execute(args);
      addActivity(`Tool call · ${definition.name}`, summariseToolArgs(args), 'agent', { tool_call: { name: definition.name, args: clone(args) } });
      if (!result || typeof result !== 'object') return result;
      // Live context describes scene objects, so it must obey the human's Read permission
      // and must never be attached to a call that was denied.
      if (result.success === false) return result;
      return { ...result, live_context: getLiveAgentContext() };
    }
  });
}

function readAllowed() {
  if (state.permissions.read) return null;
  return { success: false, message: 'Scene read permission is disabled by the human collaborator.' };
}

function stageExternalPlan(plan) {
  const blockedRead = readAllowed();
  if (blockedRead) return blockedRead;
  // A streamed run owns state.activeRun and state.pendingProposal. Replacing the proposal
  // mid-run would disconnect the run's completion and undo controls from its mutations.
  if (state.activeRun && !state.activeRun.finished) {
    return { success: false, message: 'An approved agent run is still streaming into the scene. Wait for it to finish or interrupt it before proposing new changes.' };
  }
  if (state.pendingProposal && state.pendingProposal.status === 'applying') {
    return { success: false, message: 'A proposal is currently being applied. Wait for it to finish before proposing new changes.' };
  }
  const proposal = stageProposal(plan);
  return {
    success: true,
    requires_human_approval: true,
    proposal_id: proposal.id,
    proposal: {
      title: proposal.title,
      description: proposal.description,
      action_count: proposal.actions.length,
      status: proposal.status,
      operations: proposal.actions.map((action) => ({ id: action.id, label: actionLabel(action), enabled: action.enabled !== false, status: action.status }))
    }
  };
}

/* Translate a high level geometry operation into a concrete, validated object patch. */
function geometryPatch(object, args = {}) {
  const axisIndex = { x: 0, y: 1, z: 2 }[String(args.axis || 'y').toLowerCase()] ?? 1;
  switch (args.operation) {
    case 'set_type': {
      if (!TYPES.includes(args.type)) throw new Error(`Unknown primitive “${args.type}”. Available: ${TYPES.join(', ')}.`);
      return { type: args.type };
    }
    case 'set_detail': {
      if (!DETAIL_LEVELS[args.detail]) throw new Error(`Unknown detail level “${args.detail}”. Available: ${Object.keys(DETAIL_LEVELS).join(', ')}.`);
      return { detail: args.detail };
    }
    case 'stretch': {
      const factor = safeNumber(args.factor, 1.25);
      if (factor <= 0) throw new Error('Stretch factor must be greater than zero.');
      const scale = [...object.scale];
      scale[axisIndex] = clamp(scale[axisIndex] * factor, .05, 30);
      return { scale };
    }
    case 'scale': {
      const factor = safeNumber(args.factor, 1.25);
      if (factor <= 0) throw new Error('Scale factor must be greater than zero.');
      return { scale: object.scale.map((value) => clamp(value * factor, .05, 30)) };
    }
    case 'rotate': {
      const rotation = [...object.rotation];
      rotation[axisIndex] += THREE.MathUtils.degToRad(safeNumber(args.degrees, 15));
      return { rotation };
    }
    case 'move': {
      const position = [...object.position];
      position[axisIndex] += safeNumber(args.distance, 1);
      return { position };
    }
    case 'drop_to_ground': {
      const bounds = objectBounds(object);
      const position = [...object.position];
      position[1] -= bounds.min[1];
      return { position };
    }
    default:
      throw new Error(`Unsupported geometry operation “${args.operation}”.`);
  }
}

function describeGeometryEdit(args = {}) {
  const axis = String(args.axis || 'y').toUpperCase();
  switch (args.operation) {
    case 'set_type': return `Convert to ${TYPE_LABELS[args.type] || args.type}`;
    case 'set_detail': return `Set ${String(DETAIL_LEVELS[args.detail] || args.detail).toLowerCase()} resolution`;
    case 'stretch': return `Stretch ${axis} ×${safeNumber(args.factor, 1.25).toFixed(2)}`;
    case 'scale': return `Scale ×${safeNumber(args.factor, 1.25).toFixed(2)}`;
    case 'rotate': return `Rotate ${axis} ${Math.round(safeNumber(args.degrees, 15))}°`;
    case 'move': return `Move ${axis} ${safeNumber(args.distance, 1).toFixed(2)}`;
    case 'drop_to_ground': return 'Drop to ground';
    default: return 'Edit geometry';
  }
}

function externalChangeToAction(change = {}) {
  const operation = change.operation || change.kind;
  if (['create', 'add'].includes(operation)) return { kind: 'add', object: change.object || change.value || {} };
  if (['modify', 'update'].includes(operation)) return { kind: 'modify', objectId: change.object_id || change.objectId, patch: change.patch || change.value || {} };
  if (['delete', 'remove'].includes(operation)) return { kind: 'delete', objectId: change.object_id || change.objectId };
  if (['symmetrize', 'make_symmetric'].includes(operation)) return { kind: 'symmetrize', objectIds: change.object_ids || change.objectIds };
  if (operation === 'snap') return { kind: 'snap', objectIds: change.object_ids || change.objectIds };
  throw new Error(`Unsupported change operation: ${operation}`);
}

function defineTools() {
  registerTool({
    name: 'get_scene',
    description: 'Read the complete shared 3D scene, including object geometry, selection, constraints, design intent, statistics, and bounding box. Use this before planning a change.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => readAllowed() || { success: true, scene: serialisedScene() }
  });
  registerTool({
    name: 'get_selected_object',
    description: 'Read the object currently selected by the human collaborator. Use it to resolve references such as “this” or “that”.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => readAllowed() || { success: true, object: clone(getSelectedObject()), selected: Boolean(getSelectedObject()) }
  });
  registerTool({
    name: 'find_objects',
    description: 'Find scene objects by human-friendly semantic text such as “front camera”, “glass forms”, “left wheel”, or “fin”.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Semantic description of desired scene objects.' } }, required: ['query'] },
    execute: async ({ query }) => {
      const denied = readAllowed(); if (denied) return denied;
      const objects = findObjectsBySemanticQuery(query);
      return { success: true, query, objects: clone(objects), match_count: objects.length };
    }
  });
  registerTool({
    name: 'get_scene_statistics',
    description: 'Read concise scene statistics: object/type counts, material and color counts, selection, symmetry score, constraints, versions, and bounding box.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => readAllowed() || { success: true, statistics: getSceneStatistics() }
  });
  registerTool({
    name: 'get_design_context',
    description: 'Read the human’s saved design intent, style direction, active constraints, and annotations before making a recommendation.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => readAllowed() || { success: true, design_context: clone(state.designContext), constraints: clone(state.constraints), comments: clone(state.comments) }
  });
  registerTool({
    name: 'get_preferences',
    description: 'Read persistent browser-local project preferences and the current Orbit project persona before suggesting a design direction.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => readAllowed() || ({ success: true, preferences: clone(state.designContext.preferences || []), persona: state.designContext.persona, persistence: 'browser-local project memory' })
  });
  registerTool({
    name: 'save_preference',
    description: 'Save an explicit human-stated design preference for future browser-local project sessions. Use only when the human asks to remember a preference.',
    parameters: { type: 'object', properties: { preference: { type: 'string' } }, required: ['preference'] },
    execute: async ({ preference }) => {
      if (!state.permissions.modify) return { success: false, message: 'Modify permission is disabled; project memory cannot be changed.' };
      try { return { success: true, saved_preference: savePreference(preference, 'agent'), preferences: clone(state.designContext.preferences) }; }
      catch (error) { return { success: false, message: error.message }; }
    }
  });
  registerTool({
    name: 'remove_preference',
    description: 'Remove one explicit browser-local project preference when the human asks to forget it.',
    parameters: { type: 'object', properties: { preference: { type: 'string' } }, required: ['preference'] },
    execute: async ({ preference }) => {
      if (!state.permissions.modify) return { success: false, message: 'Modify permission is disabled; project memory cannot be changed.' };
      const match = (state.designContext.preferences || []).find((item) => item.toLowerCase() === String(preference).toLowerCase());
      if (!match) return { success: false, message: 'Preference was not found.' };
      removePreference(match);
      return { success: true, removed_preference: match, preferences: clone(state.designContext.preferences) };
    }
  });
  registerTool({
    name: 'set_project_persona',
    description: 'Set Orbit’s persistent browser-local collaboration role to Adaptive co-designer, Visual designer, Geometry engineer, or Design reviewer when the human explicitly requests it.',
    parameters: { type: 'object', properties: { persona: { type: 'string', enum: ['Adaptive co-designer', 'Visual designer', 'Geometry engineer', 'Design reviewer'] } }, required: ['persona'] },
    execute: async ({ persona }) => {
      if (!state.permissions.modify) return { success: false, message: 'Modify permission is disabled; the project persona cannot be changed.' };
      try { return { success: true, persona: setProjectPersona(persona, 'agent') }; }
      catch (error) { return { success: false, message: error.message }; }
    }
  });
  registerTool({
    name: 'get_history',
    description: 'Read a concise, auditable history of human and agent scene changes. Snapshots are intentionally omitted from the tool result.',
    parameters: { type: 'object', properties: { limit: { type: 'number', minimum: 1, maximum: 50 } }, required: [] },
    execute: async ({ limit = 20 } = {}) => readAllowed() || ({ success: true, history: state.history.slice(Math.max(0, state.history.length - clamp(safeNumber(limit, 20), 1, 50))).map(({ id, label, source, why, runId, timestamp }) => ({ id, label, source, why, run_id: runId, timestamp })), active_history_index: state.historyIndex })
  });
  registerTool({
    name: 'get_activity_timeline',
    description: 'Read the auditable human-agent timeline, including tool calls and whether a scene snapshot is available for each event. Use it for time-travel debugging.',
    parameters: { type: 'object', properties: { limit: { type: 'number', minimum: 1, maximum: 80 } }, required: [] },
    execute: async ({ limit = 30 } = {}) => readAllowed() || ({
      success: true,
      timeline: state.activity.slice(0, clamp(safeNumber(limit, 30), 1, 80)).map((event) => ({
        id: event.id,
        title: event.title,
        detail: event.detail,
        source: event.source,
        timestamp: event.timestamp,
        tool_call: event.tool_call ? { name: event.tool_call.name } : null,
        snapshot_available: Boolean(event.snapshot),
        scene_summary: event.snapshot ? { object_count: event.snapshot.objects?.length || 0, selected_object_id: event.snapshot.selectedId || null, constraint_count: event.snapshot.constraints?.length || 0 } : null
      }))
    })
  });
  registerTool({
    name: 'get_activity_snapshot',
    description: 'Read the exact scene snapshot captured at one timeline event for debugging or comparison. This is read-only and does not alter the visible live scene.',
    parameters: { type: 'object', properties: { event_id: { type: 'string' } }, required: ['event_id'] },
    execute: async ({ event_id }) => {
      const denied = readAllowed(); if (denied) return denied;
      const event = state.activity.find((candidate) => candidate.id === event_id);
      if (!event) return { success: false, message: 'Timeline event was not found.' };
      if (!event.snapshot) return { success: false, message: 'This event does not include a scene snapshot.' };
      return { success: true, event: { id: event.id, title: event.title, timestamp: event.timestamp, source: event.source }, scene_snapshot: clone(event.snapshot) };
    }
  });
  registerTool({
    name: 'propose_changes',
    description: 'Create a visible, non-mutating human approval proposal from high-level create, modify, delete, symmetrize, or snap changes. The tool never applies changes itself.',
    parameters: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, why: { type: 'string' }, changes: { type: 'array', items: { type: 'object' } } }, required: ['title', 'changes'] },
    execute: async ({ title, description, why, changes = [] }) => {
      try {
        const actions = changes.map(externalChangeToAction);
        return stageExternalPlan({ title, description, why, intent: title, style: state.designContext.style, actions });
      } catch (error) { return { success: false, message: error.message }; }
    }
  });
  registerTool({
    name: 'create_composite_object',
    description: 'Plan a complete named object from a list of primitive components. This stages a visible proposal instead of blindly mutating the model.',
    parameters: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, style: { type: 'string' }, components: { type: 'array', items: { type: 'object' } } }, required: ['name', 'components'] },
    execute: async ({ name, description, style, components = [] }) => {
      const actions = components.map((component, index) => ({ kind: 'add', object: { ...component, name: component.name || `${name} component ${index + 1}` } }));
      return stageExternalPlan({ title: `Create ${name}`, description: description || `A composite ${name} with ${actions.length} planned primitives.`, why: 'Composite planning keeps the object’s parts visible and reviewable before creation.', intent: name, style: style || state.designContext.style, actions });
    }
  });
  registerTool({
    name: 'modify_object',
    description: 'Stage a focused, structured modification to one existing object. Supports name, position, rotation (radians), scale, material, and color. Requires human approval before application.',
    parameters: { type: 'object', properties: { object_id: { type: 'string' }, patch: { type: 'object' }, why: { type: 'string' } }, required: ['object_id', 'patch'] },
    execute: async ({ object_id, patch, why }) => {
      if (!state.objects.some((object) => object.id === object_id)) return { success: false, message: `Object ${object_id} was not found.` };
      return stageExternalPlan({ title: `Refine ${objectNameForId(object_id)}`, description: 'A focused update to the referenced shared object.', why: why || 'The requested object refinement is staged for human review.', intent: `Modify ${objectNameForId(object_id)}`, style: state.designContext.style, actions: [{ kind: 'modify', objectId: object_id, patch }] });
    }
  });
  /*
   * Codex-style inspect → change geometry → refine texture loop. Each tool reads the
   * live scene, stages exactly one visible operation, and returns the state the agent
   * needs to steer the next change on the same scene.
   */
  registerTool({
    name: 'inspect_object',
    description: 'Inspect one object in depth: geometry type, resolution, transform, world bounds, resolved surface treatment, triangle estimate, annotations and nearby objects. Call this before changing geometry or textures.',
    parameters: { type: 'object', properties: { object_id: { type: 'string', description: 'Object id. Defaults to the human’s current selection.' } }, required: [] },
    execute: async ({ object_id } = {}) => {
      const denied = readAllowed(); if (denied) return denied;
      const object = state.objects.find((candidate) => candidate.id === (object_id || state.selectedId));
      if (!object) return { success: false, message: object_id ? `Object ${object_id} was not found.` : 'No object is selected. Pass object_id or ask the human to select a form.' };
      const bounds = objectBounds(object);
      const neighbours = state.objects
        .filter((candidate) => candidate.id !== object.id)
        .map((candidate) => ({ id: candidate.id, name: candidate.name, distance: Number(Math.hypot(...candidate.position.map((value, axis) => value - object.position[axis])).toFixed(2)) }))
        .sort((first, second) => first.distance - second.distance)
        .slice(0, 4);
      return {
        success: true,
        object: clone(object),
        geometry: {
          type: object.type,
          type_label: TYPE_LABELS[object.type],
          detail: object.detail,
          detail_label: DETAIL_LEVELS[object.detail],
          triangle_estimate: estimateTriangles(object),
          world_bounds: bounds,
          world_size: bounds.size.map((value) => Number(value.toFixed(3))),
          resting_on_ground: Math.abs(bounds.min[1]) < .05
        },
        surface: materialSummary(object),
        annotations: state.comments.filter((comment) => comment.objectId === object.id).map(({ text, author, createdAt }) => ({ text, author, created_at: createdAt })),
        nearest_objects: neighbours,
        locked: isObjectLocked(object.id)
      };
    }
  });
  registerTool({
    name: 'edit_geometry',
    description: 'Change an object’s geometry: swap the primitive type, change mesh resolution, stretch one axis, scale uniformly, rotate in degrees, move in units, or drop it onto the ground plane. Operations are staged as a visible, reversible diff the human watches apply in the 3D viewport.',
    parameters: {
      type: 'object',
      properties: {
        object_id: { type: 'string', description: 'Defaults to the human’s current selection.' },
        operation: { type: 'string', enum: ['set_type', 'set_detail', 'stretch', 'scale', 'rotate', 'move', 'drop_to_ground'] },
        type: { type: 'string', enum: TYPES },
        detail: { type: 'string', enum: Object.keys(DETAIL_LEVELS) },
        axis: { type: 'string', enum: ['x', 'y', 'z'] },
        factor: { type: 'number', description: 'Multiplier for stretch and scale.' },
        degrees: { type: 'number', description: 'Rotation for the rotate operation.' },
        distance: { type: 'number', description: 'Units for the move operation.' },
        why: { type: 'string' }
      },
      required: ['operation']
    },
    execute: async (args = {}) => {
      const denied = readAllowed(); if (denied) return denied;
      const object = state.objects.find((candidate) => candidate.id === (args.object_id || state.selectedId));
      if (!object) return { success: false, message: 'No target object. Pass object_id or ask the human to select a form.' };
      let patch;
      try { patch = geometryPatch(object, args); }
      catch (error) { return { success: false, message: error.message }; }
      return stageExternalPlan({
        title: `${describeGeometryEdit(args)} · ${object.name}`,
        description: 'A single geometry change to the referenced object.',
        why: args.why || 'Geometry changes stay visible and reversible while the human watches them apply.',
        intent: `Edit geometry of ${object.name}`,
        style: state.designContext.style,
        actions: [{ kind: 'modify', objectId: object.id, patch, label: `${describeGeometryEdit(args)} ${object.name}` }]
      });
    }
  });
  registerTool({
    name: 'refine_texture',
    description: 'Refine an object’s surface: apply a procedural texture pattern, change its scale, set the finish, adjust roughness or metalness, or set a greyscale value. Staged as a visible, reversible diff.',
    parameters: {
      type: 'object',
      properties: {
        object_id: { type: 'string', description: 'Defaults to the human’s current selection.' },
        texture: { type: 'string', enum: TEXTURE_NAMES },
        texture_scale: { type: 'number', minimum: .25, maximum: 8 },
        finish: { type: 'string', enum: Object.keys(MATERIALS) },
        roughness: { type: 'number', minimum: 0, maximum: 1 },
        metalness: { type: 'number', minimum: 0, maximum: 1 },
        color: { type: 'string', description: 'Hex value, monochrome by convention (for example #d6d6d6).' },
        why: { type: 'string' }
      },
      required: []
    },
    execute: async (args = {}) => {
      const denied = readAllowed(); if (denied) return denied;
      const object = state.objects.find((candidate) => candidate.id === (args.object_id || state.selectedId));
      if (!object) return { success: false, message: 'No target object. Pass object_id or ask the human to select a form.' };
      const patch = {};
      if (args.texture !== undefined) {
        if (!TEXTURES[args.texture]) return { success: false, message: `Unknown texture “${args.texture}”. Available: ${TEXTURE_NAMES.join(', ')}.` };
        patch.texture = args.texture;
      }
      if (args.texture_scale !== undefined) patch.textureScale = args.texture_scale;
      if (args.finish !== undefined) {
        if (!MATERIALS[args.finish]) return { success: false, message: `Unknown finish “${args.finish}”. Available: ${Object.keys(MATERIALS).join(', ')}.` };
        patch.material = args.finish;
      }
      if (args.roughness !== undefined) patch.roughness = args.roughness;
      if (args.metalness !== undefined) patch.metalness = args.metalness;
      if (args.color !== undefined) {
        if (!validColor(args.color)) return { success: false, message: 'Color must be a hex value such as #d6d6d6.' };
        patch.color = args.color;
      }
      if (!Object.keys(patch).length) return { success: false, message: 'Provide at least one surface property to refine.' };
      return stageExternalPlan({
        title: `Refine surface · ${object.name}`,
        description: 'A surface and texture refinement on the referenced object.',
        why: args.why || 'Texture refinements stay visible and reversible while the human watches them apply.',
        intent: `Refine the surface of ${object.name}`,
        style: state.designContext.style,
        actions: [{ kind: 'modify', objectId: object.id, patch, label: `Refine surface of ${object.name}` }]
      });
    }
  });
  registerTool({
    name: 'list_surface_options',
    description: 'List every procedural texture, finish and geometry resolution the studio supports, so a refinement can be planned against real options instead of guessed names.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => readAllowed() || ({
      success: true,
      textures: TEXTURE_NAMES.map((name) => ({ id: name, label: TEXTURES[name].label })),
      finishes: Object.entries(MATERIALS).map(([id, preset]) => ({ id, label: preset.label, roughness: preset.roughness, metalness: preset.metalness })),
      detail_levels: Object.entries(DETAIL_LEVELS).map(([id, label]) => ({ id, label })),
      primitives: TYPES.map((type) => ({ id: type, label: TYPE_LABELS[type] })),
      palette: 'Monochrome. Values run from #111111 to #fafafa.'
    })
  });
  registerTool({
    name: 'apply_approved_proposal',
    description: 'Apply the currently staged proposal only after the human has explicitly approved it in the studio. Returns an approval-required result while it remains a draft.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      if (!state.pendingProposal) return { success: false, message: 'No pending proposal exists.' };
      if (state.pendingProposal.status === 'draft') return { success: false, requires_human_approval: true, message: 'The human must approve the visible proposal in the studio.' };
      if (state.pendingProposal.status === 'applied') return { success: true, message: 'The proposal has already been applied.', proposal_id: state.pendingProposal.id };
      return { success: false, message: 'Proposal is currently being applied.' };
    }
  });
  registerTool({
    name: 'validate_scene',
    description: 'Run deterministic scene diagnostics for intersections, symmetry, active constraints, and scene statistics without changing the model.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => readAllowed() || { success: true, validation: validateScene() }
  });
  registerTool({
    name: 'analyze_design',
    description: 'Review composition, symmetry, materials, and geometry to provide a transparent project-specific quality score and recommendations. This is a heuristic, not an objective benchmark.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => readAllowed() || { success: true, analysis: analyseDesign() }
  });
  registerTool({
    name: 'add_constraint',
    description: 'Stage an active design guardrail. Supported types are symmetry and ground. The constraint will be visible and checked in future reviews.',
    parameters: { type: 'object', properties: { type: { type: 'string', enum: ['symmetry', 'ground'] }, object_ids: { type: 'array', items: { type: 'string' } } }, required: ['type'] },
    execute: async ({ type, object_ids }) => {
      if (!['symmetry', 'ground'].includes(type)) return { success: false, message: 'Unsupported constraint type.' };
      return stageExternalPlan({ title: `Add ${type} constraint`, description: `Keep the shared model aligned with a ${type} guardrail.`, why: 'Constraints make future agent edits verifiable against human intent.', intent: `Keep design ${type}`, style: state.designContext.style, actions: [{ kind: 'add_constraint', constraint: { id: makeId('constraint'), type, objectIds: object_ids || null, label: type === 'symmetry' ? 'Mirror across center axis' : 'Keep forms on ground plane' } }] });
    }
  });
  registerTool({
    name: 'list_constraints',
    description: 'Read all active design constraints and their latest deterministic validation results.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => readAllowed() || { success: true, constraints: clone(state.constraints), validation: validateConstraints() }
  });
  registerTool({
    name: 'create_version',
    description: 'Save a named non-destructive scene checkpoint for later comparison or restoration.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: [] },
    execute: async ({ name } = {}) => ({ success: true, version: createVersion(name || `Agent checkpoint ${state.versions.length + 1}`, 'agent') })
  });
  registerTool({
    name: 'list_versions',
    description: 'Read saved design checkpoint metadata for collaborative version comparison.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => readAllowed() || ({ success: true, active_version_id: state.currentVersionId, versions: state.versions.map(({ id, label, createdAt }) => ({ id, label, created_at: createdAt })) })
  });
  registerTool({
    name: 'restore_version',
    description: 'Stage restoration of a named version as a human-approved destructive proposal; it never silently overwrites the current scene.',
    parameters: { type: 'object', properties: { version_id: { type: 'string' } }, required: ['version_id'] },
    execute: async ({ version_id }) => {
      const version = state.versions.find((candidate) => candidate.id === version_id);
      if (!version) return { success: false, message: 'Version was not found.' };
      return stageExternalPlan({ title: `Restore ${version.label}`, description: 'Return the shared scene to this saved checkpoint after human review.', why: 'Version restoration changes the whole scene and is intentionally gated by approval.', intent: `Restore ${version.label}`, style: state.designContext.style, actions: [{ kind: 'restore_version', versionId: version.id, versionLabel: version.label }] });
    }
  });
  registerTool({
    name: 'undo_agent_changes',
    description: 'Undo the most recent completed agent proposal when it is still the latest reversible scene change.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => revertLastAgentRun()
  });
  registerTool({
    name: 'interrupt_agent_run',
    description: 'Request a safe interruption of an in-progress streamed agent run. Completed operations remain visible and can be kept or undone as one partial batch.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      if (!state.activeRun) return { success: false, message: 'No streamed agent run is active.' };
      interruptActiveRun();
      return { success: true, message: 'Safe interruption requested; Orbit will stop at the next operation boundary.' };
    }
  });
  registerTool({
    name: 'add_comment',
    description: 'Attach a concise agent or human-readable annotation to a scene object for contextual collaboration.',
    parameters: { type: 'object', properties: { object_id: { type: 'string' }, text: { type: 'string' }, author: { type: 'string' } }, required: ['object_id', 'text'] },
    execute: async ({ object_id, text, author }) => {
      try { return { success: true, comment: addComment(text, object_id, author || 'Orbit Agent', 'agent') }; }
      catch (error) { return { success: false, message: error.message }; }
    }
  });
  registerTool({
    name: 'export_stl',
    description: 'Stage an STL export request. Export is treated as a sensitive action and requires the human’s export permission plus proposal approval.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => stageExternalPlan({ title: 'Export model as STL', description: 'Create an STL download of the currently visible shared model.', why: 'Exports are explicitly visible so the human remains in control of file creation.', intent: 'Export final model', style: state.designContext.style, actions: [{ kind: 'export' }] })
  });
  registerTool({
    name: 'share_scene',
    description: 'Stage a URL-safe collaboration link request. Sharing is treated as sensitive: the human must approve the visible proposal and enable Share scene permission. No network upload is performed.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => stageExternalPlan({ title: 'Create shareable scene link', description: 'Generate and copy a URL-safe link encoding the current scene state. No model data is uploaded to a server.', why: 'Sharing creates a transferable copy of the design and stays under explicit human control.', intent: 'Share current scene', style: state.designContext.style, actions: [{ kind: 'share' }] })
  });
}

async function registerWebMCPTools() {
  const context = navigator.modelContext;
  if (!context) {
    els.footerStatus.textContent = `${toolRegistry.size} local agent tools ready`;
    showToast(`${toolRegistry.size} local tools ready · Enable WebMCP to expose them to browser agents`);
    return;
  }
  const register = context.addTool || context.registerTool;
  if (typeof register !== 'function') {
    els.footerStatus.textContent = 'WebMCP bridge unavailable';
    showToast('WebMCP bridge was detected but does not expose a registration method', 'error');
    return;
  }
  let count = 0;
  for (const definition of toolRegistry.values()) {
    const tool = { name: definition.name, description: definition.description, parameters: definition.parameters, execute: definition.execute };
    try {
      await register.call(context, tool);
      count += 1;
    } catch (firstError) {
      // A few early WebMCP implementations call the schema inputSchema instead of parameters.
      try {
        await register.call(context, { ...tool, inputSchema: definition.parameters, parameters: undefined });
        count += 1;
      } catch (secondError) {
        console.warn(`Could not register ${definition.name}`, secondError);
      }
    }
  }
  els.footerStatus.textContent = `${count}/${toolRegistry.size} WebMCP tools registered`;
  showToast(`${count} goal-oriented WebMCP tools registered`);
}

function exposeLocalBridge() {
  window.webMCPStudio = Object.freeze({
    listTools: () => [...toolRegistry.keys()],
    callTool: async (name, args = {}) => {
      const tool = toolRegistry.get(name);
      if (!tool) throw new Error(`Unknown WebMCP tool: ${name}`);
      return tool.execute(args);
    },
    // The bridge is a convenience wrapper over the same tools, so it obeys the same
    // human-controlled Read permission instead of exposing a privileged shortcut.
    getScene: () => readAllowed() || { success: true, scene: serialisedScene() },
    getSelectionContext: () => readAllowed() || { success: true, live_context: getLiveAgentContext() }
  });
}

/* Export and shared state */
function exportSTL() {
  if (!viewportReady) return { success: false, message: 'STL export needs the 3D viewport, which is unavailable in this browser.' };
  if (!state.objects.length) {
    setCanvasMessage('Add a form before exporting');
    return { success: false, message: 'Scene is empty.' };
  }
  try {
    const exporter = new STLExporter();
    const data = exporter.parse(modelGroup, { binary: true });
    const blob = new Blob([data], { type: 'model/stl' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `orbit-model-${new Date().toISOString().slice(0, 10)}.stl`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 250);
    addActivity('STL export initiated', 'A local STL file was prepared from the current shared scene.', 'human');
    showToast('STL download prepared');
    return { success: true, message: 'STL export initiated.' };
  } catch (error) {
    console.error('STL export failed:', error);
    showToast('STL export could not be created', 'error');
    return { success: false, message: error.message };
  }
}

function encodePayload(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function decodePayload(value) {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function generateShareLink() {
  const payload = { scene: snapshotScene(), createdAt: Date.now(), app: 'orbit-webmcp-studio' };
  return `${window.location.origin}${window.location.pathname}#model=${encodeURIComponent(encodePayload(payload))}`;
}

async function shareScene() {
  const shareUrl = generateShareLink();
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(shareUrl);
    else window.prompt('Copy this local scene link:', shareUrl);
    addActivity('Share link created', 'A local URL-encoded scene link was generated after human approval.', 'human');
    showToast('Share link copied to clipboard');
  } catch (_) {
    window.prompt('Copy this local scene link:', shareUrl);
    showToast('Share link is ready to copy');
  }
  return { success: true, share_url: shareUrl };
}

function loadSharedSceneFromLocation() {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const encoded = hash.get('model');
  if (!encoded) return false;
  try {
    const payload = decodePayload(encoded);
    if (!payload.scene) throw new Error('Missing scene state.');
    hydrateScene(payload.scene);
    addActivity('Loaded shared scene', 'A local scene state was restored from the supplied collaboration link.', 'human');
    showToast('Shared scene loaded');
    return true;
  } catch (error) {
    console.warn('Could not load shared scene:', error);
    showToast('That shared scene link could not be read', 'error');
    return false;
  }
}

/* DOM interaction */
function openModal(id) { $(`#${id}`).classList.remove('hidden'); }
function closeModal(id) { $(`#${id}`).classList.add('hidden'); }

function bindEvents() {
  $$('[data-add]').forEach((button) => button.addEventListener('click', () => createPrimitive(button.dataset.add)));
  $('#empty-start-btn').addEventListener('click', () => handleAgentRequest('Design a compact futuristic delivery drone'));
  $('#review-btn').addEventListener('click', showDesignReview);
  $('#apply-review-btn').addEventListener('click', planFromReview);
  $('#checkpoint-btn').addEventListener('click', () => createVersion(`Checkpoint ${state.versions.length + 1}`));
  $('#new-version-btn').addEventListener('click', () => createVersion(`Checkpoint ${state.versions.length + 1}`));
  $('#export-btn').addEventListener('click', exportSTL);
  $('#focus-scene-btn').addEventListener('click', focusScene);
  $('#fit-view-btn').addEventListener('click', focusScene);
  $('#grid-snap-btn').addEventListener('click', snapSelectedToGrid);
  $('#reset-view-btn').addEventListener('click', resetView);
  $('#duplicate-btn').addEventListener('click', duplicateSelected);
  $('#delete-btn').addEventListener('click', deleteSelected);
  $('#validate-constraints-btn').addEventListener('click', () => {
    const results = validateConstraints();
    const invalid = results.filter((result) => !result.valid);
    setCanvasMessage(results.length ? invalid.length ? `${invalid.length} constraint issue${invalid.length === 1 ? '' : 's'} found` : 'All active constraints pass' : 'No active constraints to check');
    addActivity('Checked constraints', results.length ? invalid.length ? `${invalid.length} active guardrail needs attention.` : 'All active guardrails pass.' : 'No guardrails are currently active.', 'agent');
  });
  $$('[data-constraint]').forEach((button) => button.addEventListener('click', () => addConstraint(button.dataset.constraint)));
  $('#add-comment-btn').addEventListener('click', () => {
    try {
      addComment(els.commentInput.value);
      els.commentInput.value = '';
    } catch (error) { setCanvasMessage(error.message); }
  });
  els.commentInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); $('#add-comment-btn').click(); }
  });

  els.nameInput.addEventListener('change', () => {
    const selected = getSelectedObject();
    if (selected && els.nameInput.value.trim()) patchObject(selected.id, { name: els.nameInput.value }, 'human', `Renamed ${selected.name}`);
  });
  $$('.number-input[data-transform]').forEach((input) => input.addEventListener('change', () => {
    const selected = getSelectedObject();
    if (!selected) return;
    const vector = [...selected[input.dataset.transform]];
    vector[Number(input.dataset.axis)] = safeNumber(input.value, vector[Number(input.dataset.axis)]);
    patchObject(selected.id, { [input.dataset.transform]: vector }, 'human', `Adjusted ${selected.name}`);
  }));
  $$('.material-chips button').forEach((button) => button.addEventListener('click', () => {
    const selected = getSelectedObject();
    if (selected) patchObject(selected.id, { material: button.dataset.material }, 'human', `Changed ${selected.name} finish`);
  }));
  $$('.color-swatch').forEach((button) => button.addEventListener('click', () => {
    const selected = getSelectedObject();
    if (selected) patchObject(selected.id, { color: button.dataset.color }, 'human', `Recolored ${selected.name}`);
  }));
  $('#object-color-input').addEventListener('input', (event) => {
    const selected = getSelectedObject();
    if (selected) patchObject(selected.id, { color: event.target.value }, 'human', `Recolored ${selected.name}`);
  });
  $$('#texture-chips button').forEach((button) => button.addEventListener('click', () => {
    const selected = getSelectedObject();
    if (selected) patchObject(selected.id, { texture: button.dataset.texture }, 'human', `Applied ${TEXTURES[button.dataset.texture].label.toLowerCase()} texture to ${selected.name}`);
  }));
  $$('#detail-chips button').forEach((button) => button.addEventListener('click', () => {
    const selected = getSelectedObject();
    if (selected) patchObject(selected.id, { detail: button.dataset.detail }, 'human', `Set ${DETAIL_LEVELS[button.dataset.detail].toLowerCase()} resolution on ${selected.name}`);
  }));
  /*
   * Surface sliders preview live in the viewport while dragging, then rewind to the
   * pre-drag value so the committed change lands as exactly one undoable history entry.
   */
  const bindSurfaceSlider = (selector, property, format, label) => {
    const input = $(selector);
    const readout = $(`${selector}-value`.replace('-input-value', '-value'));
    let previewOrigin = null;
    input.addEventListener('input', () => {
      readout.textContent = format(Number(input.value));
      const selected = getSelectedObject();
      if (!selected || isObjectLocked(selected.id)) return;
      if (previewOrigin === null) previewOrigin = { id: selected.id, value: selected[property] };
      selected[property] = Number(input.value);
      renderModel();
    });
    input.addEventListener('change', () => {
      const selected = getSelectedObject();
      if (!selected) { previewOrigin = null; return; }
      const value = Number(input.value);
      if (previewOrigin && previewOrigin.id === selected.id) selected[property] = previewOrigin.value;
      previewOrigin = null;
      patchObject(selected.id, { [property]: value }, 'human', `${label} on ${selected.name}`);
    });
  };
  bindSurfaceSlider('#texture-scale-input', 'textureScale', (value) => `${value.toFixed(2)}×`, 'Adjusted texture scale');
  bindSurfaceSlider('#roughness-input', 'roughness', (value) => value.toFixed(2), 'Adjusted roughness');
  bindSurfaceSlider('#metalness-input', 'metalness', (value) => value.toFixed(2), 'Adjusted metalness');

  /*
   * The viewport is the primary surface, so it can take the full width on demand.
   * Manual controls collapse away rather than competing with the model.
   */
  const focusViewportButton = $('#focus-viewport-btn');
  const setViewportFocus = (active) => {
    document.body.classList.toggle('viewport-focus', active);
    focusViewportButton.setAttribute('aria-pressed', String(active));
    focusViewportButton.classList.toggle('active', active);
    setCanvasMessage(active ? 'Viewport focus on — manual panels hidden' : 'Manual panels restored');
  };
  focusViewportButton.addEventListener('click', () => setViewportFocus(!document.body.classList.contains('viewport-focus')));

  els.agentForm.addEventListener('submit', (event) => { event.preventDefault(); handleAgentRequest(els.agentInput.value); });
  els.voiceButton.addEventListener('click', toggleVoiceInput);
  els.personaSelect.addEventListener('change', () => setProjectPersona(els.personaSelect.value));
  els.teachAgentButton.addEventListener('click', () => {
    els.agentInput.focus();
    els.agentInput.placeholder = 'e.g. Remember I prefer low-poly, mint-accented designs…';
    setCanvasMessage('Teach Orbit a preference that persists in this browser');
  });
  els.agentInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); handleAgentRequest(els.agentInput.value); }
  });
  $$('[data-prompt]').forEach((button) => button.addEventListener('click', () => handleAgentRequest(button.dataset.prompt)));
  $$('[data-mode]').forEach((button) => button.addEventListener('click', () => {
    state.currentMode = button.dataset.mode;
    $$('[data-mode]').forEach((candidate) => candidate.classList.toggle('active', candidate.dataset.mode === state.currentMode));
    els.modeHint.textContent = state.currentMode === 'planning' ? 'Planning mode — changes need your approval.' : 'Direct mode — plans apply instantly and remain undoable.';
    setCanvasMessage(state.currentMode === 'planning' ? 'Planning mode enabled' : 'Direct mode enabled');
    addActivity(`Switched to ${titleCase(state.currentMode)} mode`, state.currentMode === 'planning' ? 'Agent plans now wait for approval.' : 'Agent plans now apply as reversible batches.', 'human');
  }));

  $$('[data-agent-tab]').forEach((button) => button.addEventListener('click', () => {
    const tab = button.dataset.agentTab;
    $$('[data-agent-tab]').forEach((candidate) => {
      const active = candidate.dataset.agentTab === tab;
      candidate.classList.toggle('active', active);
      candidate.setAttribute('aria-selected', String(active));
    });
    $('#plan-panel').classList.toggle('hidden', tab !== 'plan');
    $('#activity-panel').classList.toggle('hidden', tab !== 'activity');
  }));
  $('#clear-activity-btn').addEventListener('click', () => {
    if (state.timeTravel.active) exitTimeTravel();
    state.activity = [];
    renderActivity();
  });
  els.timeTravelRange.addEventListener('input', (event) => {
    const index = Number(event.target.value);
    if (index === 0) exitTimeTravel(); else enterTimeTravel(index);
  });
  els.exitTimeTravelButton.addEventListener('click', exitTimeTravel);
  els.exitTimeTravelCanvasButton.addEventListener('click', exitTimeTravel);

  $('#permissions-btn').addEventListener('click', () => openModal('permissions-modal'));
  $$('[data-permission-preset]').forEach((button) => button.addEventListener('click', () => {
    const presets = {
      observe: { read: true, create: false, modify: false, delete: false, export: false, share: false },
      guided: { read: true, create: true, modify: true, delete: false, export: false, share: false },
      full: { read: true, create: true, modify: true, delete: true, export: true, share: true }
    };
    if (state.timeTravel.active) return setCanvasMessage('Return to the live scene before changing permissions');
    Object.assign(state.permissions, presets[button.dataset.permissionPreset]);
    $$('[data-permission]').forEach((input) => { input.checked = Boolean(state.permissions[input.dataset.permission]); });
    renderPermissionTier();
    persistWorkspace();
    addActivity(`Applied ${button.textContent.replace('*', '')} permission tier`, 'Human updated Orbit’s collaboration boundaries. Sensitive actions still require approval.', 'human');
  }));
  $$('[data-permission]').forEach((input) => {
    input.checked = Boolean(state.permissions[input.dataset.permission]);
    input.addEventListener('change', () => {
      state.permissions[input.dataset.permission] = input.checked;
      renderPermissionTier();
      addActivity(`${titleCase(input.dataset.permission)} permission ${input.checked ? 'enabled' : 'disabled'}`, 'Human updated agent capability boundaries.', 'human');
      persistWorkspace();
    });
  });
  $$('[data-close-modal]').forEach((button) => button.addEventListener('click', () => closeModal(button.dataset.closeModal)));
  $$('.modal-layer').forEach((layer) => layer.addEventListener('click', (event) => { if (event.target === layer) closeModal(layer.id); }));

  window.addEventListener('keydown', (event) => {
    const inTextField = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
    if (event.key === 'Escape') { $$('.modal-layer').forEach((layer) => layer.classList.add('hidden')); return; }
    if (inTextField) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) redoLastChange(); else undoLastChange();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redoLastChange(); return; }
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteSelected(); return; }
    if (event.key.toLowerCase() === 'v' && !event.metaKey && !event.ctrlKey) { event.preventDefault(); $('#focus-viewport-btn').click(); return; }
    const selected = getSelectedObject();
    if (!selected) return;
    const delta = event.shiftKey ? .5 : .15;
    const position = [...selected.position];
    if (event.key === 'ArrowLeft') position[0] -= delta;
    else if (event.key === 'ArrowRight') position[0] += delta;
    else if (event.key === 'ArrowUp') position[1] += delta;
    else if (event.key === 'ArrowDown') position[1] -= delta;
    else return;
    event.preventDefault();
    patchObject(selected.id, { position }, 'human', `Nudged ${selected.name}`);
  });
}

async function bootstrap() {
  initThree();
  bindEvents();
  const restored = loadPersistedWorkspace();
  const rememberedPreferences = clone(state.designContext.preferences || []);
  const rememberedPersona = state.designContext.persona;
  // An explicit share link is an intentional hand-off, so it wins over the local autosave.
  const loadedSharedScene = loadSharedSceneFromLocation();
  if (loadedSharedScene) {
    state.versions = [];
    state.currentVersionId = null;
    if (rememberedPreferences.length) {
      state.designContext = normaliseDesignContext({ ...state.designContext, preferences: rememberedPreferences, persona: rememberedPersona });
    }
  }
  if (loadedSharedScene) {
    createVersion('Shared start', 'system', false);
  } else if (restored.restoredScene) {
    if (!state.versions.length) createVersion('Restored session', 'system', false);
    renderVersions();
  } else {
    // A first checkpoint makes the empty start point recoverable, without pre-populating the human’s canvas.
    createVersion('Start', 'system', false);
  }
  defineTools();
  exposeLocalBridge();
  refreshUI({ scene: true });
  publishSelectionContext();
  initialiseVoiceInput();
  const readyDetail = restored.restoredScene
    ? `Restored your saved workspace: ${state.objects.length} object${state.objects.length === 1 ? '' : 's'} and ${state.versions.length} checkpoint${state.versions.length === 1 ? '' : 's'}.`
    : restored.restoredMemory
      ? 'The human and agent now share the same scene state and remembered project preferences.'
      : 'The human and agent now share the same inspectable scene state.';
  addActivity('Studio ready', readyDetail, 'agent');
  await registerWebMCPTools();
}

document.addEventListener('DOMContentLoaded', bootstrap);

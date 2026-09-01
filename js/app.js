import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.164.0/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.164.0/examples/jsm/controls/OrbitControls.js';
import { STLExporter } from 'https://cdn.jsdelivr.net/npm/three@0.164.0/examples/jsm/exporters/STLExporter.js';

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
  applyReviewButton: $('#apply-review-btn')
};

const TYPES = ['cube', 'sphere', 'cylinder', 'cone', 'torus', 'plane'];
const TYPE_LABELS = {
  cube: 'Cube', sphere: 'Sphere', cylinder: 'Cylinder', cone: 'Cone', torus: 'Torus', plane: 'Plane'
};
const TYPE_SYMBOLS = { cube: '◇', sphere: '○', cylinder: '▤', cone: '△', torus: '⊙', plane: '▱' };
const BASE_DIMENSIONS = {
  cube: [1, 1, 1], sphere: [1, 1, 1], cylinder: [1, 1, 1], cone: [1, 1, 1], torus: [1, .3, 1], plane: [1, .025, 1]
};
const MATERIALS = {
  metal: { label: 'Metal', color: '#9aa9d6', metalness: .88, roughness: .22 },
  plastic: { label: 'Soft polymer', color: '#8876ff', metalness: .15, roughness: .48 },
  glass: { label: 'Glass', color: '#8ccff5', metalness: .05, roughness: .08, transparent: true, opacity: .43 },
  wood: { label: 'Wood', color: '#c79067', metalness: .04, roughness: .78 },
  emissive: { label: 'Glow', color: '#52dfc3', metalness: .18, roughness: .23, emissive: true }
};
const COLOR_WORDS = {
  blue: '#8876ff', violet: '#8876ff', purple: '#8876ff', indigo: '#8876ff',
  mint: '#52dfc3', teal: '#52dfc3', green: '#52dfc3', cyan: '#52dfc3',
  orange: '#ff9c75', peach: '#ff9c75', coral: '#ff9c75'
};

const state = {
  objects: [],
  selectedId: null,
  constraints: [],
  comments: [],
  designContext: { intent: '', style: 'Exploratory', updatedAt: null, preferences: [] },
  history: [],
  historyIndex: -1,
  versions: [],
  currentVersionId: null,
  pendingProposal: null,
  lastAgentRun: null,
  activity: [],
  currentMode: 'planning',
  permissions: { read: true, create: true, modify: true, delete: false, export: false }
};

let scene;
let camera;
let renderer;
let controls;
let modelGroup;
let selectionBox;
let pointerDown = null;
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
    tags: Array.isArray(raw.tags) ? raw.tags.map((tag) => String(tag).slice(0, 32)).slice(0, 12) : []
  };
}

function snapshotScene() {
  return clone({
    objects: state.objects,
    selectedId: state.selectedId,
    constraints: state.constraints,
    comments: state.comments,
    designContext: state.designContext
  });
}

function hydrateScene(snapshot) {
  const source = snapshot || {};
  state.objects = Array.isArray(source.objects) ? source.objects.map(normaliseObject) : [];
  state.selectedId = state.objects.some((object) => object.id === source.selectedId) ? source.selectedId : null;
  state.constraints = Array.isArray(source.constraints) ? clone(source.constraints) : [];
  state.comments = Array.isArray(source.comments) ? clone(source.comments) : [];
  state.designContext = source.designContext ? clone(source.designContext) : { intent: '', style: 'Exploratory', updatedAt: null, preferences: [] };
}

function serialisedScene() {
  const statistics = getSceneStatistics();
  return {
    objects: clone(state.objects),
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

/* Three.js canvas */
function initThree() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color('#090d1c');
  scene.fog = new THREE.FogExp2('#090d1c', .034);

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

  const grid = new THREE.GridHelper(18, 18, 0x4c5685, 0x253252);
  grid.position.y = -.01;
  grid.material.transparent = true;
  grid.material.opacity = .48;
  scene.add(grid);

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(9.1, 64),
    new THREE.MeshBasicMaterial({ color: 0x111a35, transparent: true, opacity: .26, depthWrite: false })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -.025;
  scene.add(floor);

  const hemi = new THREE.HemisphereLight(0xcfd7ff, 0x101a32, 1.45);
  scene.add(hemi);
  const violetLight = new THREE.PointLight(0x8876ff, 17, 20, 2);
  violetLight.position.set(-5.2, 7, 4.8);
  scene.add(violetLight);
  const mintLight = new THREE.PointLight(0x52dfc3, 11, 14, 2);
  mintLight.position.set(5, 4.4, -3.5);
  scene.add(mintLight);
  const key = new THREE.DirectionalLight(0xffffff, 2.1);
  key.position.set(4.4, 9.4, 5.6);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  scene.add(key);

  modelGroup = new THREE.Group();
  modelGroup.name = 'Collaborative model';
  scene.add(modelGroup);

  selectionBox = new THREE.BoxHelper(undefined, 0x8876ff);
  selectionBox.material.transparent = true;
  selectionBox.material.opacity = .92;
  selectionBox.material.depthTest = false;
  selectionBox.visible = false;
  scene.add(selectionBox);

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

  renderer.domElement.addEventListener('pointerdown', (event) => {
    pointerDown = { x: event.clientX, y: event.clientY };
  });
  renderer.domElement.addEventListener('pointerup', (event) => {
    if (!pointerDown) return;
    const travel = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y);
    pointerDown = null;
    if (travel < 6) selectFromPointer(event);
  });

  const animate = () => {
    requestAnimationFrame(animate);
    controls.update();
    if (selectionBox.visible) selectionBox.update();
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

function makeGeometry(type) {
  switch (type) {
    case 'sphere': return new THREE.SphereGeometry(.5, 36, 24);
    case 'cylinder': return new THREE.CylinderGeometry(.5, .5, 1, 36);
    case 'cone': return new THREE.ConeGeometry(.5, 1, 36);
    case 'torus': return new THREE.TorusGeometry(.35, .14, 16, 36);
    case 'plane': return new THREE.PlaneGeometry(1, 1);
    case 'cube':
    default: return new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  }
}

function makeMaterial(object) {
  const preset = MATERIALS[object.material] || MATERIALS.plastic;
  const parameters = {
    color: new THREE.Color(validColor(object.color) ? object.color : preset.color),
    metalness: preset.metalness,
    roughness: preset.roughness,
    transparent: Boolean(preset.transparent),
    opacity: preset.opacity ?? 1
  };
  if (preset.emissive) {
    parameters.emissive = new THREE.Color(validColor(object.color) ? object.color : preset.color);
    parameters.emissiveIntensity = .93;
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
    const mesh = new THREE.Mesh(makeGeometry(object.type), makeMaterial(object));
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
}

function selectFromPointer(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  const pointer = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(pointer, camera);
  const intersections = raycaster.intersectObjects(modelGroup.children, false);
  selectObject(intersections.length ? intersections[0].object.userData.objectId : null);
}

function selectObject(id) {
  state.selectedId = state.objects.some((object) => object.id === id) ? id : null;
  renderObjectList();
  renderInspector();
  updateSelectionVisual();
  if (state.selectedId) {
    const selected = getSelectedObject();
    setCanvasMessage(`${selected.name} selected`);
  }
}

function getSelectedObject() {
  return state.objects.find((object) => object.id === state.selectedId) || null;
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
  camera.position.set(8.4, 6.4, 9.5);
  controls.target.set(0, 1.2, 0);
  controls.update();
  setCanvasMessage('Isometric view restored');
}

function focusScene() {
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
  renderVersions();
  renderProposal();
  renderActivity();
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
    const button = node('button', `object-row${object.id === state.selectedId ? ' active' : ''}`);
    button.type = 'button';
    button.dataset.objectId = object.id;
    const symbol = node('span', 'object-row-symbol', TYPE_SYMBOLS[object.type] || '◇');
    const name = node('span', 'object-row-name', object.name);
    const type = node('span', 'object-row-type', object.type);
    button.append(symbol, name, type);
    button.addEventListener('click', () => selectObject(object.id));
    els.objectList.append(button);
  });
}

function renderInspector() {
  const object = getSelectedObject();
  els.selectedStatus.textContent = object ? 'Active' : 'None';
  els.inspectorEmpty.classList.toggle('hidden', Boolean(object));
  els.inspectorContent.classList.toggle('hidden', !object);
  if (!object) return;

  els.nameInput.value = object.name;
  els.typeBadge.textContent = TYPE_LABELS[object.type];
  els.objectId.textContent = object.id;
  $$('.number-input[data-transform]').forEach((input) => {
    const vector = object[input.dataset.transform];
    input.value = Number(vector[Number(input.dataset.axis)]).toFixed(2);
  });
  $$('.material-chips button').forEach((button) => button.classList.toggle('active', button.dataset.material === object.material));
  $$('.color-swatch').forEach((button) => button.classList.toggle('active', button.dataset.color.toLowerCase() === object.color.toLowerCase()));
  $('#object-color-input').value = validColor(object.color) ? object.color : MATERIALS[object.material].color;
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
  if (action.kind === 'modify') return `Refine ${objectNameForId(action.objectId)}`;
  if (action.kind === 'delete') return `Remove ${objectNameForId(action.objectId)}`;
  if (action.kind === 'symmetrize') return 'Balance mirrored forms';
  if (action.kind === 'snap') return 'Snap selected forms to grid';
  if (action.kind === 'add_constraint') return `Add ${action.constraint.label || titleCase(action.constraint.type)} constraint`;
  if (action.kind === 'restore_version') return `Restore ${action.versionLabel || 'saved version'}`;
  if (action.kind === 'export') return 'Export STL model';
  return 'Refine shared scene';
}

function actionCounts(actions) {
  return actions.reduce((counts, action) => {
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

  const card = node('section', `proposal-card${proposal.status === 'applied' ? ' applied' : ''}`);
  const heading = node('div', 'proposal-heading');
  const headingCopy = node('div');
  headingCopy.append(node('span', 'eyebrow', proposal.status === 'applied' ? 'Applied agent run' : 'Agent proposal'), node('h3', '', proposal.title));
  const stateCopy = proposal.status === 'applying' ? 'Applying' : proposal.status === 'applied' ? 'Reversible' : 'Approval needed';
  heading.append(headingCopy, node('span', 'proposal-state', stateCopy));
  card.append(heading, node('p', 'proposal-description', proposal.description));

  const steps = node('div', 'plan-steps');
  proposal.actions.slice(0, 6).forEach((action, index) => {
    const step = node('div', 'plan-step');
    step.append(node('i', '', String(index + 1)), node('span', '', actionLabel(action)));
    steps.append(step);
  });
  if (proposal.actions.length > 6) steps.append(node('div', 'plan-step', `+ ${proposal.actions.length - 6} more considered changes`));
  card.append(steps);

  const counts = actionCounts(proposal.actions);
  const diff = node('div', 'proposal-diff');
  if (counts.add) diff.append(node('span', 'diff-pill add', `+ ${counts.add} form${counts.add === 1 ? '' : 's'}`));
  if (counts.change) diff.append(node('span', 'diff-pill change', `~ ${counts.change} refinement${counts.change === 1 ? '' : 's'}`));
  if (counts.remove) diff.append(node('span', 'diff-pill remove', `− ${counts.remove} removal${counts.remove === 1 ? '' : 's'}`));
  card.append(diff);

  const why = node('p', 'proposal-why');
  why.append(node('strong', '', 'Why:'), node('span', '', proposal.why || 'It follows the current design direction.'));
  card.append(why);

  if (proposal.status === 'draft') {
    const actions = node('div', 'proposal-actions');
    const approve = node('button', 'button button-primary', 'Approve & apply');
    approve.type = 'button';
    approve.addEventListener('click', executePendingProposal);
    const refine = node('button', 'button button-quiet', 'Modify');
    refine.type = 'button';
    refine.addEventListener('click', () => {
      els.agentInput.focus();
      els.agentInput.placeholder = 'Tell Orbit what to adjust in this plan…';
      setCanvasMessage('Describe the adjustment before you approve');
    });
    const reject = node('button', 'button button-quiet', 'Reject');
    reject.type = 'button';
    reject.addEventListener('click', discardDraftProposal);
    actions.append(approve, refine, reject);
    card.append(actions);
  } else if (proposal.status === 'applied') {
    const actions = node('div', 'proposal-actions applied-actions');
    const keep = node('button', 'button button-primary', 'Keep changes');
    keep.type = 'button';
    keep.addEventListener('click', keepAppliedProposal);
    const undo = node('button', 'button button-quiet', 'Undo agent run');
    undo.type = 'button';
    undo.addEventListener('click', revertLastAgentRun);
    actions.append(keep, undo);
    card.append(actions);
  } else {
    const applying = node('div', 'proposal-actions');
    const button = node('button', 'button button-quiet', 'Applying shared scene…');
    button.type = 'button';
    button.disabled = true;
    applying.append(button);
    card.append(applying);
  }
  els.proposalSlot.append(card);
}

function renderActivity() {
  els.activityList.replaceChildren();
  els.activityCount.textContent = String(state.activity.length);
  if (!state.activity.length) {
    els.activityList.append(node('p', 'activity-empty', 'Every agent and human operation will appear here with its reason.'));
    return;
  }
  state.activity.slice(0, 35).forEach((event) => {
    const item = node('article', `activity-item ${event.source || ''}`);
    item.append(node('i'));
    const copy = node('div');
    copy.append(node('strong', '', event.title), node('p', '', event.detail));
    const time = node('time', '', new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    item.append(copy, time);
    els.activityList.append(item);
  });
}

function addActivity(title, detail, source = 'agent') {
  state.activity.unshift({ id: makeId('event'), title, detail, source, timestamp: Date.now() });
  if (state.activity.length > 60) state.activity.pop();
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

/* Object creation and edits */
function createPrimitive(type, overrides = {}, source = 'human') {
  if (!TYPES.includes(type)) throw new Error(`Unsupported primitive: ${type}`);
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

function patchObject(objectId, patch, source = 'human', label) {
  const object = state.objects.find((candidate) => candidate.id === objectId);
  if (!object) throw new Error(`Object ${objectId} was not found.`);
  const cleanPatch = {};
  if (typeof patch.name === 'string' && patch.name.trim()) cleanPatch.name = patch.name.trim().slice(0, 48);
  if (patch.position) cleanPatch.position = cleanVector(patch.position, object.position);
  if (patch.rotation) cleanPatch.rotation = cleanVector(patch.rotation, object.rotation, { min: -Math.PI * 8, max: Math.PI * 8 });
  if (patch.scale) cleanPatch.scale = cleanVector(patch.scale, object.scale, { min: .05, max: 30 });
  if (MATERIALS[patch.material]) cleanPatch.material = patch.material;
  if (validColor(patch.color)) cleanPatch.color = patch.color;
  if (Array.isArray(patch.tags)) cleanPatch.tags = patch.tags.map((tag) => String(tag).slice(0, 32)).slice(0, 12);

  const result = applyMutation({ label: label || `Refined ${object.name}`, source, why: 'A form was refined in the shared scene.' }, () => Object.assign(object, cleanPatch));
  if (result.changed) addActivity(label || `Refined ${object.name}`, source === 'agent' ? 'Agent applied an approved targeted refinement.' : 'Human refined the selected form.', source);
  return state.objects.find((candidate) => candidate.id === objectId);
}

function duplicateSelected() {
  const selected = getSelectedObject();
  if (!selected) return setCanvasMessage('Select a form to duplicate');
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

function requestRestoreVersion(id) {
  const version = state.versions.find((candidate) => candidate.id === id);
  if (!version || version.id === state.currentVersionId) return;
  if (!window.confirm(`Restore “${version.label}”? Your current state stays in the undo history.`)) return;
  const result = applyMutation({ label: `Restored ${version.label}`, source: 'human', why: 'The human collaborator chose a prior version.' }, () => hydrateScene(version.snapshot));
  state.currentVersionId = version.id;
  if (result.changed) addActivity(`Restored ${version.label}`, 'Human returned to a prior design branch.', 'human');
}

/* Diagnostics: deterministic scene reading for agents and humans */
function objectBounds(object) {
  const dimensions = BASE_DIMENSIONS[object.type] || BASE_DIMENSIONS.cube;
  const half = dimensions.map((dimension, index) => Math.abs(dimension * object.scale[index]) / 2);
  return {
    min: object.position.map((value, index) => value - half[index]),
    max: object.position.map((value, index) => value + half[index]),
    center: [...object.position],
    size: half.map((value) => value * 2)
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
      recommendations: []
    };
  }
  const symmetry = checkSymmetry();
  const overlaps = findOverlaps();
  const bounds = calculateSceneBounds();
  const distinctMaterials = new Set(state.objects.map((object) => object.material)).size;
  const count = state.objects.length;
  const composition = clamp(Math.round(56 + Math.min(count, 9) * 4 + (bounds.size[0] > .4 && bounds.size[1] > .4 ? 8 : 0) - (Math.max(...bounds.size) / Math.max(Math.min(...bounds.size.filter((value) => value > .01), 1) > 12 ? 12 : 0)), 32, 98);
  const materials = clamp(72 + Math.min(distinctMaterials, 3) * 8 - (distinctMaterials > 4 ? 7 : 0), 42, 96);
  const geometry = clamp(96 - overlaps.length * 11, 25, 96);
  const constraintResults = validateConstraints();
  const failedConstraints = constraintResults.filter((result) => !result.valid);
  const score = clamp(Math.round((symmetry.score * .28) + (composition * .25) + (materials * .19) + (geometry * .28) - failedConstraints.length * 3), 0, 99);
  const findings = [];
  const recommendations = [];

  findings.push({ severity: symmetry.score >= 90 ? 'success' : 'warning', title: `Symmetry · ${symmetry.score}%`, detail: symmetry.score >= 90 ? 'The side-to-side balance reads consistently.' : `${symmetry.unmatched.length} form${symmetry.unmatched.length === 1 ? '' : 's'} could be mirrored or intentionally offset.` });
  if (overlaps.length) {
    findings.push({ severity: 'warning', title: `${overlaps.length} potential intersection${overlaps.length === 1 ? '' : 's'}`, detail: 'Some structural forms occupy the same volume. Inspect them before export.' });
  } else {
    findings.push({ severity: 'success', title: 'Clear form spacing', detail: 'No unintentional structural intersections were detected.' });
  }
  findings.push({ severity: materials >= 88 ? 'success' : 'info', title: `Material clarity · ${materials}%`, detail: distinctMaterials > 1 ? 'The finish palette gives the silhouette readable hierarchy.' : 'A secondary finish could clarify functional accents.' });
  failedConstraints.forEach((result) => findings.push({ severity: 'warning', title: result.constraint, detail: result.message }));
  if (symmetry.score < 92) recommendations.push('Prepare mirrored counterparts for unmatched side forms.');
  if (overlaps.length) recommendations.push('Review the intersecting structural forms before final export.');
  if (distinctMaterials < 2 && count > 2) recommendations.push('Use one accent finish to strengthen visual hierarchy.');

  return { score, symmetry: symmetry.score, composition, materials, geometry, overlaps, findings, recommendations, constraint_results: constraintResults };
}

function showDesignReview() {
  currentReview = analyseDesign();
  els.reviewScore.textContent = state.objects.length ? currentReview.score : '—';
  els.reviewSummary.textContent = state.objects.length
    ? `Orbit inspected ${state.objects.length} shared form${state.objects.length === 1 ? '' : 's'} using composition, symmetry, material clarity, and geometry checks.`
    : 'Add a model to receive a visual and geometric review.';
  els.reviewMetrics.replaceChildren();
  [
    ['Symmetry', currentReview.symmetry], ['Composition', currentReview.composition], ['Geometry', currentReview.geometry], ['Materials', currentReview.materials]
  ].forEach(([label, value]) => {
    const card = node('article', 'metric-card');
    const meter = node('span', 'metric-meter');
    const fill = node('i');
    fill.style.width = `${value}%`;
    meter.append(fill);
    card.append(node('span', '', label), node('strong', '', state.objects.length ? `${value}%` : '—'), meter);
    els.reviewMetrics.append(card);
  });
  els.reviewFindings.replaceChildren();
  currentReview.findings.forEach((finding) => {
    const item = node('article', `review-finding${finding.severity === 'warning' ? ' warning' : ''}`);
    item.append(node('i', '', finding.severity === 'warning' ? '!' : finding.severity === 'success' ? '✓' : '•'));
    const copy = node('div');
    copy.append(node('strong', '', finding.title), node('p', '', finding.detail));
    item.append(copy);
    els.reviewFindings.append(item);
  });
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
    style: detectStyle(input),
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
  const style = detectStyle(input);
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
  const selected = getSelectedObject();
  if (!selected) return null;
  const lower = input.toLowerCase();
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
    return { title: `Create a variation of ${selected.name}`, description: 'A nearby duplicate lets you compare two directions side by side.', why: 'Variants help you keep the original while exploring an alternative.', intent: input, style: detectStyle(input), actions: [{ kind: 'add', object: copy }] };
  }
  if (!Object.keys(patch).length) return null;
  return { title, description, why, intent: input, style: detectStyle(input), actions: [{ kind: 'modify', objectId: selected.id, patch }] };
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
    style: detectStyle(input),
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
      why: 'Symmetry is an explicit goal in your direction and is verified after the change.', intent: input, style: detectStyle(input), actions: [{ kind: 'symmetrize' }]
    };
  }
  if (/clear|delete everything|empty scene/.test(lower)) {
    return {
      title: 'Clear the shared scene', description: 'Remove all model forms and annotations. This destructive action remains reversible through history.',
      why: 'You asked to begin again with an empty canvas.', intent: input, style: detectStyle(input), actions: state.objects.map((object) => ({ kind: 'delete', objectId: object.id }))
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
    style: plan.style || detectStyle(plan.intent || ''),
    actions: clone(plan.actions || []),
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
    const patch = action.patch || {};
    if (patch.position) object.position = cleanVector(patch.position, object.position);
    if (patch.rotation) object.rotation = cleanVector(patch.rotation, object.rotation, { min: -Math.PI * 8, max: Math.PI * 8 });
    if (patch.scale) object.scale = cleanVector(patch.scale, object.scale, { min: .05, max: 30 });
    if (typeof patch.name === 'string') object.name = patch.name.slice(0, 48);
    if (MATERIALS[patch.material]) object.material = patch.material;
    if (validColor(patch.color)) object.color = patch.color;
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

async function executePendingProposal({ autoApproved = false } = {}) {
  const proposal = state.pendingProposal;
  if (!proposal || proposal.status !== 'draft') return { success: false, message: 'There is no pending proposal to apply.' };
  const blocked = findBlockedPermissions(proposal.actions);
  if (blocked.length) {
    const readable = blocked.map(titleCase).join(', ');
    setAgentStatus('blocked', 'Action blocked by permission', `Enable ${readable} in Agent permissions to continue.`);
    addMessage('agent', `I paused this plan because ${readable.toLowerCase()} permission is off. You can change that in the settings control.`);
    addActivity('Proposal blocked', `${readable} permission is disabled by the human collaborator.`, 'warning');
    showToast(`Permission required: ${readable}`, 'error');
    return { success: false, message: `Permission required: ${readable}` };
  }

  proposal.status = 'applying';
  renderProposal();
  setAgentStatus('thinking', 'Applying approved changes', 'Orbit is updating the shared scene, one auditable batch at a time.');
  await delay(240);
  if (state.pendingProposal !== proposal) return { success: false, message: 'The pending proposal changed before execution.' };

  try {
    const modelActions = proposal.actions.filter((action) => action.kind !== 'export');
    const execution = applyMutation({ label: proposal.title, source: 'agent', why: proposal.why, runId: proposal.id }, () => {
      modelActions.forEach(executeAction);
    });
    proposal.status = 'applied';
    proposal.historyEntryId = execution.entry?.id || null;
    proposal.before = execution.before;
    state.lastAgentRun = { proposalId: proposal.id, historyEntryId: execution.entry?.id || null, before: execution.before };
    if (proposal.actions.some((action) => action.kind === 'export')) exportSTL();
    renderProposal();
    setAgentStatus('ready', 'Changes applied — your call', 'Keep the run, undo it, or continue directing the next iteration.');
    addMessage('agent', `Applied “${proposal.title}”. ${proposal.why || 'The full batch is still reversible while you review it.'}`);
    addActivity(`Applied “${proposal.title}”`, `${proposal.actions.length} approved operation${proposal.actions.length === 1 ? '' : 's'} changed the shared scene.`, 'agent');
    setCanvasMessage(autoApproved ? 'Direct mode applied the agent run' : 'Agent run applied — review it');
    return { success: true, proposal_id: proposal.id, message: 'Approved proposal applied.' };
  } catch (error) {
    proposal.status = 'draft';
    renderProposal();
    setAgentStatus('blocked', 'Could not apply the plan', error.message);
    addActivity('Proposal execution failed', error.message, 'warning');
    return { success: false, message: error.message };
  }
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
  if (!proposal || proposal.status !== 'applied') return;
  state.pendingProposal = null;
  renderProposal();
  updateSummary();
  setAgentStatus('ready', 'Run accepted', 'The shared scene is ready for the next collaborative step.');
  addActivity(`Kept “${proposal.title}”`, 'Human accepted the completed agent run.', 'human');
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

async function handleAgentRequest(text) {
  const request = String(text || '').trim();
  if (!request) return;
  const lower = request.toLowerCase();
  const nonce = ++agentRequestNonce;
  els.agentInput.value = '';
  addMessage('human', request);

  if (/^(stop|pause|wait)\b/.test(lower)) {
    state.pendingProposal = state.pendingProposal?.status === 'applying' ? null : state.pendingProposal;
    renderProposal();
    setAgentStatus('ready', 'Agent paused', 'I stopped before making another change.');
    addMessage('agent', 'Paused. I will not make further changes until you give a new direction.');
    addActivity('Agent interrupted', 'Human paused the current collaboration flow.', 'human');
    return;
  }
  if (/\bundo\b|go back|revert/.test(lower)) {
    if (state.pendingProposal?.status === 'applied') revertLastAgentRun();
    else undoLastChange();
    return;
  }
  if (/review|diagnos|check (the )?(scene|model)|is my model good/.test(lower)) {
    setAgentStatus('thinking', 'Inspecting the shared scene', 'Reading geometry, material, symmetry, and active constraints.');
    await delay(260);
    if (nonce !== agentRequestNonce) return;
    showDesignReview();
    setAgentStatus('ready', 'Review ready', 'I surfaced clear findings and safe next steps.');
    addMessage('agent', 'I completed a design review. Open the review card for the score, findings, and any safe improvement proposal.');
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
  if (state.currentMode === 'direct') await executePendingProposal({ autoApproved: true });
}

/* WebMCP tools: goal-oriented and state-aware instead of a long list of UI clicks */
function registerTool(definition) {
  toolRegistry.set(definition.name, definition);
}

function readAllowed() {
  if (state.permissions.read) return null;
  return { success: false, message: 'Scene read permission is disabled by the human collaborator.' };
}

function stageExternalPlan(plan) {
  const blockedRead = readAllowed();
  if (blockedRead) return blockedRead;
  const proposal = stageProposal(plan);
  return {
    success: true,
    requires_human_approval: true,
    proposal_id: proposal.id,
    proposal: { title: proposal.title, description: proposal.description, action_count: proposal.actions.length, status: proposal.status }
  };
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
      const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
      const aliases = { left: ['left', 'port'], right: ['right', 'starboard'], wheel: ['wheel', 'propulsion'], window: ['window', 'glass'], engine: ['engine', 'propulsion'] };
      const objects = state.objects.filter((object) => {
        const corpus = `${object.name} ${object.type} ${object.material} ${object.tags.join(' ')}`.toLowerCase();
        return words.every((word) => (aliases[word] || [word]).some((term) => corpus.includes(term)));
      });
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
    name: 'get_history',
    description: 'Read a concise, auditable history of human and agent scene changes. Snapshots are intentionally omitted from the tool result.',
    parameters: { type: 'object', properties: { limit: { type: 'number', minimum: 1, maximum: 50 } }, required: [] },
    execute: async ({ limit = 20 } = {}) => readAllowed() || ({ success: true, history: state.history.slice(Math.max(0, state.history.length - clamp(safeNumber(limit, 20), 1, 50))).map(({ id, label, source, why, runId, timestamp }) => ({ id, label, source, why, run_id: runId, timestamp })), active_history_index: state.historyIndex })
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
    description: 'Generate a URL-safe link encoding the current scene state for collaboration. No network upload is performed.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => readAllowed() || ({ success: true, share_url: generateShareLink() })
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
    getScene: () => serialisedScene()
  });
}

/* Export and shared state */
function exportSTL() {
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

  els.agentForm.addEventListener('submit', (event) => { event.preventDefault(); handleAgentRequest(els.agentInput.value); });
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
  $('#clear-activity-btn').addEventListener('click', () => { state.activity = []; renderActivity(); });

  $('#permissions-btn').addEventListener('click', () => openModal('permissions-modal'));
  $$('[data-permission]').forEach((input) => {
    input.checked = Boolean(state.permissions[input.dataset.permission]);
    input.addEventListener('change', () => {
      state.permissions[input.dataset.permission] = input.checked;
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
  const loadedSharedScene = loadSharedSceneFromLocation();
  if (!loadedSharedScene) {
    // A first checkpoint makes the empty start point recoverable, without pre-populating the human’s canvas.
    createVersion('Start', 'system', false);
  } else {
    createVersion('Shared start', 'system', false);
  }
  defineTools();
  exposeLocalBridge();
  refreshUI({ scene: true });
  addActivity('Studio ready', 'The human and agent now share the same inspectable scene state.', 'agent');
  await registerWebMCPTools();
}

document.addEventListener('DOMContentLoaded', bootstrap);

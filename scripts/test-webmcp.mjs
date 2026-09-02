#!/usr/bin/env node
/**
 * WebMCP protocol conformance.
 *
 * Verifies the agent-facing contract itself: manifest shape, tool discovery,
 * error envelopes, batch semantics, bridge registration, and — critically —
 * that no human-approval concept survives anywhere in the surface.
 */

import { createOrbitServer, registerOrbit } from '../js/webmcp.js';
import { TOOL_SCHEMAS, TOOL_NAMES } from '../js/scene.js';
import { readFileSync, readdirSync } from 'node:fs';

let passed = 0;
const failures = [];
const check = (name, condition, detail = '') => {
  if (condition) passed += 1;
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

/* ------------------------------------------------------- 1. manifest */

const server = createOrbitServer();
const manifest = server.manifest();

check('manifest declares the webmcp protocol', manifest.protocol === 'webmcp');
check('manifest carries a version', typeof manifest.version === 'string' && manifest.version.length > 0);
check('manifest declares full autonomy', manifest.autonomy === 'full');
check('manifest declares no human in the loop', manifest.human_in_the_loop === false);
check('manifest lists every tool', manifest.tools.length === TOOL_SCHEMAS.length);
check('manifest is JSON-serialisable', (() => { try { JSON.parse(JSON.stringify(manifest)); return true; } catch { return false; } })());

/* -------------------------------------------------- 2. tool discovery */

check('listTools matches the schema table', server.listTools().length === TOOL_SCHEMAS.length);
check('toolNames matches the name table', server.toolNames().join() === TOOL_NAMES.join());
check('every tool declares a parameters object', TOOL_SCHEMAS.every((tool) => typeof tool.parameters === 'object'));
check('every tool description is substantive', TOOL_SCHEMAS.every((tool) => tool.description.length >= 25));

// The 13 tools named in the product brief must all exist.
const REQUIRED = [
  'create_object', 'delete_object', 'duplicate_object', 'move_object', 'rotate_object',
  'scale_object', 'set_material', 'set_camera', 'group_objects', 'boolean_operation',
  'undo', 'inspect_scene', 'select_object'
];
for (const name of REQUIRED) {
  check(`required tool "${name}" is exposed`, TOOL_NAMES.includes(name));
}

/* ----------------------------------------------------- 3. call envelope */

const created = server.call('create_object', { type: 'cube', name: 'Probe' });
check('successful call returns ok:true', created.ok === true);
check('successful call returns the object', Boolean(created.object?.id));

const unknown = server.call('summon_demon', {});
check('unknown tool returns ok:false', unknown.ok === false);
check('unknown tool is coded', unknown.code === 'UNKNOWN_TOOL');
check('unknown tool lists alternatives', Array.isArray(unknown.available) && unknown.available.length > 0);
check('unknown tool does not throw', true);

const bad = server.call('create_object', { type: 'blackhole' });
check('tool error returns ok:false', bad.ok === false);
check('tool error is coded', bad.code === 'TOOL_ERROR');
check('tool error carries a message', typeof bad.error === 'string' && bad.error.length > 0);
check('tool error carries a self-correction hint', typeof bad.hint === 'string' && bad.hint.length > 0);

// An autonomous agent needs actionable hints, not just failures.
check('missing-object error hints at inspect_scene', /inspect_scene/.test(server.call('move_object', { id: 'ghost' }).hint));
check('material error hints at list_capabilities', /list_capabilities/.test(server.call('set_material', { id: created.object.id, material: 'unobtanium' }).hint));

/* ---------------------------------------------------------- 4. batch */

const fresh = createOrbitServer();
const batch = fresh.batch([
  { tool: 'create_object', args: { id: 'a', type: 'cube', name: 'A' } },
  { tool: 'create_object', args: { id: 'b', type: 'sphere', name: 'B', params: { radius: 0.6 } } },
  { tool: 'select_object', args: { ids: ['a', 'b'] } },
  { tool: 'boolean_operation', args: { operation: 'union' } }
]);
check('a valid batch reports ok', batch.ok === true, JSON.stringify(batch.results?.slice(-1)));
check('a valid batch completes every call', batch.completed === 4);
check('a batch can build on its own selection', fresh.call('inspect_scene', {}).object_count === 1);

// The common agent idiom — create several, then operate on all of them.
const chained = createOrbitServer().batch([
  { tool: 'create_object', args: { id: 'x', type: 'cube' } },
  { tool: 'create_object', args: { id: 'y', type: 'cylinder', params: { radius: 0.3, height: 3 } } },
  { tool: 'boolean_operation', args: { ids: ['x', 'y'], operation: 'subtract' } },
  { tool: 'validate_scene', args: {} }
]);
check('explicit-id chaining works', chained.ok === true, JSON.stringify(chained.results?.slice(-1)));
check('drilled result validates cleanly', chained.results.at(-1).result.valid === true);

const halting = createOrbitServer().batch([
  { tool: 'create_object', args: { type: 'cube' } },
  { tool: 'create_object', args: { type: 'blackhole' } },
  { tool: 'create_object', args: { type: 'sphere' } }
]);
check('a failing batch halts', halting.ok === false);
check('a failing batch reports where it stopped', halting.failed_at === 'create_object');
check('a failing batch reports completed count', halting.completed === 1);

const resilient = createOrbitServer().batch([
  { tool: 'create_object', args: { type: 'blackhole' }, continue_on_error: true },
  { tool: 'create_object', args: { type: 'cube' } }
]);
check('continue_on_error keeps going', resilient.ok === true && resilient.completed === 2);

/* ------------------------------------------------- 5. event streaming */

const observer = createOrbitServer();
const seen = [];
const unsubscribe = observer.subscribe((event) => seen.push(event));
observer.call('create_object', { type: 'cube' });
observer.call('nope', {});
check('subscribers receive successful calls', seen.some((e) => e.type === 'call' && e.tool === 'create_object'));
check('subscribers receive failures', seen.some((e) => e.type === 'error'));
check('events carry timing', seen.every((e) => typeof e.ms === 'number'));
unsubscribe();
const before = seen.length;
observer.call('create_object', { type: 'cube' });
check('unsubscribe stops delivery', seen.length === before);
check('getLog retains history', observer.getLog().length > 0);

check('a throwing subscriber cannot break the kernel', (() => {
  const s = createOrbitServer();
  s.subscribe(() => { throw new Error('bad listener'); });
  return s.call('create_object', { type: 'cube' }).ok === true;
})());

/* ------------------------------------------------ 6. bridge registration */

const fakeWindow = { navigator: {}, addEventListener() { this._listening = true; } };
const bridges = registerOrbit(createOrbitServer(), fakeWindow);
check('the in-page bridge always registers', bridges.includes('window.orbit'));
check('window.orbit is exposed', typeof fakeWindow.orbit === 'object');
check('window.orbit is frozen', Object.isFrozen(fakeWindow.orbit));
check('window.orbit exposes call', typeof fakeWindow.orbit.call === 'function');
check('postMessage bridge registers when possible', bridges.includes('postMessage'));

const registered = [];
const nativeWindow = {
  navigator: { modelContext: { registerTool: (tool) => registered.push(tool.name) } },
  addEventListener() {}
};
const nativeBridges = registerOrbit(createOrbitServer(), nativeWindow);
check('native modelContext bridge registers', nativeBridges.includes('navigator.modelContext'));
check('every tool registers natively', registered.length === TOOL_SCHEMAS.length);
check('native tools expose an execute handler', true);

const brokenWindow = {
  navigator: { modelContext: { registerTool: () => { throw new Error('bridge exploded'); } } },
  addEventListener() {}
};
check('a broken native bridge does not block the in-page one',
  registerOrbit(createOrbitServer(), brokenWindow).includes('window.orbit'));

/* ------------------------------ 6b. postMessage origin policy (Qodo #17) */

function messageRoot(origin) {
  const root = {
    navigator: {},
    location: { origin },
    handlers: {},
    addEventListener(type, fn) { this.handlers[type] = fn; }
  };
  return root;
}

{
  const server = createOrbitServer();
  server.call('create_object', { type: 'cube' });
  const root = messageRoot('https://studio.example');
  const evil = { posted: [], postMessage: (payload, target) => evil.posted.push({ payload, target }) };
  registerOrbit(server, root);
  const emit = (origin, source, extra = {}) => root.handlers.message({ origin, source, data: { channel: 'orbit', id: 1, ...extra } });
  const count = () => server.scene.objects.size;

  emit('https://evil.example', evil, { type: 'call', tool: 'clear_scene' });
  check('untrusted origin is not dispatched', count() === 1);
  check('untrusted sender receives a coded refusal',
    evil.posted.length === 1 && evil.posted[0].payload.type === 'rejected' && evil.posted[0].payload.result.code === 'UNTRUSTED_ORIGIN');
  check('refusals are targeted at the sender origin, never *', evil.posted[0].target === 'https://evil.example');

  server.configure({ trustedOrigins: ['https://agent.example'] });
  emit('https://agent.example', evil, { type: 'call', tool: 'clear_scene' });
  check('an explicitly trusted origin is dispatched', count() === 0);
  check('trusted replies stay targeted at the sender origin', evil.posted.at(-1).target === 'https://agent.example');
  check('trusted replies carry the result, not a refusal', evil.posted.at(-1).payload.type === 'result');

  // Same-origin senders are always accepted.
  const sameServer = createOrbitServer();
  sameServer.call('create_object', { type: 'cube' });
  const sameRoot = messageRoot('https://studio.example');
  const sameSource = { posted: [], postMessage: (p, t) => sameSource.posted.push({ p, t }) };
  registerOrbit(sameServer, sameRoot);
  sameRoot.handlers.message({ origin: 'https://studio.example', source: sameSource, data: { channel: 'orbit', id: 2, type: 'call', tool: 'clear_scene' } });
  check('same-origin senders are accepted', sameServer.scene.objects.size === 0);
  check('same-origin replies target the origin', sameSource.posted.at(-1).t === 'https://studio.example');

  // Self-posted control (source === root) is accepted.
  const selfServer = createOrbitServer();
  selfServer.call('create_object', { type: 'cube' });
  const selfRoot = messageRoot('https://studio.example');
  registerOrbit(selfServer, selfRoot);
  selfRoot.handlers.message({ origin: 'null', source: selfRoot, data: { channel: 'orbit', id: 3, type: 'call', tool: 'clear_scene' } });
  check('self-posted control is accepted', selfServer.scene.objects.size === 0);

  // Sandboxed embeds (opaque "null" origin) need an explicit opt-in.
  const sbServer = createOrbitServer();
  sbServer.call('create_object', { type: 'cube' });
  const sbRoot = messageRoot('https://studio.example');
  const sbSource = { posted: [], postMessage: (p, t) => sbSource.posted.push({ p, t }) };
  registerOrbit(sbServer, sbRoot);
  sbRoot.handlers.message({ origin: 'null', source: sbSource, data: { channel: 'orbit', id: 4, type: 'call', tool: 'clear_scene' } });
  check('sandboxed (opaque) frames are refused by default', sbServer.scene.objects.size === 1);
  sbServer.configure({ allowSandboxedFrames: true });
  sbRoot.handlers.message({ origin: 'null', source: sbSource, data: { channel: 'orbit', id: 5, type: 'call', tool: 'clear_scene' } });
  check('opting in allows sandboxed frames', sbServer.scene.objects.size === 0);
  check('opaque-origin replies use the null target', sbSource.posted.at(-1).t === '*');
}

/* -------------------------------- 7. no human-approval concept survives */

const BANNED = [
  'requiresHumanApproval', 'apply_approved_proposal', 'propose_changes',
  'proposal', 'approve', 'permission', 'human_approval', 'awaitingApproval'
];
const sources = readdirSync(new URL('../js', import.meta.url))
  .filter((file) => file.endsWith('.js'))
  .map((file) => ({ file, text: readFileSync(new URL(`../js/${file}`, import.meta.url), 'utf8') }));

for (const term of BANNED) {
  // Prose in comments is allowed to *mention* the removed model; code is not.
  const offenders = sources.filter(({ text }) => {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    return new RegExp(`\\b${term}\\b`).test(code);
  });
  check(`no code references "${term}"`, offenders.length === 0, offenders.map((o) => o.file).join(', '));
}

check('no tool name implies approval', !TOOL_NAMES.some((name) => /approv|propos|permission|consent/i.test(name)));
check('no tool description promises human review',
  !TOOL_SCHEMAS.some((tool) => /human (?:approval|review)|ask the user|await approval/i.test(tool.description)));

// Sensitive operations must execute directly — the agent has full authority.
const authority = createOrbitServer();
authority.call('create_object', { type: 'cube' });
check('delete executes immediately', authority.call('clear_scene', {}).ok === true);
check('export executes immediately', (() => {
  const s = createOrbitServer();
  s.call('create_object', { type: 'cube' });
  return s.call('export_scene', { format: 'stl' }).ok === true;
})());

/* ------------------------------------------------------------- report */

console.log(`\nOrbit WebMCP conformance: ${passed}/${passed + failures.length} checks passed`);
if (failures.length) {
  console.error('\nFailures:');
  failures.forEach((failure) => console.error(`  ✗ ${failure}`));
} else {
  console.log(`Verified: manifest · discovery (${TOOL_NAMES.length} tools) · error envelopes · batch semantics · event stream · 3 bridges · zero approval surface`);
}
process.exitCode = failures.length ? 1 : 0;

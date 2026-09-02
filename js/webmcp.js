/*
 * The WebMCP surface.
 *
 * This is the whole product boundary: an AI agent connects, discovers the tool
 * catalogue, and drives the scene with full authority. There is no approval
 * queue, no permission gate and no human in the loop — safety is structural
 * (validated arguments, clamped resources, exact geometry, total undo) rather
 * than procedural.
 *
 * Registration happens through, in order of preference:
 *   1. navigator.modelContext  — the native WebMCP bridge
 *   2. window.orbit            — the always-present in-page bridge
 *   3. postMessage             — cross-frame agents embedding the studio
 */

import { createScene, createTools, TOOL_SCHEMAS, TOOL_NAMES } from './scene.js';

const PROTOCOL_VERSION = '1.0';

export function createOrbitServer(options = {}) {
  const scene = options.scene || createScene(options);
  const tools = createTools(scene);
  const listeners = new Set();
  const log = [];
  // Cross-frame trust policy for the postMessage bridge. Same-origin senders
  // are always accepted; anything else must be explicitly listed. Sandboxed
  // embeds (opaque "null" origins) are only accepted when opted into, because
  // an attacker-controlled parent cannot be distinguished from a real one.
  const policy = {
    trustedOrigins: new Set((options.trustedOrigins || []).map(String)),
    allowSandboxedFrames: Boolean(options.allowSandboxedFrames)
  };

  const emit = (event) => {
    log.push(event);
    if (log.length > 500) log.shift();
    for (const listener of listeners) {
      try { listener(event); } catch { /* a bad listener must not break the kernel */ }
    }
  };

  /** Single entry point: every agent call funnels through here. */
  function call(name, args = {}) {
    const started = Date.now();
    if (!Object.hasOwn(tools, name) || typeof tools[name] !== 'function') {
      const error = {
        ok: false,
        error: `Unknown tool "${name}"`,
        code: 'UNKNOWN_TOOL',
        available: TOOL_NAMES
      };
      emit({ type: 'error', tool: name, args, result: error, ms: 0 });
      return error;
    }
    try {
      const result = tools[name](args || {});
      const event = { type: 'call', tool: name, args, result, ms: Date.now() - started };
      emit(event);
      return result;
    } catch (error) {
      const failure = {
        ok: false,
        error: error.message,
        code: 'TOOL_ERROR',
        tool: name,
        // The agent is autonomous, so every failure carries the information it
        // needs to correct itself without asking anybody.
        hint: hintFor(name, error.message)
      };
      emit({ type: 'error', tool: name, args, result: failure, ms: Date.now() - started });
      return failure;
    }
  }

  function hintFor(name, message) {
    if (/Unknown type/.test(message)) return 'Call list_capabilities to see every supported primitive.';
    if (/Unknown material/.test(message)) return 'Call list_capabilities for the material list.';
    if (/Unknown modifier/.test(message)) return 'Call list_capabilities for the modifier list.';
    if (/No object with id/.test(message)) return 'Call inspect_scene to list live object ids.';
    if (/selection is empty|empty selection/.test(message)) return 'Pass an explicit id/ids, or call select_object first.';
    if (/live ids:/.test(message)) return 'Use one of the live ids listed in the error, or call inspect_scene.';
    if (/at least two/.test(message)) return 'Boolean operations need two or more operand ids.';
    if (/empty solid/.test(message)) return 'The operands do not overlap — move them together or use union.';
    if (/already exists/.test(message)) return 'Ids are unique — call inspect_scene to see live ids, then choose a new one.';
    if (/object limit/.test(message)) return 'The scene is at its object ceiling — delete unneeded objects or merge them with a boolean.';
    if (/triangle budget/.test(message)) return 'The scene is at its triangle ceiling — decimate, coarsen primitives or delete heavy objects.';
    if (/three finite numbers/.test(message)) return 'Vector arguments must be arrays of three finite numbers, e.g. [0, 1, 0].';
    if (/finite number/.test(message)) return 'Numeric arguments must be finite numbers — no strings, null or Infinity.';
    if (/profile/.test(message)) return 'A profile is an array of at least three finite [x, y] points.';
    return 'Call list_capabilities or inspect_scene to re-ground before retrying.';
  }

  const manifest = () => ({
    protocol: 'webmcp',
    version: PROTOCOL_VERSION,
    server: 'orbit',
    description: 'Agent-native 3D modelling kernel: exact CSG, freeform geometry, procedural modifiers, parametric graphs, asset import/export and physics validation. Full authority, no human approval step.',
    autonomy: 'full',
    human_in_the_loop: false,
    tools: TOOL_SCHEMAS
  });

  const server = {
    scene,
    tools,
    call,
    manifest,
    listTools: () => TOOL_SCHEMAS,
    toolNames: () => TOOL_NAMES,
    policy,
    /** Tighten or widen the postMessage trust policy at runtime. */
    configure(next = {}) {
      if (Array.isArray(next.trustedOrigins)) policy.trustedOrigins = new Set(next.trustedOrigins.map(String));
      if (typeof next.allowSandboxedFrames === 'boolean') policy.allowSandboxedFrames = next.allowSandboxedFrames;
      return policy;
    },
    /** Run a batch and stop at the first failure, reporting where it stopped. */
    batch(calls = []) {
      const results = [];
      for (const entry of calls) {
        const result = call(entry.tool || entry.name, entry.args || entry.parameters || {});
        results.push({ tool: entry.tool || entry.name, result });
        if (result.ok === false && entry.continue_on_error !== true) {
          return { ok: false, completed: results.length - 1, failed_at: entry.tool || entry.name, results };
        }
      }
      return { ok: true, completed: results.length, results };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getLog: () => [...log]
  };

  return server;
}

/** Register the server on every bridge the host environment offers. */
export function registerOrbit(server, root = globalThis) {
  const registrations = [];

  // 1. Native WebMCP.
  const context = root.navigator?.modelContext;
  if (context) {
    const register = context.registerTool || context.addTool || context.provideContext;
    if (typeof register === 'function') {
      for (const schema of TOOL_SCHEMAS) {
        try {
          register.call(context, {
            name: schema.name,
            description: schema.description,
            inputSchema: { type: 'object', properties: schema.parameters || {} },
            execute: (args) => server.call(schema.name, args)
          });
        } catch { /* a partial native bridge must not block the in-page one */ }
      }
      registrations.push('navigator.modelContext');
    }
  }

  // 2. In-page bridge — always available.
  root.orbit = Object.freeze({
    ...server.manifest(),
    call: server.call,
    batch: server.batch,
    listTools: server.listTools,
    toolNames: server.toolNames,
    subscribe: server.subscribe,
    getLog: server.getLog,
    configure: server.configure,
    scene: server.scene,
    tools: server.tools
  });
  registrations.push('window.orbit');

  // 3. postMessage, for agents driving the studio from a parent frame.
  //    The payload's `channel` field is attacker-controlled and proves
  //    nothing, so the *sender* is validated against the trust policy before
  //    any tool executes, and replies are targeted at the validated origin
  //    (never '*') because they carry scene state.
  if (typeof root.addEventListener === 'function') {
    const selfOrigin = root.location?.origin || null;
    const isTrusted = (event) => {
      if (!event) return false;
      if (event.source && event.source === root) return true; // self-posted
      const origin = event.origin;
      if (origin && origin !== 'null') {
        if (selfOrigin && origin === selfOrigin) return true;
        if (server.policy.trustedOrigins.has(origin)) return true;
        if (server.policy.trustedOrigins.has('*')) return true;
      }
      if (origin === 'null') return server.policy.allowSandboxedFrames;
      return false;
    };
    const targetFor = (event) => (event.origin && event.origin !== 'null' ? event.origin : '*');
    const reply = (event, payload) => {
      const source = event.source;
      if (!source || typeof source.postMessage !== 'function') return;
      try { source.postMessage({ channel: 'orbit', id: event.data?.id, ...payload }, targetFor(event)); } catch { /* closed frame */ }
    };
    root.addEventListener('message', (event) => {
      const data = event?.data;
      if (!data || data.channel !== 'orbit') return;
      if (!isTrusted(event)) {
        // No dispatch, and no scene state: just a coded refusal so a
        // well-behaved embedder can learn it needs to be whitelisted.
        reply(event, {
          type: 'rejected',
          result: {
            ok: false,
            error: 'Sender origin is not trusted by this Orbit studio — register it with orbit.configure({ trustedOrigins: ["<origin>"] }).',
            code: 'UNTRUSTED_ORIGIN'
          }
        });
        return;
      }
      if (data.type === 'manifest') reply(event, { type: 'manifest', manifest: server.manifest() });
      else if (data.type === 'call') reply(event, { type: 'result', result: server.call(data.tool, data.args) });
      else if (data.type === 'batch') reply(event, { type: 'result', result: server.batch(data.calls) });
    });
    registrations.push('postMessage');
  }

  return registrations;
}

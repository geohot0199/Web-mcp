/*
 * Parametric geometry node graph.
 *
 * Instead of imperative one-shot tool calls, an agent can define a reusable
 * DAG of geometry nodes with named parameters, then re-evaluate it with new
 * values. This is what makes a design *parametric*: change `rotor_count` from
 * 4 to 6 and the whole drone rebuilds, deterministically.
 *
 * A graph is plain JSON, so it round-trips through tool calls untouched.
 */

import { buildPrimitive } from './primitives.js';
import { booleanOperation, union, subtract, intersect } from './csg.js';
import { applyStack, MODIFIERS } from './modifiers.js';
import { transformMesh, compose, mergeMeshes, bounds, volume, triangleCount } from './geom.js';

export const NODE_TYPES = {
  primitive: { inputs: 0, description: 'Create a base solid from a primitive type and parameters.' },
  transform: { inputs: 1, description: 'Translate / rotate / scale the input solid.' },
  boolean: { inputs: 2, description: 'union · subtract · intersect · xor over two or more inputs.' },
  modifier: { inputs: 1, description: 'Apply one procedural modifier (array, mirror, twist, shell…).' },
  merge: { inputs: 2, description: 'Combine inputs into one mesh without a boolean solve.' },
  extrude: { inputs: 0, description: 'Extrude a 2D profile into a solid.' },
  revolve: { inputs: 0, description: 'Revolve a 2D profile around Y.' },
  expression: { inputs: 0, description: 'Compute a scalar from graph parameters.' },
  output: { inputs: 1, description: 'Terminal node — the graph result.' }
};

/** Safe arithmetic expression evaluator (no eval, no Function). */
export function evaluateExpression(expression, scope = {}) {
  const tokens = String(expression).match(/\d+\.?\d*|[a-zA-Z_][a-zA-Z0-9_]*|[+\-*/%()^,]|\S/g) || [];
  let position = 0;
  const peek = () => tokens[position];
  const next = () => tokens[position++];

  const FUNCTIONS = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan, sqrt: Math.sqrt, abs: Math.abs,
    floor: Math.floor, ceil: Math.ceil, round: Math.round,
    min: Math.min, max: Math.max, pow: Math.pow, atan2: Math.atan2
  };
  const CONSTANTS = { pi: Math.PI, tau: Math.PI * 2, e: Math.E };

  function parsePrimary() {
    const token = next();
    if (token === undefined) throw new Error('expression: unexpected end');
    if (token === '(') {
      const value = parseAdditive();
      if (next() !== ')') throw new Error('expression: expected )');
      return value;
    }
    if (token === '-') return -parsePrimary();
    if (token === '+') return parsePrimary();
    if (/^\d/.test(token)) return Number(token);
    if (FUNCTIONS[token]) {
      if (next() !== '(') throw new Error(`expression: ${token} needs (`);
      const args = [];
      if (peek() !== ')') {
        args.push(parseAdditive());
        while (peek() === ',') { next(); args.push(parseAdditive()); }
      }
      if (next() !== ')') throw new Error('expression: expected )');
      return FUNCTIONS[token](...args);
    }
    if (Object.hasOwn(CONSTANTS, token)) return CONSTANTS[token];
    if (Object.hasOwn(scope, token)) return Number(scope[token]);
    throw new Error(`expression: unknown identifier "${token}"`);
  }

  function parsePower() {
    const base = parsePrimary();
    if (peek() === '^') { next(); return base ** parsePower(); }
    return base;
  }

  function parseMultiplicative() {
    let value = parsePower();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = next();
      const rhs = parsePower();
      value = op === '*' ? value * rhs : op === '/' ? value / rhs : value % rhs;
    }
    return value;
  }

  function parseAdditive() {
    let value = parseMultiplicative();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const rhs = parseMultiplicative();
      value = op === '+' ? value + rhs : value - rhs;
    }
    return value;
  }

  const result = parseAdditive();
  if (position !== tokens.length) throw new Error(`expression: trailing tokens near "${peek()}"`);
  if (!Number.isFinite(result)) throw new Error('expression: non-finite result');
  return result;
}

/** Resolve `$param` references and `=expression` strings against the scope. */
function resolveValue(value, scope) {
  if (typeof value === 'string') {
    if (value.startsWith('=')) return evaluateExpression(value.slice(1), scope);
    if (value.startsWith('$')) {
      const key = value.slice(1);
      if (!Object.hasOwn(scope, key)) throw new Error(`graph: undefined parameter "${key}"`);
      return scope[key];
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, scope));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveValue(v, scope)]));
  }
  return value;
}

function topologicalOrder(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const state = new Map();
  const order = [];
  const visit = (id, trail = []) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') throw new Error(`graph: cycle detected (${[...trail, id].join(' → ')})`);
    const node = byId.get(id);
    if (!node) throw new Error(`graph: missing node "${id}"`);
    state.set(id, 'visiting');
    for (const input of node.inputs || []) visit(input, [...trail, id]);
    state.set(id, 'done');
    order.push(node);
  };
  for (const node of nodes) visit(node.id);
  return order;
}

/**
 * Evaluate a parametric graph.
 *
 * graph = {
 *   parameters: { rotor_count: 4, arm_length: 1.2 },
 *   nodes: [ { id, type, inputs: [ids], ...settings } ]
 * }
 */
export function evaluateGraph(graph, overrides = {}) {
  const scope = { ...(graph.parameters || {}), ...overrides };
  const nodes = graph.nodes || [];
  if (!nodes.length) throw new Error('graph: no nodes');

  const ordered = topologicalOrder(nodes);
  const results = new Map();
  const trace = [];

  for (const node of ordered) {
    const settings = resolveValue({ ...node, id: undefined, type: undefined, inputs: undefined }, scope);
    const inputs = (node.inputs || []).map((id) => {
      const value = results.get(id);
      if (value === undefined) throw new Error(`graph: node "${node.id}" reads unevaluated "${id}"`);
      return value;
    });

    let output;
    switch (node.type) {
      case 'primitive':
        output = buildPrimitive(settings.primitive || settings.shape || 'cube', settings.params || settings);
        break;
      case 'transform':
        output = transformMesh(inputs[0], compose(
          settings.position || [0, 0, 0],
          settings.rotation || [0, 0, 0],
          settings.scale || [1, 1, 1]
        ));
        break;
      case 'boolean': {
        if (inputs.length < 2) throw new Error(`graph: boolean node "${node.id}" needs two inputs`);
        output = booleanOperation(inputs, settings.operation || 'union').mesh;
        break;
      }
      case 'modifier': {
        const name = settings.modifier || settings.op;
        if (!MODIFIERS[name]) throw new Error(`graph: unknown modifier "${name}"`);
        output = MODIFIERS[name](inputs[0], settings.options || settings.params || {});
        break;
      }
      case 'merge':
        output = mergeMeshes(inputs);
        break;
      case 'expression':
        output = evaluateExpression(settings.expression, scope);
        scope[node.id] = output;
        break;
      case 'output':
        output = inputs[0];
        break;
      default:
        throw new Error(`graph: unknown node type "${node.type}"`);
    }

    results.set(node.id, output);
    trace.push({
      node: node.id,
      type: node.type,
      triangles: output && output.indices ? triangleCount(output) : null,
      scalar: typeof output === 'number' ? output : null
    });
  }

  const terminal = nodes.find((node) => node.type === 'output') || ordered[ordered.length - 1];
  const result = results.get(terminal.id);
  if (!result || !result.indices) throw new Error('graph: terminal node did not produce a mesh');

  return {
    mesh: result,
    parameters: scope,
    trace,
    stats: {
      nodes: nodes.length,
      triangles: triangleCount(result),
      volume: Number(Math.abs(volume(result)).toFixed(6)),
      bounds: bounds(result).size.map((n) => Number(n.toFixed(4)))
    }
  };
}

/** Static validation without evaluating geometry — cheap agent pre-flight. */
export function validateGraph(graph) {
  const errors = [];
  const warnings = [];
  // Validation is the agent's cheap pre-flight: it must survive *any* input
  // and report, never throw. Everything below is defensive by design.
  const rawNodes = graph && typeof graph === 'object' ? graph.nodes : null;
  if (!Array.isArray(rawNodes)) {
    return { valid: false, errors: ['Graph must be an object with a `nodes` array.'], warnings: [], node_count: 0, parameters: [] };
  }
  const nodes = rawNodes.filter((node) => node && typeof node === 'object');
  if (nodes.length !== rawNodes.length) errors.push(`${rawNodes.length - nodes.length} node entr(ies) are not objects.`);
  const ids = new Set();

  if (!nodes.length) errors.push('Graph has no nodes.');
  for (const node of nodes) {
    if (!node.id) errors.push('A node is missing an id.');
    else if (ids.has(node.id)) errors.push(`Duplicate node id "${node.id}".`);
    ids.add(node.id);
    if (!NODE_TYPES[node.type]) errors.push(`Node "${node.id}" has unknown type "${node.type}".`);
    else {
      const required = NODE_TYPES[node.type].inputs;
      const actual = Array.isArray(node.inputs) ? node.inputs.length : 0;
      if (actual < required) errors.push(`Node "${node.id}" (${node.type}) needs ${required} input(s), has ${actual}.`);
    }
    if (node.inputs !== undefined && !Array.isArray(node.inputs)) {
      errors.push(`Node "${node.id}" has a non-array \`inputs\`.`);
    }
    for (const input of Array.isArray(node.inputs) ? node.inputs : []) {
      if (!nodes.some((other) => other.id === input)) errors.push(`Node "${node.id}" references missing input "${input}".`);
    }
  }

  if (!errors.length) {
    try { topologicalOrder(nodes); } catch (error) { errors.push(error.message); }
  }

  const referenced = new Set(nodes.flatMap((node) => (Array.isArray(node.inputs) ? node.inputs : [])));
  const terminals = nodes.filter((node) => !referenced.has(node.id));
  if (terminals.length > 1) warnings.push(`${terminals.length} terminal nodes — only "${terminals[terminals.length - 1].id}" will be returned.`);
  if (!nodes.some((node) => node.type === 'output')) warnings.push('No explicit output node; the last node in topological order is used.');

  return { valid: errors.length === 0, errors, warnings, node_count: nodes.length, parameters: Object.keys(graph?.parameters || {}) };
}

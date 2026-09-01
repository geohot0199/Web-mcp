#!/usr/bin/env node
/**
 * Deterministic WebMCP intent-routing evaluation.
 *
 * This is deliberately separate from software checks: it verifies that Orbit's
 * local natural-language router selects the intended goal-level tool, extracts
 * the key parameters, and preserves approval/sensitive-action guards over a
 * varied prompt set.
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { routePrompt } from '../js/agent-router.js';

const fixture = JSON.parse(await readFile(new URL('../evals/agent-workflows.json', import.meta.url), 'utf8'));
let passed = 0;
const failures = [];

function partialMatch(actual, expected, path = '') {
  if (expected === null || typeof expected !== 'object') {
    return actual === expected ? [] : [`${path || 'value'} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
  }
  return Object.entries(expected).flatMap(([key, value]) => partialMatch(actual?.[key], value, path ? `${path}.${key}` : key));
}

for (const test of fixture) {
  const actual = routePrompt(test.prompt, test.context);
  const mismatches = [
    ...partialMatch(actual.tool, test.expected.tool, 'tool'),
    ...partialMatch(actual.parameters, test.expected.parameters || {}, 'parameters'),
    ...partialMatch(actual.requiresHumanApproval, test.expected.approval, 'requiresHumanApproval')
  ];
  if (Object.hasOwn(test.expected, 'sensitive')) mismatches.push(...partialMatch(actual.sensitive, test.expected.sensitive, 'sensitive'));
  if (mismatches.length) failures.push({ id: test.id, prompt: test.prompt, mismatches });
  else passed += 1;
}

/*
 * Regression guard for the PR #3 review finding “Read routes create edit plans”:
 * every tool the router can return must be explicitly dispatched in
 * handleAgentRequest() — unless it is one of the plan-building tools that
 * intentionally fall through to buildPlan(). Without this check a newly routed tool
 * would silently become a starter-concept proposal for read-only requests.
 */
const routerSource = readFileSync(new URL('../js/agent-router.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const routedTools = [...new Set([...routerSource.matchAll(/route\('([a-z_]+)'/g)].map((match) => match[1]))];
const planBuilderTools = new Set(['propose_changes', 'create_composite_object', 'modify_object']);
const undispatchedTools = routedTools.filter(
  (tool) => !planBuilderTools.has(tool) && !appSource.includes(`routedIntent.tool === '${tool}'`)
);

console.log(`\nOrbit agent workflow evaluation: ${passed}/${fixture.length} passed`);
for (const failure of failures) {
  console.error(`\n✗ ${failure.id} — ${failure.prompt}`);
  failure.mismatches.forEach((mismatch) => console.error(`  ${mismatch}`));
}

if (undispatchedTools.length) {
  console.error('\n✗ Dispatch coverage — routed tools with no handleAgentRequest() branch:');
  undispatchedTools.forEach((tool) => console.error(`  ${tool} would silently fall through to buildPlan()`));
} else {
  console.log(`Dispatch coverage: all ${routedTools.length} router tools are explicitly handled or are intentional plan builders.`);
}

const sensitive = fixture.filter((test) => test.expected.sensitive).length;
const approved = fixture.filter((test) => test.expected.approval).length;
console.log(`Coverage: ${fixture.length} prompts · ${approved} approval-gated · ${sensitive} sensitive-action cases`);
process.exitCode = failures.length || undispatchedTools.length ? 1 : 0;

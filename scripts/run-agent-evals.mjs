#!/usr/bin/env node
/**
 * Deterministic WebMCP intent-routing evaluation.
 *
 * This is deliberately separate from software checks: it verifies that Orbit's
 * local natural-language router selects the intended goal-level tool, extracts
 * the key parameters, and preserves approval/sensitive-action guards over a
 * varied prompt set.
 */
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

console.log(`\nOrbit agent workflow evaluation: ${passed}/${fixture.length} passed`);
for (const failure of failures) {
  console.error(`\n✗ ${failure.id} — ${failure.prompt}`);
  failure.mismatches.forEach((mismatch) => console.error(`  ${mismatch}`));
}

const sensitive = fixture.filter((test) => test.expected.sensitive).length;
const approved = fixture.filter((test) => test.expected.approval).length;
console.log(`Coverage: ${fixture.length} prompts · ${approved} approval-gated · ${sensitive} sensitive-action cases`);
process.exitCode = failures.length ? 1 : 0;

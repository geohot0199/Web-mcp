# ◇ Orbit — the 3D modelling kernel that AI agents drive directly

> **No approval queue. No permission gates. No human in the loop.**
> An agent connects over WebMCP, discovers 36 tools, and has total authority over the scene — because the kernel underneath is exact, bounded and adversarially tested, not because someone is watching.

![webmcp](https://img.shields.io/badge/WebMCP-36%20agent%20tools-0d0d0d?style=flat-square)
![csg](https://img.shields.io/badge/CSG-exact%20BSP%20booleans-0d0d0d?style=flat-square)
![autonomy](https://img.shields.io/badge/autonomy-full%20%C2%B7%20no%20approval%20step-7c5cff?style=flat-square)
![tests](https://img.shields.io/badge/tests-474%20passing-3ddc97?style=flat-square)
![runtime](https://img.shields.io/badge/runtime-static%20browser%20%C2%B7%20no%20backend-4d4d4d?style=flat-square)

```bash
git clone https://github.com/geohot0199/orbit && cd orbit
npm run serve        # → http://localhost:8080
npm run check        # 474 assertions: kernel · protocol · adversarial
```

---

## What no other WebMCP server gives an agent

Most "AI + 3D" tools hand a model a mouse, or wrap an editor's buttons in tool
calls and gate every one behind a human click. Orbit does neither. These are the
capabilities that don't exist anywhere else in the WebMCP ecosystem:

| # | Capability | Why it's unique |
|---|---|---|
| **1** | **Exact CSG booleans** — union · subtract · intersect · xor | A real BSP kernel written from scratch, not a bolt-on. Results are **provably watertight**: T-junctions repaired, winding globally reoriented, disjoint shells distributed over. Verified against set algebra — inclusion–exclusion, idempotence, De Morgan-style identities — and against **Euler characteristics** (drill a hole, genus goes to exactly 1; cross-drill it, exactly 3). |
| **2** | **Freeform geometry, not just primitives** | `extrude` with **corner bevels and twist**, `revolve`, and `sweep` along arbitrary 3D polylines with parallel-transport frames. Ear-clipping triangulation and polygon offsetting are built in. An agent can author shapes no primitive library contains. |
| **3** | **A non-destructive modifier stack** | 12 procedural modifiers — array (linear + radial), mirror, twist, bend, taper, inflate, shell, smooth, subdivide, decimate, lattice, displace — that can be reordered, disabled and retuned without rebuilding the base mesh. |
| **4** | **A parametric node graph** | Define a DAG once, then re-evaluate it with new parameters: change `arm_length` and the whole drone rebuilds. Includes a **safe expression evaluator** (`=arm * 2`, `sin`, `sqrt`, `pi`) built with a hand-written parser — no `eval`, no `Function`, no injection surface. |
| **5** | **Mesh import, not just export** | OBJ · STL (ASCII + binary) · PLY · glTF · GLB **in**, and OBJ · STL · PLY · glTF 2.0 **out**. Agents can load an existing asset, measure it, cut it, and write it back. External glTF buffer URIs are **refused**, so an importer can never be turned into a fetch primitive. |
| **6** | **Physics that answers engineering questions** | Exact **inertia tensors** by polyhedral integration, mass from real material densities, **support-polygon stability** with tipping angles, collision detection, **Kutzbach–Grübler mobility** for joint linkages, deterministic rigid-body settling, and printability analysis. Verified against closed-form solutions. |
| **7** | **Adversarially tested, not just unit tested** | 102 red-team assertions: code injection, prototype pollution, graph cycles, hostile assets, conflicting edits, resource exhaustion, history corruption. Every one found and fixed real bugs. |
| **8** | **Errors written for a machine, not a person** | Every failure carries `code`, `error`, a **self-correction `hint`**, and live object ids. An autonomous agent recovers without asking anybody. |

---

## The interaction model

```
agent ──▶ orbit.call(tool, args) ──▶ kernel mutates ──▶ journal ──▶ viewport
  ▲                                                                    │
  └────────── ok / error + hint + live ids ◀───────────────────────────┘
```

There is no proposal object, no approval state and no permission flag anywhere
in the codebase — a conformance test statically asserts their absence. Safety is
structural:

- **Bounded.** Every tessellation input is clamped (`LIMITS.maxSegments = 256`); array counts and subdivisions are capped by a triangle budget. `sphere(r, 1e6, 1e6)` returns a coarse mesh, never an OOM.
- **Validated.** Arguments are checked before allocation. Profiles must be ≥3 finite points; NaN and Infinity are stripped; `__proto__` keys are dropped.
- **Exact.** Booleans are watertight or they throw. Nothing half-built enters the scene.
- **Reversible.** Every mutation is journalled with a full snapshot: 200 levels of undo/redo, and a new edit correctly truncates the redo branch.

---

## The tool surface — 36 tools

| Group | Tools |
|---|---|
| **Core** | `create_object` · `delete_object` · `duplicate_object` · `move_object` · `rotate_object` · `scale_object` · `set_material` · `set_camera` · `group_objects` · `ungroup_objects` · `boolean_operation` · `undo` · `redo` · `inspect_scene` · `inspect_object` · `select_object` |
| **Freeform** | `create_profile_solid` (extrude/revolve/sweep) · `add_modifier` · `remove_modifier` · `reorder_modifiers` |
| **Parametric** | `define_graph` · `evaluate_graph` |
| **Assets** | `import_mesh` · `export_scene` · `list_capabilities` |
| **Physics** | `compute_mass_properties` · `analyze_stability` · `check_collisions` · `add_joint` · `simulate` · `check_printability` |
| **Analysis** | `validate_scene` · `measure` · `get_history` · `set_environment` · `clear_scene` |

`select_object` alone accepts id, ids, **semantic query**, tag, type, material,
**raycast**, all or none — so an agent can say "select every metal part" without
tracking ids.

---

## Drive it

**From an agent** — three bridges register automatically: `navigator.modelContext`
(native WebMCP), `window.orbit` (always present), and `postMessage` (cross-frame).

```js
// Drill a cross-hole through a block and check it can be printed.
orbit.batch([
  { tool: 'create_object', args: { id: 'blk', type: 'cube', params: { width: 2, height: 2, depth: 2 } } },
  { tool: 'create_object', args: { id: 'bore', type: 'cylinder', params: { radius: 0.5, height: 4 } } },
  { tool: 'boolean_operation', args: { ids: ['blk', 'bore'], operation: 'subtract' } },
  { tool: 'check_printability', args: {} }
]);
// → watertight, genus 1, overhang ratio + support advice
```

A batch halts at the first failure and reports exactly where, unless a step sets
`continue_on_error`.

**Parametrically** — define once, re-evaluate forever:

```js
orbit.call('define_graph', { id: 'drone', graph: {
  parameters: { arm: 1.2 },
  nodes: [
    { id: 'hull',  type: 'primitive', primitive: 'rounded_box', params: { width: 0.6, height: 0.25, depth: 0.6, radius: 0.08 } },
    { id: 'boom',  type: 'primitive', primitive: 'cylinder',    params: { radius: 0.05, height: '=arm * 2' } },
    { id: 'lay',   type: 'transform', inputs: ['boom'], rotation: [0, 0, 1.5708] },
    { id: 'booms', type: 'modifier',  inputs: ['lay'], modifier: 'array', options: { count: 2, mode: 'radial', angle: 3.14159 } },
    { id: 'out',   type: 'boolean',   inputs: ['hull', 'booms'], operation: 'union' }
  ]
}});
orbit.call('evaluate_graph', { graph_id: 'drone', parameters: { arm: 2.4 } });
```

---

## Architecture

```text
┌───────────────── browser · no backend · no build step ─────────────────┐
│                                                                        │
│  agent ─▶ navigator.modelContext │ window.orbit │ postMessage          │
│                        │                                               │
│                        ▼                                               │
│              webmcp.js — manifest · dispatch · batch · event stream    │
│                        │                                               │
│                        ▼                                               │
│              scene.js — 36 tools · journal · 200-step undo             │
│         ┌──────────────┼──────────────┬─────────────┬──────────────┐   │
│         ▼              ▼              ▼             ▼              ▼   │
│      csg.js      primitives.js   modifiers.js  nodegraph.js   physics.js│
│    BSP booleans   13 solids +     12 modifiers   parametric   inertia · │
│    T-junction     extrude ·       non-destr.     DAG + safe   stability│
│    repair         revolve · sweep  stack         expressions  · joints │
│         └──────────────┴──────────────┴─────────────┴──────────────┘   │
│                        ▼                                               │
│              geom.js — mesh kernel · orient() · manifold reports       │
│                        │                                               │
│                        ▼                                               │
│              app.js — read-only viewport + tool-call stream            │
└────────────────────────────────────────────────────────────────────────┘
```

Roughly **4,200 lines** of dependency-free ES modules. The entire geometry stack
runs unchanged in Node, which is why it can be tested this hard. Three.js is used
only to *draw* the mesh arrays the kernel produces — swap it out and nothing
geometric changes.

---

## Verified, not vibes

```bash
npm run check
# Orbit geometry kernel:    213/213 checks passed
# Orbit WebMCP conformance:  71/71  checks passed
# Orbit adversarial suite:  102/102 checks passed
```

Every assertion is a ground truth, not a smoke test:

$$
V_{\text{sphere}} \to \tfrac{4}{3}\pi r^{3}, \qquad
I_{xx}^{\text{cube}} = \tfrac{ms^{2}}{6}, \qquad
|A \cup B| + |A \cap B| = |A| + |B|
$$

$$
V - E + F = 2 - 2g \quad\text{(genus checked per boolean result)}, \qquad
M = 6(n - 1 - j) + \textstyle\sum_i f_i \quad\text{(Kutzbach–Grübler)}
$$

The adversarial suite is the interesting one — it's the price of removing the
human. With no approval step, the tool surface itself has to be hostile to bad
input, so it red-teams injection (`process.exit`, `constructor.constructor`),
prototype pollution, graph cycles, degenerate profiles, malformed assets,
external buffer URIs, conflicting edits and resource exhaustion.

---

## Deliberate non-goals

- **No human approval flow.** It was removed on purpose. If you need one, wrap `orbit.call`.
- **No multiplayer.** One scene, one authority. Presence would add conflict resolution the kernel doesn't need.
- **No GI or ray tracing.** The viewport is PBR with tone mapping; Orbit is a modelling kernel, not a renderer.
- **No sculpting brushes.** Modifiers and CSG are the deformation model — they're expressible as JSON, which brushes are not.

---

*The agent has full authority. The kernel has exact geometry, hard limits and 474 tests. That trade — structural safety instead of a human veto — is the whole idea.*

**discover → call → mutate → verify → undo** ✦

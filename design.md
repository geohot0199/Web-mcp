# Orbit design notes — Human + agent 3D co-design

## Product statement

Orbit is not “an AI that clicks around a 3D editor.” It is a shared 3D workspace in which a human can set intent, inspect an agent’s plan, interrupt or revise it, approve a visible batch of changes, review the result, and recover any version.

The design loop is:

```text
Observe → Plan → Propose → Human approval → Act → Verify → Iterate
```

## Interface system

### Visual language

The studio uses a deep night surface so the model and collaboration signals stay central. There are only three functional accent colors:

| Accent | Meaning | Use |
|---|---|---|
| Violet | Agent thought / planned work | brand, plan cards, active selection |
| Mint | Shared state / healthy result | live state, success, validated constraints |
| Peach | Attention / human decision | approval state, annotations, review warnings |

Motion is informative rather than decorative: the brand orbits, live status softly pulses, proposals rise in, and state transitions animate so a collaborator can see when Orbit is thinking, waiting, or applying a batch. `prefers-reduced-motion` disables this motion.

### Workspace layout

- **Left:** object outline, primitive library, selection inspector, constraints, and annotations.
- **Center:** the live Three.js canvas, camera HUD, direct/planning mode switch, and version rail.
- **Right:** the conversational agent, visible proposal card, activity timeline, and input composer.

This makes the relationship between a natural-language request, its structured plan, and the visual scene immediately legible.

## Shared scene model

Every model object has:

```ts
{
  id: string,
  name: string,
  type: 'cube' | 'sphere' | 'cylinder' | 'cone' | 'torus' | 'plane',
  position: [number, number, number],
  rotation: [number, number, number], // radians
  scale: [number, number, number],
  material: 'metal' | 'plastic' | 'glass' | 'wood' | 'emissive',
  color: '#rrggbb',
  tags: string[]
}
```

The same browser-side state powers the canvas, object inspector, diagnostics, history, versions, local planner, and WebMCP tool handlers. That eliminates a common collaboration failure mode: an agent operating on stale state that the human cannot see.

## Proposal transaction model

An agent proposal is deliberately separate from model state:

```text
Draft proposal
  ├─ title, explanation, design intent
  ├─ high-level actions (add / modify / delete / symmetrize / constraint / restore / export)
  └─ diff summary

Human chooses each individual operation
  ├─ Toggle any component off (for example, keep body / skip fins)
  ├─ Modify → agent revises draft; no scene mutation
  ├─ Reject all → discard draft; no scene mutation
  └─ Apply selected → stream operations one at a time into the canvas
                         ├─ Interrupt at a safe operation boundary
                         ├─ Keep completed/partial run
                         └─ Undo agent run
```

The completed subset is stored as one history transaction, while the canvas, proposal card, build overlay, and timeline update after every individual operation. This gives the human both the satisfying live-build moment and a simple whole-run recovery point.

## Tool architecture

Tools are arranged by a user goal, not by individual knobs in the interface.

```text
READ                 PLAN / WRITE                  VERIFY / CONTROL
─────────────────    ──────────────────────────    ─────────────────────────
get_scene            propose_changes               validate_scene
get_selected_object  create_composite_object       analyze_design
find_objects          modify_object                list_constraints
get_statistics        add_constraint               create/list/restore_version
get_context           apply_approved_proposal      undo_agent_changes
get_history           add_comment                  export_stl / share_scene
```

### Safety boundaries

1. **Read tools** allow an agent to reason over actual scene state.
2. **Plan tools are non-mutating.** They surface a card that the human can inspect.
3. **Human approval remains in the UI.** `apply_approved_proposal` never circumvents the visible approval state.
4. **Live selection context is relayed automatically.** A local planner receives the current selected object, every tool result carries `live_context`, integrations can listen for `webmcp-selection-context`, and compatible native bridges receive context updates.
5. **Object locks prevent edit races.** While Orbit streams a modify/delete/symmetry/restore operation, affected forms are temporarily locked in the viewport, inspector, and outline; direct human edits are rejected with a clear status instead of silently overwriting agent work.
6. **Permission tiers gate capabilities** for reading, creating, modifying, deleting, exporting, and sharing. Direct mode applies permitted create/modify work, while destructive restore/delete plus export/share remain approval-gated.
7. **History, versions, and activity log** make all completed actions inspectable and recoverable.

## Deterministic review design

The review panel intentionally does not claim to be an objective AI benchmark. It reports local, transparent heuristic scores for:

- mirrored-position symmetry;
- structural bounding-box intersection checks;
- material variety;
- simple composition coverage; and
- active symmetry / on-ground constraints.

These deterministic checks are also exposed through `validate_scene`, so agents can verify a result after proposing or applying a change. Every score card is clickable: it exposes the relevant pair/unmatched object evidence, bounding-box reasoning, material inventory, or intersection pair; evidence-linked findings focus the implicated form in the canvas.

## Agent routing evaluation

`js/agent-router.js` is a dependency-free deterministic routing contract used by the local intent layer. `evals/agent-workflows.json` defines 24 varied requests and expected tool, key arguments, approval behavior, and sensitive-action behavior. Run `npm run evals` to verify routing, parameter extraction, and human-control guards independently from generic syntax/HTTP checks.

## Browser compatibility

The normal editor works in any current browser with WebGL and ES modules. When `navigator.modelContext` is available, the tool registry is registered with the native WebMCP bridge. When it is not available, the app keeps functioning as a fully interactive 3D design studio and exposes a small development bridge at `window.webMCPStudio`.

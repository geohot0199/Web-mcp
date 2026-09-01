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

Human chooses
  ├─ Modify → agent revises draft; no scene mutation
  ├─ Reject → discard draft; no scene mutation
  └─ Approve → execute all actions as one agent history transaction
                       ├─ Keep changes
                       └─ Undo agent run
```

The one-batch transaction is key. A human can understand what the agent did and reject the complete response without manually unwinding dozens of primitive operations.

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
4. **Permissions gate capabilities** for reading, creating, modifying, deleting, and exporting.
5. **Destructive restore/delete and export actions** are staged and visibly labeled.
6. **History, versions, and activity log** make all completed actions inspectable and recoverable.

## Deterministic review design

The review panel intentionally does not claim to be an objective AI benchmark. It reports local, transparent heuristic scores for:

- mirrored-position symmetry;
- structural bounding-box intersection checks;
- material variety;
- simple composition coverage; and
- active symmetry / on-ground constraints.

These deterministic checks are also exposed through `validate_scene`, so agents can verify a result after proposing or applying a change.

## Browser compatibility

The normal editor works in any current browser with WebGL and ES modules. When `navigator.modelContext` is available, the tool registry is registered with the native WebMCP bridge. When it is not available, the app keeps functioning as a fully interactive 3D design studio and exposes a small development bridge at `window.webMCPStudio`.

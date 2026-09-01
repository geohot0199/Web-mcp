# Orbit design notes — Human + agent 3D co-design

## Product statement

Orbit is not “an AI that clicks around a 3D editor.” It is a shared 3D workspace in which a human can set intent, inspect an agent’s plan, interrupt or revise it, approve visible individual changes, watch the model build live, review the result, time-travel through decisions, and recover any version.

The design loop is:

```text
Observe → Plan → Propose → Human approval → Stream actions → Verify → Iterate
```

## Interface system

### Visual language

The studio uses a deep night surface so the model and collaboration signals stay central. There are only three functional accent colors:

| Accent | Meaning | Use |
|---|---|---|
| Violet | Agent thought / planned work | brand, plan cards, active selection |
| Mint | Shared state / healthy result | live state, success, validated constraints |
| Peach | Attention / human decision | approval state, time travel, annotations, review warnings |

Motion is informative rather than decorative: the brand orbits, live status softly pulses, proposals rise in, streamed build steps progress in the canvas, and state transitions animate so a collaborator can see when Orbit is thinking, waiting, applying, or paused. `prefers-reduced-motion` disables this motion.

### Workspace layout

- **Left:** object outline, primitive library, selection inspector, constraints, and annotations.
- **Center:** live Three.js canvas, spatial hover grounding, camera HUD, direct/planning mode switch, and version rail.
- **Right:** conversational agent, selection + memory relay, visible proposal card, time-travel activity timeline, and text/voice composer.

This makes the relationship between a natural-language request, spatial context, its structured plan, and the visual scene immediately legible.

## Shared scene and interaction context

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

A separate live interaction context is continuously enriched with:

```ts
{
  selected_object: Object | null,
  pointed_object: Object | null,
  gesture: { type: 'pointing_at', object_id: string } | null,
  selection_revision: number,
  active_locks: ObjectLock[],
  timeline_preview_active: boolean
}
```

- A normal click establishes durable selection context.
- Hover provides a short-lived spatial “pointing at” target.
- **Shift + drag** moves an object directly in the viewport.
- Optional browser speech recognition retains the pointed target long enough for directions such as “make that taller.”
- Context changes emit `webmcp-selection-context`; compatible native bridges are updated when they support a context API; every tool response includes `live_context`.

## Proposal transaction model

An agent proposal is deliberately separate from model state:

```text
Draft proposal
  ├─ title, explanation, design intent
  ├─ high-level actions (add / modify / delete / symmetrize / constraint / restore / export / share)
  ├─ per-operation enabled state
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

### Concurrency rule

A streamed agent run is atomic for model mutations. Relevant forms show a lock in the outline and a disabled inspector; all human model-mutating actions temporarily pause with an explanation. Selection, hover, comments, timeline inspection, and an interrupt request remain available. This avoids a concurrent human drag or inspector change becoming accidentally bundled into the agent transaction.

## Time-travel debugging

Every activity event—including native/local tool calls—records:

```ts
{
  id: string,
  timestamp: number,
  source: 'human' | 'agent' | 'warning',
  title: string,
  detail: string,
  tool_call?: { name: string, args: object },
  snapshot: SceneSnapshot
}
```

The Activity panel is a read-only time-travel debugger. The human can click an event or scrub the timeline slider to render the exact captured scene state. A prominent canvas banner identifies historical mode; mutations and mutating tools are blocked until **Return to live** restores the latest snapshot. Agents can inspect the same data through `get_activity_timeline` and `get_activity_snapshot` without altering the visible live scene.

## Project memory and personas

Orbit stores explicit preferences in browser-local project memory only. The user can say “Remember I prefer low-poly mint-accented designs,” remove a chip, or choose a persistent role:

- Adaptive co-designer
- Visual designer
- Geometry engineer
- Design reviewer

Preferences and persona are injected into design context and influence local style inference when a prompt omits a style. The agent may only call `save_preference` or `set_project_persona` after an explicit human instruction; `get_preferences` makes the stored memory inspectable.

## Tool architecture

Tools are arranged by a user goal, not by individual knobs in the interface.

```text
READ / CONTEXT         PLAN / WRITE                    VERIFY / CONTROL
──────────────────     ───────────────────────────     ───────────────────────────
get_scene              propose_changes                 validate_scene
get_selected_object    create_composite_object         analyze_design
find_objects            modify_object                  list_constraints
get_statistics          add_constraint                 create/list/restore_version
get_context             apply_approved_proposal        undo_agent_changes
get_history             add_comment                    interrupt_agent_run
get_activity_timeline   save/remove preference         export_stl / share_scene
get_activity_snapshot   set_project_persona
get_preferences
```

### Safety boundaries

1. **Read tools** allow an agent to reason over actual scene state.
2. **Plan tools are non-mutating.** They surface a card that the human can inspect.
3. **Human approval remains in the UI.** `apply_approved_proposal` never circumvents the visible approval state.
4. **Live selection and gesture context are relayed automatically.** A local planner receives the current target, integrations can listen for `webmcp-selection-context`, and compatible native bridges receive context updates.
5. **Object locks and an atomic-run guard prevent edit races.** Human direct manipulation stays available before/after a run; during it, the UI identifies why an edit is paused.
6. **Permission tiers gate capabilities** for reading, creating, modifying, deleting, exporting, and sharing. Direct mode applies permitted create/modify work, while destructive restore/delete plus export/share remain approval-gated even under Full permission.
7. **Time travel is read-only.** Historical snapshots never silently become the live model; the user must return to live before mutating.
8. **Project memory is explicit and local.** Preferences are transparent, removable, and never uploaded by the app.
9. **History, versions, and activity log** make all completed actions inspectable and recoverable.

## Deterministic review design

The review panel intentionally does not claim to be an objective AI benchmark. It reports local, transparent heuristic scores for:

- mirrored-position symmetry;
- structural bounding-box intersection checks;
- material variety;
- simple composition coverage; and
- active symmetry / on-ground constraints.

These deterministic checks are exposed through `validate_scene`, so agents can verify a result after proposing or applying a change. Every score card is clickable: it exposes the relevant pair/unmatched object evidence, bounding-box reasoning, material inventory, or intersection pair; evidence-linked findings focus the implicated form in the canvas.

## Agent routing evaluation

`js/agent-router.js` is a dependency-free deterministic routing contract used by the local intent layer. `evals/agent-workflows.json` defines 29 varied requests and expected tool, key arguments, approval behavior, and sensitive-action behavior. Run `npm run evals` to verify routing, parameter extraction, and human-control guards independently from generic syntax/HTTP checks.

## Browser compatibility

The normal editor works in any current browser with WebGL and ES modules. Voice input is progressive enhancement via the browser’s `SpeechRecognition`/`webkitSpeechRecognition` API and clearly indicates when unavailable. When `navigator.modelContext` is available, the tool registry is registered with the native WebMCP bridge. When it is not available, the app keeps functioning as a fully interactive 3D design studio and exposes a small development bridge at `window.webMCPStudio`.

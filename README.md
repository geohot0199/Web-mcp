# Orbit — WebMCP Co-design Studio

> **A 3D workspace where humans and AI agents co-design in real time.**

Orbit turns a browser-based 3D editor into a shared human–agent workflow. Instead of giving an agent a collection of blind UI clicks, the app gives it scene awareness, goal-level tools, visible proposals, deterministic reviews, and a clear approval boundary.

![No build step required](https://img.shields.io/badge/runtime-static%20browser%20app-121a31?style=flat-square)
![WebMCP tools](https://img.shields.io/badge/WebMCP-28%20goal--oriented%20tools-8876ff?style=flat-square)
![Human control](https://img.shields.io/badge/human%20control-approval%20first-52dfc3?style=flat-square)

## Collaboration loop

```text
Human intent → agent reads scene → visible plan → human approval
     ↑                                              ↓
Human feedback ← review + diagnostics ← apply → verify
```

The studio has two modes:

- **Planning mode (default):** agent changes are staged as a visible diff. The human can approve, modify, or reject before any scene mutation happens.
- **Direct mode:** useful for quick iteration; plans apply immediately as one reversible agent batch, then the human can keep or undo the run.

## What is implemented

### A redesigned, animated studio

- Purpose-built dark 3D workspace using a focused three-accent visual system: **violet**, **mint**, and **peach**.
- Motion design throughout: animated orbital brand mark, ambient color fields, pulsing agent state, live canvas HUD, proposal transitions, and responsive hover feedback.
- Interactive Three.js canvas with orbit/zoom, object picking, selection bounds, grid, scene focus, reset view, keyboard nudging, and **Shift + drag** human repositioning.
- Responsive desktop/tablet/mobile layouts with the canvas kept central to the workflow.

### Human + agent collaboration

- Natural-language **local design director** that creates plans for delivery drones, rockets, robots, primitive additions, selected-object edits, symmetry, and scene reset requests.
- Selection-aware requests such as “make this metallic,” “move that left,” “make it bigger,” or “duplicate it.”
- Live agent status: ready, thinking, waiting for approval, applying, or blocked by a permission.
- A readable proposal card with planned steps, a visual diff (`+ forms`, `~ refinements`, `− removals`), reasons, and **Approve / Modify / Reject** controls.
- **Granular proposal scope:** every operation has its own toggle. A human can keep the body while excluding fins, camera, or any other individual component before applying the selected subset.
- **Live incremental builds:** selected operations stream into the Three.js canvas one at a time, with a canvas build overlay, per-step status, timeline events, and a safe **Interrupt run** control.
- Every completed (or interrupted partial) run is one auditable and reversible transaction. Humans can **Keep changes** or **Undo agent run**.
- Object-level edit locks prevent a human viewport drag, inspector update, delete, duplicate, or snap action from racing the agent while it modifies that same form. The outline and inspector visibly mark the temporary lock.
- The live selection relay updates whenever the human changes selection; local intent parsing uses that selection automatically, integrations receive a `webmcp-selection-context` browser event, compatible native bridges receive context updates, and every tool result includes `live_context`.
- Agent activity timeline records human and agent actions with timestamp, parameters, and a restorable scene snapshot. A slider and event cards provide read-only **time-travel inspection** before returning to live editing.
- Spatial hover grounding and optional browser voice input let a human point at a form and say “make that taller”; the target is passed as live gesture context.
- Explicit permission tiers for scene reading, creation, modification, deletion, export, and sharing. Direct mode can stream permitted create/modify runs, but destructive restore/delete plus export/share remain staged and approval-gated.

### Scene intelligence

- Scene state and selected-object inspection.
- Semantic search for names, types, materials, tags, and common aliases (for example, wheel/propulsion and window/glass).
- Structured object metadata: stable ID, readable name, type, transforms, material, color, and semantic tags.
- Deterministic scene statistics and world-space bounding boxes.
- Constraint system with **symmetry** and **on-ground** guardrails.
- Deterministic validation for constraints, potential structural intersections, symmetry, material variety, composition, and scene statistics.
- Transparent, project-specific design review scores. Each clickable metric drills into the exact heuristic evidence (paired/unmatched objects, bounds, materials, or intersection pairs), and related findings can focus an implicated form in the canvas. The UI explicitly treats the score as a heuristic—not an objective benchmark.
- Review-informed suggestions only stage safe automatic changes (for example, missing mirrored counterparts).

### Shared workspace controls

- Add cubes, spheres, cylinders, cones, tori, and planes by hand.
- Edit object name, position, scale, finish, and color in the object inspector.
- Duplicate, delete, snap to grid, and restore an isometric camera.
- Attach contextual annotations to an object.
- Save up to 12 visual version checkpoints and restore a prior version with confirmation.
- Full shared-state undo/redo (`Ctrl/Cmd + Z`, `Ctrl/Cmd + Shift + Z`).
- Local STL export from the currently visible model.
- URL-safe `share_scene` state links that do not upload model data to a server.
- Persistent browser-local project memory: saved preferences and an Adaptive / Designer / Engineer / Reviewer persona survive future local sessions.

## WebMCP tool strategy

Orbit intentionally exposes **28 goal-oriented tools**, rather than turning every individual button into a tool. The agent can observe first, plan at the user’s level of intent, request approval, and verify the resulting state.

| Layer | Tool | Purpose |
|---|---|---|
| Read | `get_scene` | Complete structured scene, context, constraints, stats, and bounds |
| Read | `get_selected_object` | Resolve human references such as “this” and “that” |
| Read | `find_objects` | Semantic object search |
| Read | `get_scene_statistics` | Concise counts, bounds, symmetry, colors, versions |
| Read | `get_design_context` | Intent, style, constraints, and annotations |
| Read | `get_history` | Auditable operations without exposing internal snapshots |
| Read | `get_activity_timeline` | Tool-call timeline with timestamped scene-snapshot availability |
| Read | `get_activity_snapshot` | Read a specific historical scene snapshot without changing live state |
| Memory | `get_preferences` | Read browser-local project preferences and persona |
| Memory | `save_preference` | Persist an explicit human-stated design preference |
| Memory | `remove_preference` | Forget one explicit saved preference |
| Memory | `set_project_persona` | Persist Adaptive, Designer, Engineer, or Reviewer role |
| Plan | `propose_changes` | Stage a visible, non-mutating plan from high-level changes |
| Plan | `create_composite_object` | Plan a named multipart object from primitive components |
| Plan | `modify_object` | Stage one structured object refinement |
| Approval | `apply_approved_proposal` | Reports whether the human has approved; never bypasses UI consent |
| Verify | `validate_scene` | Deterministic geometry, symmetry, and constraint diagnostics |
| Verify | `analyze_design` | Transparent heuristic review and recommendations |
| Constraints | `add_constraint` | Stage symmetry or ground guardrails |
| Constraints | `list_constraints` | Read guardrails and their latest validation result |
| Versions | `create_version` | Create a named checkpoint |
| Versions | `list_versions` | Read checkpoint metadata |
| Versions | `restore_version` | Stage a human-approved version restoration |
| Control | `undo_agent_changes` | Revert the latest reversible agent batch |
| Control | `interrupt_agent_run` | Safely stop a live streamed run at an operation boundary |
| Collaboration | `add_comment` | Attach a contextual annotation to a form |
| Sensitive action | `export_stl` | Stage a permission-gated STL export request |
| Sharing | `share_scene` | Stage a permission-gated local URL-encoded state link |

When the browser supports `navigator.modelContext`, Orbit registers these tools with the native WebMCP bridge. In non-WebMCP browsers, the normal human UI still works and a small local bridge is available for development:

```js
window.webMCPStudio.listTools();
await window.webMCPStudio.callTool('get_scene');
```

## Example agent workflow

1. Human: **“Design a compact futuristic delivery drone.”**
2. Agent calls `get_scene` and `get_design_context`.
3. Agent calls `create_composite_object` or `propose_changes`.
4. Orbit displays exact components, why they are being added, and a diff.
5. Human says **“Make the body compact and don’t add a camera.”**
6. Orbit revises the pending plan without mutating the scene.
7. Human approves. The plan applies as one undoable batch.
8. Human asks **“Review this scene.”**
9. Agent calls `analyze_design` and `validate_scene`, explains the findings, and stages only safe improvements.

## Agent workflow evaluation suite

`evals/agent-workflows.json` contains 29 varied prompts with expected goal-level tool choice, key parameter extraction, approval state, and sensitive-action handling. `scripts/run-agent-evals.mjs` executes the dependency-free local intent router against that fixture.

```bash
npm run evals
# or
npm run check
```

The current suite covers scene reads, selection/hover context, semantic search, reviews, validation, composite creation, selected-object material/color/scale edits, constraints, version restore, undo, annotations, interruption, time-travel routing, persistent preferences/personas, and sensitive export/share/clear flows. It reports task-routing success separately from syntax or HTTP checks.

## Run locally

This is a static browser app; no package install or backend is needed.

```bash
cd Web-mcp
python3 -m http.server 8080 --bind 0.0.0.0
```

Then open `http://localhost:8080`.

> Three.js, OrbitControls, and STLExporter are loaded as ES modules from jsDelivr. Use an internet-connected browser for the CDN modules, or vendor them locally for an offline deployment.

## Architecture

```text
┌────────────────────── Browser UI ───────────────────────┐
│ Canvas · Inspector · Planner · Approval · Review · Timeline│
└───────────────────────────┬──────────────────────────────┘
                            │ shared in-memory scene state
       ┌────────────────────┼────────────────────┐
       ▼                    ▼                    ▼
   Three.js renderer   History/versions    WebMCP tool registry
                                              │
                                   navigator.modelContext (when available)
```

- **Presentation:** semantic HTML, responsive CSS, CSS motion graphics, Three.js.
- **State:** plain browser-side JavaScript for objects, constraints, comments, intent, history, versions, proposals, and permissions.
- **Agent layer:** structured JSON schemas and async WebMCP tool handlers.
- **Safety layer:** read/write separation, proposal staging, human approval, permission checks, exact activity logging, version checkpoints, and undo.

## Security and privacy notes

- The app has no backend and performs no model-data upload.
- Share links encode state in the URL fragment; they can be opened locally but should still be treated as data the recipient can inspect.
- Export and destructive actions are visibly staged for human approval and additionally respect permission toggles.
- Tool calls do not execute arbitrary strings, use `eval`, or accept executable code.
- The local browser state is persisted only as convenience storage; the app does not load it automatically over a shared link without parsing the supplied state safely.
- The activity timeline and review score are local project features, not claims of external AI evaluation or safety certification.

## Technology

- Three.js `r164`
- Vanilla ES modules
- HTML/CSS with no build dependency
- WebMCP via `navigator.modelContext` when available

Built for a human-first WebMCP experience: **observe → plan → approve → act → verify**.

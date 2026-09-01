# ◇ Orbit — the 3D studio where you and an AI agent build together

> **You talk. The agent plans. You approve. It builds — live, in front of you, one step at a time.**

Orbit is a browser-based 3D co-design studio. Not “an AI that clicks around an editor” — a shared workspace where a human and an AI agent work the *same* scene at the *same* time. The agent doesn’t drive a mouse; it speaks **WebMCP**: a set of **32 goal-oriented tools** that let it *read* the scene, *plan* changes at the level of your intent, *stage* a visible diff for your approval, and *stream* each edit into the 3D viewport while you watch — then verify the result.

Every operation is visible, reversible, and inspectable. You can interrupt mid-build, toggle off individual steps, undo the whole run, or time-travel back to any decision point.

![static app](https://img.shields.io/badge/runtime-static%20browser%20app%20%C2%B7%20no%20backend-0d0d0d?style=flat-square)
![webmcp](https://img.shields.io/badge/WebMCP-32%20goal--oriented%20tools-0d0d0d?style=flat-square)
![human in the loop](https://img.shields.io/badge/human%20in%20the%20loop-approval%20first-4d4d4d?style=flat-square)
![evals](https://img.shields.io/badge/agent%20evals-38%2F38%20passing-4d4d4d?style=flat-square)

---

## Your first 90 seconds

```bash
cd Web-mcp
python3 -m http.server 8080 --bind 0.0.0.0
```

Open `http://localhost:8080`. You’re looking at a monochrome studio: a near-black viewport lit like a photo studio, an object rail on the left, and the agent on the right, waiting.

Now play — this is the whole interaction model:

| You do this | Orbit does that |
|---|---|
| **Types** “Design a compact futuristic delivery drone.” | Plans the drone component by component — body, rotors, hover core — and shows you the exact diff before touching the scene. |
| **Says** “Make the body compact and don’t add a camera.” | Revises the pending plan *in place*. Nothing is built until you approve. |
| **Clicks** **Approve** | Each part streams into the viewport one at a time, with a live build overlay. You can hit **Interrupt run** at any step. |
| **Clicks** a form and says **“Make it taller.”** | Stages a single geometry change — a visible, one-click-undoable diff. |
| **Says** “Inspect this object.” | Reports its primitive, resolution, world bounds, resolved roughness/metalness, triangle estimate, annotations, and nearest neighbours. |
| **Says** “Give it a brushed metal surface, a bit rougher.” | Stages a texture refinement: `brushed` texture, `metal` finish, roughness 0.85. |
| **Says** “Save a checkpoint called *before the risk*.” | Pins the whole scene as a named, restorable version. |
| **Says** “Review this scene.” | Runs a transparent design review; every score drills into its exact evidence. |

Two collaboration modes frame everything:

- **Planning mode (default).** The agent never mutates the scene silently. Every change lands as a proposal card with per-step toggles — approve, modify, or reject.
- **Direct mode.** For fast iteration: permitted builds apply immediately as one reversible agent batch. Destructive and sensitive actions (delete, restore, export, share) *always* stay approval-gated, in every mode.

---

## How a human interacts with the agent

The studio is built around one idea: **your selection is your pointer into the conversation.** Everything you do in the viewport is relayed to the agent as live context, so “this”, “that”, “it” are never guesses.

```text
  ┌────────── you ──────────┐          ┌────────── Orbit ─────────┐
  │ type / speak intent     │ ───────▶ │ route intent to a goal    │
  │ click to select         │          │ level tool (deterministic)│
  │ hover to point          │ ───────▶ │ attach live selection &   │
  │ drag to reposition      │          │ hover context automatically│
  │ toggle permissions      │          │                           │
  └─────────────────────────┘          └─────────────┬─────────────┘
        ▲                                            │
        │   proposal card: + forms · ~ refinements   │
        │   ~ removals — per-step toggles            │
        │   [ Approve ] [ Modify ] [ Reject ]        │
        │                                            ▼
        └──── watch it build live ◀── stream ops one at a time
```

**Every input channel feeds the same shared scene:**

- **Text & voice.** Type in the composer or use the browser mic. Say “make *that* taller” while hovering a form — spatial pointing wins over selection, so the agent edits exactly the form under your cursor.
- **Selection relay.** Clicking a form updates a `selection_context` that (1) the local router reads automatically, (2) external integrations receive as a `webmcp-selection-context` browser event, (3) compatible native bridges receive via `navigator.modelContext`, and (4) **every tool result carries as `live_context`** — so an agent never acts on stale selection.
- **Granular approval.** A proposal lists each planned operation with its own switch. Keep the body, exclude the fins and camera, approve the rest — the human decides the *scope* of every run.
- **Interruptible builds.** Streamed runs stop cleanly at operation boundaries. A completed *or interrupted partial* run is one transaction: **Keep changes** or **Undo agent run**.
- **Edit locks.** While the agent works on a form, the human’s drag/inspector/delete on that same form is locked out (outline + inspector show it) — no races between the two collaborators.
- **Permissions, not trust.** Six human-controlled gates: **Read · Create · Modify · Delete · Export · Share**. Turn off Read and every read tool — and the local bridge — politely refuse.
- **Full-space canvas.** The **⤢ / ⤡** buttons in the canvas HUD (or the `V` key / Viewport focus control) collapse and restore the manual panels on demand, so you can frame the model in the entire 3D space — the agent keeps working while the chrome disappears.
- **Take the model with you.** **Download STL ⤓** in the canvas toolbar saves the current scene locally, with the file attached to the chat as a card you can re-download anytime. Agent-initiated exports do the same thing through the approval flow — the STL downloads and the file lands in the conversation. Nothing is ever uploaded.
- **Time-travel audit.** Every action (human or agent) is logged with parameters and a scene snapshot. Scrub the timeline to inspect any past state read-only, then return to live.
- **Bring your own LLM key.** Click **API key** in the top bar to connect an OpenAI-compatible, Anthropic, Gemini, or custom/local-proxy model. The key lives in memory for the current tab only — it is never written to `localStorage` and only reaches the provider you chose. Open-ended builds are still staged as approval-gated proposals; deterministic reads and edits stay local.
- **Wipe after use.** The same panel has **Wipe everything** (two-click armed confirmation), which clears the scene, checkpoints, history, activity, annotations, constraints, preferences, the share fragment, and the API key in one go.
- **Project memory.** “Remember that I prefer low poly.” — preferences and a collaboration persona (Adaptive co-designer, Visual designer, Geometry engineer, Design reviewer) persist across local sessions.

### A turn, end to end — “make it taller”

What actually happens when you select a form and type four words:

1. **Route.** The local intent router (`js/agent-router.js`) deterministically maps your sentence to a goal-level tool: `edit_geometry` with `operation: stretch, axis: y, factor: 1.4` — and attaches your selection, so the target is known, not guessed.
2. **Dispatch.** The agent request handler answers the route: reads, inspections and option lists are served directly from live state; edits stage a **visible proposal** — never a silent mutation.
3. **Stage.** A proposal card appears: *Stretch Y ×1.40 · Cargo pod*, the exact patch, why it was proposed, and one toggleable operation.
4. **Approve.** You click Approve (or it auto-applies as a batch in Direct mode).
5. **Stream.** The operation applies in the Three.js viewport with a build overlay, per-step status, timeline event, and a lock on the form.
6. **Recover.** The whole run sits one **Undo** away. Save a checkpoint if you want it pinned permanently.

That loop — **observe → plan → propose → approve → act → verify** — is the entire product.

---

## How the agent builds 3D objects

There’s no magic and no server: **the scene is plain JSON, and every agent operation is a diff against it.**

### 1. Geometry is data

Each form is a structured record the canvas renders and the agent reasons about:

```ts
{
  id: 'cube_1', name: 'Cargo pod',
  type: 'cube' | 'sphere' | 'cylinder' | 'cone' | 'torus' | 'plane',  // ◇ ○ ▤ △ ⊙ ▱
  position: [x, y, z],        // world units
  rotation: [rx, ry, rz],     // radians
  scale: [sx, sy, sz],        // non-uniform
  material: 'metal' | 'plastic' | 'glass' | 'wood' | 'emissive',
  color: '#c8c8c8',           // monochrome value
  texture: 'brushed',         // procedural pattern (below)
  textureScale: 1,            // .25 – 8
  roughness: 0.85 | null,     // null → finish default, overridable
  metalness: 0.92 | null,
  detail: 'low' | 'standard' | 'high',   // mesh resolution + live triangle estimate
  tags: ['body']              // semantic hooks for search & reviews
}
```

`edit_geometry` changes any of it: swap the primitive (`set_type`), change mesh resolution (`set_detail`), `stretch` one axis, `scale`, `rotate` in degrees, `move`, or `drop_to_ground` — computed against the object’s true rotated world bounds, so “drop to ground” lands exactly on the plane.

### 2. Surfaces are procedural — no image assets

The studio is **monochrome by design** (values run `#111111 → #fafafa`; the model is the only thing carrying a colour budget). Texture is pattern, not picture:

| Texture | Feel | | Finish | Roughness | Metalness |
|---|---|---|---|---|---|
| `none` | clean | | `metal` | 0.21 | 0.92 |
| `grid` | panelled | | `plastic` (matte) | 0.62 | 0.04 |
| `brushed` | machined | | `glass` | 0.05 | 0.02 |
| `noise` (grain) | weathered | | `wood` (grain) | 0.85 | 0.02 |
| `checker` | technical | | `emissive` | 0.30 | 0.10 |
| `hatch` | shaded | | | | |
| `dots` | perforated | | | | |

Patterns are generated on a 2D canvas at runtime and applied as `CanvasTexture`s, so **every surface is reproducible from JSON alone** — the same state, the same render, on any machine. `refine_texture` stages pattern, scale, finish, roughness, metalness, or value changes as visible diffs. `list_surface_options` hands the agent the *real* option set so refinements are planned against what actually exists.

### 3. Multi-part objects are planned, not thrown

For named builds — **rocket, delivery drone, robot** — the agent plans each primitive component (body, arms, rotor cores, sensors…) as individually reviewable steps. You can drop, shrink, or re-materialise specific parts before approving. Symmetry can be requested as a *change* (missing mirrored counterparts only) or as a **constraint** — a guardrail every future run is validated against, alongside an on-ground constraint.

### 4. Verification is built in

After any build the agent can run `validate_scene` (deterministic: intersections, symmetry, active constraints) and `analyze_design` (a transparent, project-specific heuristic review). Every metric is clickable into its exact evidence — the paired/unmatched objects, the intersecting bounds, the materials — and review-informed suggestions only ever stage the *safe* improvements.

```text
   inspect ──▶ plan ──▶ stage ──▶ approve ──▶ stream ──▶ verify
      ▲                                                              │
      └────────────── you steer the next change ◀─────────────────────┘
```

---

## The WebMCP surface — 32 goal-oriented tools

Instead of turning every button into a tool, Orbit exposes **32 tools at the level of goals** — observe first, plan at intent-level, request approval, verify the result. When the browser supports `navigator.modelContext`, these register natively; in any browser, the identical surface is available through the local bridge:

```js
window.webMCPStudio.listTools();
await window.webMCPStudio.callTool('get_scene');
await window.webMCPStudio.callTool('edit_geometry', { operation: 'stretch', axis: 'y', factor: 1.4 });
```

| Layer | Tool | What it does |
|---|---|---|
| **Read** | `get_scene` | Complete structured scene: geometry, selection, constraints, intent, stats, bounds |
| | `get_selected_object` | Resolve “this” / “that” to the human’s current selection |
| | `find_objects` | Semantic search — “front camera”, “glass forms”, “left wheel” (with alias tables: wheel↔propulsion, window↔glass…) |
| | `get_scene_statistics` | Counts by type/material/texture, symmetry score, bounding box, versions |
| | `get_design_context` | Intent, style, active guardrails, annotations |
| **Inspect** | `inspect_object` | Deep read of one object: geometry, resolution, world bounds, resolved surface, triangle estimate, annotations, nearest neighbours, lock state |
| | `list_surface_options` | Every texture, finish, resolution and primitive the studio actually supports |
| | `get_history` | Auditable operations without exposing internal snapshots |
| | `get_activity_timeline` | Full decision timeline with snapshot availability per event |
| | `get_activity_snapshot` | Read one historical scene snapshot, live scene untouched |
| **Geometry** | `edit_geometry` | `set_type` · `set_detail` · `stretch` · `scale` · `rotate` · `move` · `drop_to_ground` — staged as a visible, reversible diff |
| **Surface** | `refine_texture` | Procedural pattern, texture scale, finish, roughness, metalness, greyscale value — staged as a visible diff |
| **Memory** | `get_preferences` / `save_preference` / `remove_preference` | Browser-local project memory the human teaches explicitly |
| | `set_project_persona` | Persist the collaboration role: Adaptive / Designer / Engineer / Reviewer |
| **Plan** | `propose_changes` | Stage a visible, non-mutating plan from high-level create/modify/delete/symmetrize/snap changes |
| | `create_composite_object` | Plan a named multi-part object from primitive components |
| | `modify_object` | Stage one focused, structured modification |
| **Approval** | `apply_approved_proposal` | Reports whether the human approved — can *never* bypass the UI consent |
| **Verify** | `validate_scene` | Deterministic geometry, symmetry and constraint diagnostics |
| | `analyze_design` | Transparent heuristic review with per-metric evidence |
| **Constraints** | `add_constraint` / `list_constraints` | Stage or read symmetry / on-ground guardrails + latest validation |
| **Versions** | `create_version` / `list_versions` / `restore_version` | Named checkpoints (up to 12); restore is always staged for approval |
| **Control** | `undo_agent_changes` | Revert the latest reversible agent batch |
| | `interrupt_agent_run` | Stop a live streamed run cleanly at an operation boundary |
| **Collaborate** | `add_comment` | Attach a contextual annotation to a form |
| **Sensitive** | `export_stl` | Permission-gated, approval-staged local STL download — the file downloads and is attached to the chat as a re-downloadable card |
| | `share_scene` | Permission-gated, approval-staged URL-fragment state link (no upload) |

---

## The functions Orbit uses

Orbit runs on a small, deliberate stack — no framework, no build step, no server:

- **Three.js r164** (ES modules via an import map, so addon imports like `OrbitControls` and `STLExporter` resolve their bare `three` specifier) — rendering, raycast picking, selection bounds, grid, procedural `CanvasTexture`s, and local STL export. If WebGL is unavailable, the viewport is replaced with an explanation and **everything else keeps working** — the object list, inspector, history, and all 32 tools.
- **A pure, deterministic intent router** (`js/agent-router.js`). A dependency-free set of functions — `routePrompt`, `detectColor`, `textureParameters`, `geometryParameters`, `extractRestoreTarget`… — maps natural language to `{ tool, parameters, requiresHumanApproval, sensitive }`. Deterministic on purpose: the same sentence always routes the same way, which is what makes it *testable* (below).
- **A WebMCP tool registry.** 32 JSON-schema-described tools whose handlers read the *live* scene, stage proposals, and attach `live_context` to every successful result. Registered natively via `navigator.modelContext` when available; always available through `window.webMCPStudio`.
- **One shared in-memory scene state.** Objects, constraints, comments, intent, history, versions, proposals, permissions, and the activity log live in a single plain-JS store that powers the canvas, the inspector, the planner, the tools, and the persistence layer — so the human and the agent can never see different worlds.
- **Local persistence & hand-off.** Workspace (scene + 12 checkpoints + memory) autosaves to `localStorage` and restores on reload — *including intentionally empty scenes, with their checkpoints and memory intact*. Share links encode the scene in the URL fragment for offline, serverless hand-off.
- **Optional bring-your-own-model bridge** (`js/llm-provider.js`). A dependency-free client for OpenAI-compatible, Anthropic, Gemini, and custom/local-proxy endpoints. It holds the key in memory only, tests the connection without persisting anything, and hands open-ended creative builds to the chosen model while every proposal still passes the human approval flow.
- **Browser platform features.** `SpeechRecognition` for voice direction, `Blob` + object URLs for local STL download, `CustomEvent` for the selection relay, `prefers-reduced-motion` for accessible motion.
- **A monochrome design system.** OpenAI’s type stack (`OpenAI Sans → Söhne → Inter → Helvetica Neue`, with Inter as the metric-compatible open fallback) and `JetBrains Mono` for numeric readouts. Hierarchy comes from value, weight and space — never hue.

### Verified, not vibes

`npm run check` runs syntax checks **plus** the agent evaluation suite:

```bash
npm run check
# Orbit agent workflow evaluation: 38/38 passed
# Dispatch coverage: all 25 router tools are explicitly handled or are intentional plan builders.
```

`evals/agent-workflows.json` holds **38 prompts** with expected tool choice, parameter extraction, approval state, and sensitive-action handling (20 approval-gated, 4 sensitive). A static **dispatch-coverage guard** additionally proves that every tool the router can return is explicitly handled by the agent request handler — read routes can never silently degrade into geometry proposals again.

---

## Architecture

```text
┌──────────────────────────── Browser (no backend) ────────────────────────────┐
│                                                                              │
│  Viewport (Three.js) ◀── render ──▶  Object list · Inspector · Constraints   │
│         ▲                                                    Comments        │
│         │ live streaming builds                                  │           │
│         │                                                        ▼           │
│  ┌──────┴──────────────────── Shared scene state (plain JS) ────────────┐    │
│  │ objects · transforms · procedural surfaces · detail · constraints    │    │
│  │ comments · design intent · versions · history · permissions · locks  │    │
│  └──────┬──────────────────────────────┬────────────────────────────────┘    │
│         │                              │                                      │
│         ▼                              ▼                                      │
│  History · 12 checkpoints       WebMCP tool registry (32 tools)              │
│  Undo/redo · time-travel        ├── navigator.modelContext (native)          │
│  Activity timeline (snapshots)  └── window.webMCPStudio (local bridge)       │
│         ▲                                                                   │
│         │  proposal cards · approval · interrupt · locks                    │
│  Human: text · voice · select · hover · drag · permissions                  │
│         │                                                                   │
│         └── intent router (pure, deterministic, eval-tested)                │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Safety model.** Read/write separation · everything staged before it happens · human approval on every mutation · six permission gates · object-level edit locks · per-run transactional undo · version checkpoints · complete activity audit. Export and destructive actions are sensitive in every mode.

**Privacy model.** No backend. No model-data upload, ever. Share links and STL files are local artifacts. Local storage is a convenience, not a service — and it’s re-validated field by field on restore. If you opt into a personal LLM API key for open-ended planning, that key is intentionally *not* persisted: it stays in the page's memory and is cleared on refresh/close or with **Wipe everything**.

---

## Run it

```bash
cd Web-mcp
python3 -m http.server 8080 --bind 0.0.0.0
# → http://localhost:8080
```

> Three.js, OrbitControls and STLExporter load as ES modules from jsDelivr, so the browser needs internet access — or vendor them locally for an offline deployment.

**Verify the agent layer:**

```bash
npm run check    # syntax + 38/38 intent-routing evals + dispatch coverage
npm run evals    # evals only
```

---

*Built for a human-first WebMCP experience. The agent has the tools; you have the taste, the selection, the permissions, and the Undo button.*

**observe → plan → propose → approve → act → verify** ✦

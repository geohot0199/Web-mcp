# WebMCP 3D Modeling Agentic Collaboration Platform

## Architecture Overview

The application follows a **client-side agent-ready architecture** where the website itself exposes callable tools via the W3C `navigator.modelContext` API. No backend server is required for core functionality — all 3D modeling, state management, and collaboration happens entirely in the browser.

### High-Level Layers

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Presentation** | HTML5, CSS3, Three.js (WebGPU fallback) | Render 3D scene, UI controls, collaboration interface |
| **Agent Layer** | `navigator.modelContext` API | Register/Expose tools to AI agents, receive tool calls |
| **State Layer** | JavaScript state + localStorage | Model geometry, materials, camera, undo-redo history, session data |
| **Collaboration Layer** | UI-mediated human-agent feedback | Human approves/refines agent changes, agent suggests next moves |

### Core Design Principles

1. **Browser-Only (Zero Backend)**: All model state, transformations, and collaboration state live in the client. Optional Cloudflare Pages/Durable Objects can be added later for persistence, but the core WebMCP experience is offline-first.
2. **Tool-First API**: Every interaction the agent can perform is registered as a structured tool with a JSON schema. The agent calls tools via `navigator.modelContext.executeTool('tool_name', params)`.
3. **Human-in-the-Loop**: Every agent-initiated change is visually indicated and requires human acceptance or can be instantly undone via Ctrl+Z / undo stack.
4. **State Serialization**: Model state is a JSON object including: object list (id, type, position, rotation, scale, material, layer), camera parameters, undo-redo stack. Serialized to/from `localStorage`.
5. **Performance**: O(1) tool execution for individual object ops; scene graph traversal only when needed (render). Undo-redo is an array of snapshots (max 50 for memory efficiency).

---

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                     navigator.modelContext                          │
│  ┌─────────────────────┐  ┌─────────────────────┐  ┌────────────┐ │
│  │  Registered Tools   │  │   Agent Calls      │  │  Browser   │ │
│  │  (move, rotate,    │  │  executeTool()     │  │          │ │
│   │   scale, etc.)    │  │  with JSON params  │  │          │ │
│  └─────────────────────┘  └─────────────────────┘  └────────────┘ │
│           ▲  ▲  ▲  ▲  ▲  ▲  ▲  ▲  ▲  ▲  ▲  ▲  ▲  ▲  ▲  ▲  ▲  ▲  │
│           │  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │
│           │  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │
│           │  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │
│    Human  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │
│  Inputs   │  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │
│  (click,  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │
│   drag)   │  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │
└───────────┘  └────┘  └────┘  └────┘  └────┘  └─────────────────────┘
         \                                              /
          \                                            /
           \                                          /
            ✂  Human‑Agent Shared State (canvas + undo)  ✂
                                                 │
                                                 ▼
                                          ┌─────────────────┐
                                          │   Three.js      │
                                          │   Renderer      │
                                          │   Scene, Camera │
                                          │   Objects       │
                                          └─────────────────┘
                                                 │
                            ┌────────────────────┼─────────────────────┐
                            │                    │                     │
                            ▼                    ▼                     ▼
                UI Controls (orbit, pan, zoom)    Agent Tool Panel   Human Accept/Refine
                            │                    │                     │
                            └────────────────────┘                     └───────────────┘
```

### Data Flow Sequence

1. **App Initializes**: Three.js scene setup, model state loaded from `localStorage` (or default cube). WebMCP tools registered via `navigator.modelContext.addTool()`.

2. **Human Action**: Human uses UI controls (orbit, select object, move handle). UI updates local state → Three.js re-renders → undo snapshot pushed.

3. **Agent Suggestion**: Agent calls `executeTool('move_object', {object_id: 'xyz', axis: 'x', distance: 2.5})`. Tool function executes in page JS context:
   - Updates object's position in state
   - Triggers re-render
   - Visually highlights the change (e.g., glowing border)
   - Pushing to undo stack with "agent" tag

4. **Human Accept/Refine**: Human sees the change. Options:
   - **Accept**: Change stays, undo stack updated with "accepted" marker
   - **Refine**: Human adjusts via UI, agent observes and suggests further tweaks
   - **Reject**: Ctrl+Z or "undo agent change" button, state reverts

5. **Session Save/Load**: State JSON serialized to `localStorage` under key `webmcp-3d-model`. Shareable link can encode the state base64.

6. **Export**: Agent or human clicks "Export STL/OBJ" → state converted to mesh data → downloadable.

### Time & Space Complexity

| Operation | Time Complexity | Space Complexity |
|-----------|----------------|-----------------|
| Register N tools | O(N) (once on init) | O(N) (tool schemas) |
| Single object op (move/rotate/scale) | O(1) — direct property update | O(1) per op |
| Render scene (N objects) | O(N) — GPU culling | O(N) — scene graph |
| Undo/Redo (snapshot) | O(1) — push/pop array | O(K·N) — K snapshots, capped at 50 |
| Save/Load state | O(M) — M = serialized JSON size | O(M) — localStorage |
| Agent tool dispatch | O(1) — schema validation + exec | O(1) — transient |

---

## Feature Set (25 Features)

### Core 3D Interaction (7)
1. **Orbit Camera** — Mouse drag rotates camera around center
2. **Pan Camera** — Middle-drag or WASD moves camera plane
3. **Scroll Zoom** — Zoom in/out via mouse wheel
4. **WASD Camera Move** — Keyboard-controlled camera translation
5. **Reset View** — Camera snaps to isometric default
6. **Multi‑Angle Presets** — Buttons for Front/Back/Left/Right/Top/Bottom/Isometric
7. **Grid Snap** — Objects snap to 1-unit grid when moved/rotated/scaled

### Object Management (8)
8. **Add Primitive** — Create cube, sphere, cylinder, cone, plane
9. **Remove Selected** — Delete currently selected object
10. **Duplicate Object** — Clone selected object with incremented ID
11. **Move Along Axis** — Nudge object +1/−1 on X, Y, or Z
12. **Rotate On Axis** — Rotate selected object 15° on X, Y, or Z
13. **Scale Uniform/Non‑Uniform** — Grow/shrink proportionally or on individual axes
12. **Undo / Redo** — Ctrl+Z / Ctrl+Y with full state history (capped at 50 steps, labeled "human"/"agent")
13. **Redo After Agent Reject** — Restore agent‑suggested change if human refines then re‑accepts

### Material & Appearance (5)
14. **Color Picker** — Assign RGB color to selected object
15. **Material Library** — Pre‑defined materials (metal, plastic, glass, wood, emissive)
16. **Texture Upload** — Drag‑and‑drop texture image applied to selected object
17. **Emissive Intensity** — Slider for self‑lighting strength
18. **Opacity / Transparency** — Alpha slider for glass‑like effects

### Collaboration & Session (5)
19. **Undo Agent Change** — One‑click revert of the most recent agent‑initiated move
20. **Accept Agent Suggestion** — Confirm and lock in the agent's last transformation
21. **Share Session Link** — Generates a URL encoding the current model state (base64‑JSON) for sharing
22. **Session Expiry (local-only)** — State persists in localStorage until manually cleared
23. **Change History Timeline** — Chronological list of all moves (human/agent labeled), clickable to snap view to that state

### Export & Integration (3)
24. **Export STL** — Convert scene to binary STL for 3D printing
25. **Export JSON State** — Download full model state for backup or external tooling

### Agent‑Ready WebMCP Tools (registered via `navigator.modelContext`)

| # | Tool Name | Description | Key Parameters |
|---|-----------|-------------|----------------|
| T1 | `move_object` | Move an object along an axis | `object_id`, `axis` (x|y|z), `distance` (number) |
| T2 | `rotate_object` | Rotate an object on an axis | `object_id`, `axis` (x|y|z), `degrees` (number) |
| T3 | `scale_object` | Scale an object uniformly or per‑axis | `object_id`, `uniform` (bool), `factor` (number) |
| T4 | `add_primitive` | Add a new primitive shape | `type` (cube|sphere|cylinder|cone|plane) |
| T5 | `remove_object` | Remove an object from the scene | `object_id` |
| T6 | `set_material` | Apply color/material to object | `object_id`, `material` (name or RGB) |
| T7 | `undo_agent_change` | Revert the most recent agent‑initiated op | — |
| T8 | `accept_agent_suggestion` | Accept and lock the agent's last change | — |
| T9 | `export_stl` | Request STL export of current scene | — |
| T10 | `load_model_state` | Load model from saved JSON state | `state_json` |

---

## UI/UX Flow

1. **Load** → Default cube scene, tools auto‑registered, undo stack empty
2. **Human builds** → Uses UI controls, each action pushed to undo stack
3. **Agent responds** → Agent calls a WebMCP tool → Change glows blue, human accepts/rejects
4. **Iterate** → Human refines, agent suggests next move → loop
5. **Export/share** → One‑click STL/JSON download, shareable link generation

---

## Security & Vulnerability Considerations

- **No external network calls** during normal operation (offline-first)
- **localStorage** data is user‑controlled; no injection risks since only app code parses it
- **Tool schemas** are validated before execution — malformed params are rejected and logged
- **undo stack** is capped at 50 entries to prevent memory exhaustion
- **DOM events** use standard Three.js event model; no `eval()` or dynamic code execution
- **Export functions** produce static binary/JSON; no code injection possible
- **CSP‑friendly**: All scripts are inline or from trusted CDN with `crossorigin` attribute where needed
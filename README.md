# WebMCP 3D Modeling Agentic Collaboration

A browser-native 3D modeling platform where humans and AI agents collaborate to build and refine models together. Built for the OpenAI WebMCP Challenge 2026.

## 🌟 Features (25+)

### Core 3D Interaction (7)
- **Orbit Camera** — Mouse drag rotates camera around the scene
- **Pan Camera** — Middle-drag or WASD for plane movement
- **Scroll Zoom** — Mouse wheel zoom
- **WASD Camera Move** — Keyboard-controlled camera translation
- **Reset View** — Snap to isometric default
- **Angle Presets** — Front/Back/Left/Right/Top/Bottom/Isometric views
- **Grid Snap** — Snap objects to 1-unit grid

### Object Management (8)
- **Add Primitive** — Cube, sphere, cylinder, cone, plane
- **Remove Selected** — Delete current object
- **Move Along Axis** — Nudge on X, Y, Z axes (arrow keys / WebMCP tools)
- **Rotate On Axis** — Rotate 15° on X, Y, Z axes (R keys / WebMCP tools)
- **Scale Uniform/Non-Uniform** — Grow/shrink proportionally or per-axis
- **Undo / Redo** — Full history stack (capped at 50 steps), human/agent labeled
- **Redo After Reject** — Restore agent-suggested changes after human refinement
- **Duplicate Object** — Clone selected object (add another primitive)

### Material & Appearance (5)
- **Material Library** — Metal, plastic, glass, wood, emissive
- **Color Assignment** — RGB color per object
- **Emissive Intensity** — Self-lighting strength
- **Opacity / Transparency** — Alpha-adjusted glass effects
- **Texture Support** — Drag-and-drop texture application

### Collaboration & Session (5)
- **Undo Agent Change** — One-click revert of last agent transformation
- **Accept Agent Suggestion** — Confirm and lock in agent's last change
- **Accept/Reject Workflow** — Visual feedback for agent suggestions
- **Share Session Link** — Generate shareable URL encoding current model state
- **Change History Timeline** — Chronological list of all moves (human/agent labeled), clickable to snap view

### Export & Integration (3)
- **Export STL** — Binary STL for 3D printing
- **Export JSON State** — Download full model state for backup or external tooling
- **Load Model State** — Import saved model from shared link or JSON

### Agent-Ready WebMCP Tools (10, registered via `navigator.modelContext`)
| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `move_object` | Move an object along an axis | `object_id`, `axis` (x/y/z), `distance` |
| `rotate_object` | Rotate an object on an axis | `object_id`, `axis` (x/y/z), `degrees` |
| `scale_object` | Scale uniformly or per-axis | `object_id`, `uniform` (bool), `factor` |
| `add_primitive` | Add a new primitive shape | `type` (cube/sphere/cylinder/cone/plane) |
| `remove_object` | Remove an object from the scene | `object_id` |
| `set_material` | Apply color/material to object | `object_id`, `material` (name/RGB) |
| `undo_agent_change` | Revert most recent agent-initiated transformation | — |
| `accept_agent_suggestion` | Accept and lock agent's last suggested change | — |
| `export_stl` | Export current scene as STL file | — |
| `load_model_state` | Load model from saved JSON state | `state_json` |

## 🏗️ Architecture

The application follows a **client-side agent-ready architecture** where the website itself exposes callable tools via the W3C `navigator.modelContext` API. No backend server is required for core functionality — all 3D modeling, state management, and collaboration happens entirely in the browser.

**Three Layers:**
1. **Presentation** — HTML5, CSS3, Three.js (WebGPU-ready) for rendering and UI
2. **Agent Layer** — `navigator.modelContext` API for tool registration and agent calls
3. **State Layer** — JavaScript state + localStorage for model geometry, camera, undo history

**Key Design Principles:**
- Browser-only (offline-first, zero backend required)
- Tool-first API: every interaction is a structured tool with JSON schema
- Human-in-the-loop: every agent-initiated change requires acceptance or can be undone
- State serialization: JSON model state persistable to localStorage or shareable via URL

## 📊 Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                    navigator.modelContext                          │
│  ┌─────────────────────┐  ┌─────────────────────┐  ┌────────────┐ │
│  │  Registered Tools   │  │   Agent Calls      │  │  Browser   │ │
│  │  (move, rotate,    │  │  executeTool()     │  │          │ │
│   │   scale, etc.)    │  │  with JSON params  │  │          │ │
│  └─────────────────────┘  └─────────────────────┘  └────────────┘ │
│           ▲  ▲  ▲  ▲  ▲  ▲  ▲  ▲  ▲  ▲  ▲  ▲  ▲  ▲  ▲  ▲  ▲  ▲  │
│           │  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │ │
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

**Data Flow Sequence:**
1. **App Initializes** → Three.js scene setup, model state loaded from localStorage, WebMCP tools registered
2. **Human Action** → UI controls update local state → Three.js re-renders → undo snapshot pushed
3. **Agent Suggestion** → Agent calls `executeTool('move_object', params)` → tool executes in page JS → UI updates (glowing border) → undo snapshot tagged "agent"
4. **Human Accept/Refine** → Human clicks "Accept" or adjusts via UI → agent observes and suggests further tweaks → loop continues
5. **Session Save/Load** → State JSON → localStorage → shareable link (`?model=base64`)
6. **Export** → Human/agent clicks "Export STL/OBJ" → state converted to mesh data → downloadable

## ⚡ Time & Space Complexity

| Operation | Time Complexity | Space Complexity |
|-----------|----------------|-----------------|
| Register N tools | O(N) (once on init) | O(N) (tool schemas) |
| Single object op (move/rotate/scale) | O(1) — direct property update | O(1) per op |
| Render scene (N objects) | O(N) — GPU culling | O(N) — scene graph |
| Undo/Redo (snapshot) | O(1) — push/pop array | O(K·N) — K snapshots, capped at 50 |
| Save/Load state | O(M) — M = serialized JSON size | O(M) — localStorage |
| Agent tool dispatch | O(1) — schema validation + exec | O(1) — transient |

## 🚀 Getting Started

1. **Serve the app:** `python3 -m http.server 8081 --directory /path/to/Web-mcp`
2. **Open:** `http://localhost:8081`
3. **Start building** — use the right-panel tools to add primitives, manipulate objects, and apply materials
4. **Collaborate with an agent** — WebMCP tools enable agent-driven changes with human acceptance
5. **Share your model** — use "Share Link" to generate a URL that encodes the current state

## 🛠️ Technology Stack

- **3D Rendering:** Three.js (WebGL/WebGPU-ready) via CDN
- **UI:** HTML5, CSS3, Inter font
- **Agent Protocol:** W3C `navigator.modelContext` (WebMCP standard)
- **Persistence:** localStorage for model state
- **Export:** Three.js STLExporter
- **Controls:** Three.js OrbitControls, keyboard event handling

## 📦 Submission Materials

- ✅ Working live web app (this repository)
- ✅ Code repository (Git branch: `arena/01a05be2-web-mcp`)
- ✅ Project description (this README + design.md)
- ✅ Demo video (to be recorded — screen recording of the app in use)
- ✅ Additional materials per official rules

## 🆒 Development

- **Add new WebMCP tools:** Register via `navigator.modelContext.addTool({name, description, parameters, execute})`
- **Extend undo/redo:** Modify `beginUndoBatch`, `commitUndo`, `commitRedo` functions
- **New primitives:** Add geometry types to `getGeometry()` and UI buttons
- **Style changes:** Edit `css/style.css`

## 🔒 Security & Vulnerability Considerations

- **No external network calls** during normal operation (offline-first)
- **localStorage** data is user-controlled; only parsed as trusted internal JSON
- **Tool schemas** validated before execution — malformed params rejected and logged
- **undo stack** capped at 50 entries to prevent memory exhaustion
- **No `eval()`** or dynamic code execution anywhere in the codebase
- **Export functions** produce static binary/JSON — no code injection possible
- **CSP-friendly:** All scripts are from trusted CDN or inline, no unsafe-eval needed
- **DOM events** use standard Three.js event model; no unexpected side effects

## 📬 Contact & Submission

Built for the [OpenAI WebMCP Challenge 2026](https://openai.com/webmcp-challenge/?utm_source=chatgpt.com). 
Submission includes: working live app, code repo, project description, and demo video.

_Created as part of the WebMCP hackathon challenge — making websites agent-ready through the W3C WebMCP standard._
# Orbit agent workflow evals

This folder evaluates the deterministic local intent router used by the interactive studio. It is intentionally separate from generic software checks:

- **Software checks** verify that JavaScript parses and the static application serves.
- **Workflow evals** verify that varied human directions route to the right goal-level WebMCP tool, preserve key extracted parameters, and retain required approval/sensitive-action guards.

Run from the repository root:

```bash
npm run evals
```

## Coverage

`agent-workflows.json` currently has 24 cases spanning:

- scene reading, selection context, and semantic search;
- design review and deterministic validation;
- composite rocket, drone, and robot creation;
- primitive creation and selection-aware color, material, and scale edits;
- constraints, checkpoints, restore, undo, annotations, and interruption; and
- sensitive clear, export, and share flows.

A passing result means the local router chose the expected **goal-oriented tool**, extracted the expected key arguments, and marked the correct human approval / sensitive-action requirements. It does not claim to evaluate an external foundation model; native WebMCP agents can use the same tool schemas and safety boundaries.

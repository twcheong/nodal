# Canvas performance check

The editor toolbar includes a **200 노드 측정** action. It replaces the current
document with a deterministic 200-node chain, pans the viewport for 90 animation
frames, and reports the measured frame rate beside the action.

## 2026-08-14 baseline

- Browser: foreground Codex in-app browser, desktop viewport (1280 × 720)
- Visibility check: `document.visibilityState === "visible"`, `document.hidden === false`
- Graph: 200 nodes, 199 edges
- Result: **116 fps** over 90 animation frames
- Mounted node bodies during the run: **24 / 200**
- Minimap nodes: 200 / 200

The measured refresh rate can exceed 60 Hz. The M2 gate is therefore evaluated as
`fps >= 60`, while the mounted-node count confirms that off-viewport node bodies
are not retained in the DOM.

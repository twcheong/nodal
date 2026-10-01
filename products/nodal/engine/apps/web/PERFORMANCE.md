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

## 2026-08-17 M4 preview load

- Browser: foreground Codex in-app browser, desktop viewport (1280 × 720)
- Graph: 200 nodes, 199 edges
- Result after the M4 runtime subscription split: **117 fps** over 90 animation frames
- Step stream: progress and inline previews arrived every 35 ms in mock mode
- Rendering guard: progress/preview events keep only the latest value per node and flush at most
  every 100 ms; the canvas projection no longer subscribes to per-node runtime state

The preview stress test showed one mounted preview image while the step label advanced. Browser
console warnings and errors remained empty.

# Nodal Agent Configuration

Single agent. No sub-agents, no browser, no web access.

## Tools

- `nodal__*` — the Nodal engine (templates, runs). How to use it is already in your instructions (SOUL.md is loaded into them) — do not read SOUL.md or AGENTS.md from disk.
- `read` / `write` / `edit` — files inside the workspace only.
- `image` — look at an image file (an input the user dropped in, or a saved result).

## Workspace Layout

All paths are relative to the workspace root (the folder the user picked in the app).

```
<workspace root>/
├── inputs/       # images the user brought in to animate or edit
├── outputs/      # results the user chose to keep
└── notes/        # prompts, shot lists, anything the user asks you to remember
```

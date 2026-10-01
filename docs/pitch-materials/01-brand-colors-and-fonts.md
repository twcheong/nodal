# Twixy Brand Colors & Fonts

Extracted from the actual product (`src/styles/globals.css`) so the deck matches the app.
Twixy is a dark-UI product — the deck should use the dark palette as its base.

## Logo

- Vector: `assets/icon.svg`
- PNG (256px): `assets/icon-256.png`
- App icon set: `assets/icon.iconset/`, `assets/icon.icns`, `assets/icon.ico`

## Color Palette

### Backgrounds (dark base)

| Token | Hex | Use in deck |
|---|---|---|
| Base | `#0F0F0F` | Slide background |
| Surface | `#171717` | Card / panel fills |
| Elevated | `#1E1E1E` | Raised cards, table headers |
| Hover / Active | `#242424` / `#2A2A2A` | Subtle emphasis blocks |
| Border | `#2A2A2A` | Card borders, dividers |

### Text

| Token | Hex | Use in deck |
|---|---|---|
| Primary | `#E8E8E8` | Headlines, body text |
| Secondary | `#888888` | Sub-headlines, captions |
| Muted | `#555555` | Footnotes, labels |

### Accent (brand color)

| Token | Hex | Use in deck |
|---|---|---|
| **Accent (Twixy Purple)** | `#7C6AFF` | Logos, highlights, CTA buttons, key numbers |
| Accent dim | `#3D3366` | Accent backgrounds, selected states |
| Accent glow | `rgba(124,106,255,0.15)` | Soft highlight washes |

### Status colors

| Meaning | Hex |
|---|---|
| Success / Running OK | `#4ADE80` (green) |
| Error / Failed | `#F87171` (red) |
| Warning / Pending | `#FACC15` (yellow) |

Use status colors only for workflow-status content (dashboard, logs, before/after) — not as decoration.

## Typography

The product uses system font stacks — no licensed webfonts needed for the deck.

| Role | Stack | Deck recommendation |
|---|---|---|
| Sans (UI/body) | `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif` | **SF Pro** (Mac/Keynote) or **Segoe UI** (Windows/PowerPoint); Inter is a safe cross-platform substitute |
| Mono (code/logs) | `'SF Mono', 'Fira Code', monospace` | Use for workflow-log or prompt snippets on slides |

### Suggested slide type scale

- Slide title: 32–40pt, semibold, `#E8E8E8`
- Section label: 14–16pt, uppercase, `#7C6AFF`
- Body: 18–22pt, regular, `#E8E8E8`
- Caption / source: 12–14pt, `#888888`

## Shape language

Product uses rounded corners: 6 / 10 / 14 px radii. Round card corners on slides (~10px equivalent) to match.

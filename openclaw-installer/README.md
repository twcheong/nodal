# OpenClaw Installer 🦞

A one-click GUI installer wizard for [OpenClaw](https://github.com/openclaw/openclaw) — the personal AI assistant. Built with Electron, packages to a Windows `.exe` (NSIS) and a macOS `.dmg` from a single codebase.

---

## What it does

A six-step wizard that:

1. **Welcome** — intro screen.
2. **License** — MIT license agreement.
3. **System check** — detects Node.js and verifies `>= 22`. Opens nodejs.org if missing.
4. **Configuration** — user picks model provider (Anthropic / OpenAI / Google) and pastes API key.
5. **Install** — runs `npm install -g openclaw@latest` with streamed log output.
6. **Finish** — buttons to launch `openclaw onboard --install-daemon` in a terminal and `openclaw dashboard` in the browser.

---

## Project layout

```
openclaw-installer/
├── package.json                # deps + electron-builder config (win + mac targets)
├── src/
│   ├── main/
│   │   ├── main.js             # Electron main process, window + IPC wiring
│   │   ├── preload.js          # contextBridge — safe API to the renderer
│   │   └── installer.js        # all shell-out logic (npm, config writes, terminals)
│   └── renderer/
│       ├── index.html          # wizard shell + all six step panels
│       ├── styles.css          # deep-ocean navy + coral "lobster" theme
│       └── renderer.js         # state machine, step validation, IPC calls
├── build/
│   ├── icon.ico                # ← you need to provide these
│   └── icon.icns
└── README.md
```

---

## Requirements (for building the installer itself)

- **Node.js 18+** and **npm**.
- **macOS** to build the `.dmg` (Apple's codesigning tools only run on macOS).
- **Windows** or **macOS** to build the `.exe` (electron-builder on macOS can cross-build for Windows, but signing is easier on native Windows).

The installer's *users* don't need any of this — they just download the `.exe` or `.dmg` and run it.

---

## Dev loop

```bash
# install deps
npm install

# run in dev mode with devtools open
npm run dev

# normal run
npm start
```

## Build for distribution

```bash
# Windows installer (.exe via NSIS)
npm run build:win

# macOS installer (.dmg, universal x64 + arm64)
npm run build:mac

# Both at once (only works from macOS)
npm run build:all
```

Outputs land in `dist/`:

- `dist/OpenClaw-Setup-1.0.0-win-x64.exe`
- `dist/OpenClaw-Setup-1.0.0-mac-arm64.dmg`
- `dist/OpenClaw-Setup-1.0.0-mac-x64.dmg`

---

## Icons

Drop real icons into `build/` before building:

| File | Format | Sizes |
|---|---|---|
| `build/icon.ico` | Windows ICO | 256×256 minimum |
| `build/icon.icns` | macOS ICNS | 512×512 minimum |

Fastest path: design one 1024×1024 PNG, then use `electron-icon-builder` or [cloudconvert.com](https://cloudconvert.com) to produce both formats.

---

## Code signing (important for real distribution)

Without signing, both OSes will scare users with security warnings.

**Windows** — sign with an EV or OV code signing certificate:

```bash
# in package.json > build.win
"certificateFile": "path/to/cert.pfx",
"certificatePassword": "${env.CERT_PASSWORD}"
```

**macOS** — sign + notarize with an Apple Developer account:

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"
export APPLE_TEAM_ID="XXXXXXXXXX"
```

And add to `package.json > build.mac`:

```json
"hardenedRuntime": true,
"notarize": { "teamId": "XXXXXXXXXX" }
```

---

## How the install actually works

The installer is a thin orchestrator. It doesn't reimplement OpenClaw — it:

1. Checks that Node.js is present (and prompts the user to install it if not).
2. Shells out to `npm install -g openclaw@latest`, streaming stdout/stderr back into the wizard log.
3. Writes the user's provider + API key into `~/.openclaw/.env` (mode `0600`) as a hint for the onboarding wizard.
4. On the final step, spawns a real terminal window (cmd.exe on Windows, Terminal.app via AppleScript on macOS) running `openclaw onboard --install-daemon`. The interactive wizard is kept in a terminal because it's more reliable than trying to drive a TTY from Electron.
5. "Open Dashboard" runs `openclaw dashboard`, which opens the local Control UI in the default browser.

---

## Known gotchas

- **`openclaw onboard` is interactive.** We spawn a real terminal rather than pty-ing inside Electron. If you want a fully embedded experience, add [`node-pty`](https://github.com/microsoft/node-pty) and render a terminal with [xterm.js](https://xtermjs.org/). Expect extra complexity for native rebuilds on each platform.
- **Pre-config file path.** The wizard writes `~/.openclaw/installer-preconfig.yaml` and `~/.openclaw/.env`. Double-check that the OpenClaw version you're targeting actually reads these — the schema evolves. Verify with `openclaw doctor` after install.
- **Permissions on Windows.** Installing global npm packages is fine for a normal user thanks to npm's default prefix, but if the user has a non-writable prefix, `npm install -g` will fail. The log surface in step 5 will show it.
- **macOS Gatekeeper on unsigned builds.** Users will need to right-click → Open the first time, or run `xattr -cr /Applications/OpenClaw\ Installer.app` to clear the quarantine attribute.

---

## License

MIT. Use it, fork it, ship it.

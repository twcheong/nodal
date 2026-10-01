// src/main/installer.js
// All the actual install/onboard work lives here so main.js stays thin.
//
// IMPORTANT: Commands like `openclaw onboard` are interactive (they prompt for
// provider, API key, etc). We take a pragmatic approach for this installer:
//   1. Install the `openclaw` npm package globally (non-interactive, easy).
//   2. Pre-write the user's provider + API key into OpenClaw's config dir so
//      onboarding has sensible defaults.
//   3. Spawn a real terminal window running `openclaw onboard --install-daemon`
//      so the interactive wizard still works as upstream intends.
// This is more reliable than trying to drive an interactive TTY from Electron.

const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');

const execAsync = promisify(exec);

// On Windows, `npm` / `openclaw` resolve to .cmd shims. spawn() needs shell:true
// on Windows to find them; on macOS/Linux a direct spawn is fine.
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// Minimum supported Node.js version (OpenClaw requires >= 22)
const MIN_NODE_MAJOR = 22;

// ---------------------------------------------------------------------------
// 1. Node.js check
// ---------------------------------------------------------------------------
async function checkNode() {
  try {
    const { stdout } = await execAsync('node --version');
    const raw = stdout.trim();            // e.g. "v24.3.0"
    const match = raw.match(/^v(\d+)\./);
    if (!match) {
      return { installed: false, version: raw, meetsRequirement: false };
    }
    const major = parseInt(match[1], 10);
    return {
      installed: true,
      version: raw,
      major,
      meetsRequirement: major >= MIN_NODE_MAJOR,
      minRequired: MIN_NODE_MAJOR,
    };
  } catch {
    return { installed: false, meetsRequirement: false, minRequired: MIN_NODE_MAJOR };
  }
}

// ---------------------------------------------------------------------------
// 2. npm install -g openclaw@latest
// ---------------------------------------------------------------------------
function installOpenClaw(onLog) {
  return new Promise((resolve, reject) => {
    onLog('→ Installing openclaw globally via npm...');
    onLog('$ npm install -g openclaw@latest');
    onLog('');

    const args = ['install', '-g', 'openclaw@latest'];
    const child = spawn('npm', args, {
      shell: IS_WIN, // needed on Windows to resolve npm.cmd
      env: { ...process.env },
    });

    child.stdout.on('data', (buf) => {
      buf.toString().split(/\r?\n/).forEach((line) => {
        if (line.length) onLog(line);
      });
    });
    child.stderr.on('data', (buf) => {
      // npm writes progress to stderr; not an error, just info
      buf.toString().split(/\r?\n/).forEach((line) => {
        if (line.length) onLog(line);
      });
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) {
        onLog('');
        onLog('✓ OpenClaw installed successfully.');
        resolve();
      } else {
        reject(new Error(`npm exited with code ${code}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// 3. Pre-write provider + API key into ~/.openclaw/ so onboarding is smoother
// ---------------------------------------------------------------------------
// NOTE: The exact file name / schema that `openclaw onboard` reads may evolve.
// Verify against the version you're shipping by running `openclaw doctor`.
async function writePreConfig({ provider, apiKey }) {
  const home = os.homedir();
  const dir = path.join(home, '.openclaw');
  await fs.mkdir(dir, { recursive: true });

  // Write a minimal YAML-ish config as a starting point.
  const configPath = path.join(dir, 'installer-preconfig.yaml');
  const contents =
`# Written by OpenClaw Installer
# Picked up during \`openclaw onboard\` as default values.
provider: ${provider}
apiKey: ${apiKey}
`;
  await fs.writeFile(configPath, contents, { mode: 0o600 });

  // Also drop the API key into a provider-specific env file that the user
  // (or the onboarding wizard) can source. Keeps the secret out of shell history.
  const envPath = path.join(dir, '.env');
  const envVarName = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    google: 'GOOGLE_API_KEY',
  }[provider] || 'OPENCLAW_API_KEY';
  await fs.writeFile(envPath, `${envVarName}=${apiKey}\n`, { mode: 0o600 });

  return configPath;
}

// ---------------------------------------------------------------------------
// 4. Launch a real terminal window running `openclaw onboard --install-daemon`
// ---------------------------------------------------------------------------
async function launchOnboardInTerminal() {
  const cmd = 'openclaw onboard --install-daemon';

  if (IS_WIN) {
    // Spawn a new cmd.exe window that stays open after the command finishes.
    spawn('cmd.exe', ['/c', 'start', 'OpenClaw Onboard', 'cmd', '/k', cmd], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    }).unref();
    return;
  }

  if (IS_MAC) {
    // Use AppleScript to open a new Terminal.app window running the command.
    const script = `
      tell application "Terminal"
        activate
        do script "${cmd}"
      end tell
    `;
    await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
    return;
  }

  // Linux fallback — try a few common terminals
  const terminals = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm'];
  for (const term of terminals) {
    try {
      spawn(term, ['-e', 'bash', '-c', `${cmd}; exec bash`], {
        detached: true,
        stdio: 'ignore',
      }).unref();
      return;
    } catch {
      /* try next */
    }
  }
  throw new Error('No supported terminal emulator found.');
}

// ---------------------------------------------------------------------------
// 5. Launch the OpenClaw dashboard (opens a local URL in the default browser)
// ---------------------------------------------------------------------------
async function launchDashboard() {
  // `openclaw dashboard` opens http://localhost:18789 in the user's browser.
  await execAsync('openclaw dashboard', { shell: IS_WIN ? true : '/bin/sh' });
}

module.exports = {
  checkNode,
  installOpenClaw,
  writePreConfig,
  launchOnboardInTerminal,
  launchDashboard,
};

#!/usr/bin/env bash
# Twixy Marketing Copilot — Mac Installer
# Installs OpenClaw + Twixy skill pack

set -e

TWIXY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE="$HOME/.openclaw/workspace/twixy"
OPENCLAW_CONFIG="$HOME/.openclaw/openclaw.json"

echo ""
echo "  ████████╗██╗    ██╗██╗██╗  ██╗██╗   ██╗"
echo "     ██╔══╝██║    ██║██║╚██╗██╔╝╚██╗ ██╔╝"
echo "     ██║   ██║ █╗ ██║██║ ╚███╔╝  ╚████╔╝ "
echo "     ██║   ██║███╗██║██║ ██╔██╗   ╚██╔╝  "
echo "     ██║   ╚███╔███╔╝██║██╔╝ ██╗   ██║   "
echo "     ╚═╝    ╚══╝╚══╝ ╚═╝╚═╝  ╚═╝   ╚═╝  "
echo "  Marketing Copilot — powered by OpenClaw"
echo ""

# ── Check Node.js ────────────────────────────────────────────────
echo "→ Checking Node.js..."
if ! command -v node &>/dev/null; then
  echo "  Node.js not found. Installing via Homebrew..."
  if ! command -v brew &>/dev/null; then
    echo "  Homebrew not found. Please install it first: https://brew.sh"
    exit 1
  fi
  brew install node
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 22 ]; then
  echo "  Node.js v22+ required. Current: $(node -v)"
  echo "  Run: brew install node"
  exit 1
fi
echo "  Node.js $(node -v) ✓"

# ── Install OpenClaw ─────────────────────────────────────────────
echo "→ Installing OpenClaw..."
if command -v openclaw &>/dev/null; then
  echo "  OpenClaw already installed. Updating..."
  npm update -g openclaw@latest --silent
else
  npm install -g openclaw@latest --silent
fi
echo "  OpenClaw $(openclaw --version 2>/dev/null || echo 'installed') ✓"

# ── Create Twixy workspace ───────────────────────────────────────
echo "→ Setting up Twixy workspace at $WORKSPACE..."
mkdir -p \
  "$WORKSPACE/data/raw" \
  "$WORKSPACE/data/insights" \
  "$WORKSPACE/data/scraps" \
  "$WORKSPACE/data/watches" \
  "$WORKSPACE/strategies" \
  "$WORKSPACE/campaigns" \
  "$WORKSPACE/reports" \
  "$WORKSPACE/logs" \
  "$WORKSPACE/skills/custom"
echo "  Workspace created ✓"

# ── Install Twixy config files ───────────────────────────────────
echo "→ Installing Twixy config..."
cp "$TWIXY_DIR/SOUL.md" "$WORKSPACE/SOUL.md"
cp "$TWIXY_DIR/AGENTS.md" "$WORKSPACE/AGENTS.md"
echo "  SOUL.md and AGENTS.md installed ✓"

# ── Install Twixy skills ─────────────────────────────────────────
echo "→ Installing Twixy skills..."
SKILLS_DEST="$WORKSPACE/skills"
for skill in watchtower data-scout strategy-gen campaign-exec analytics; do
  mkdir -p "$SKILLS_DEST/$skill"
  cp "$TWIXY_DIR/skills/$skill/SKILL.md" "$SKILLS_DEST/$skill/SKILL.md"
  echo "  $skill ✓"
done

# ── Write openclaw.json ──────────────────────────────────────────
echo "→ Configuring OpenClaw for Twixy..."
if [ -f "$OPENCLAW_CONFIG" ]; then
  echo "  Existing openclaw.json found. Backing up to openclaw.json.backup..."
  cp "$OPENCLAW_CONFIG" "$OPENCLAW_CONFIG.backup"
fi

mkdir -p "$(dirname "$OPENCLAW_CONFIG")"
cat > "$OPENCLAW_CONFIG" <<'EOF'
{
  // Twixy Marketing Copilot — OpenClaw config
  // Edit model here to switch LLM provider
  agent: {
    model: "anthropic/claude-sonnet-4-6",
    think: "auto",
  },
  agents: {
    defaults: {
      workspace: "~/.openclaw/workspace/twixy",
    },
  },
  gateway: {
    port: 18789,
  },
  sandbox: {
    mode: "non-main",
  },
}
EOF
echo "  openclaw.json written ✓"

# ── Done ─────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Twixy installed successfully!"
echo ""
echo "  Start the gateway:"
echo "    openclaw gateway"
echo ""
echo "  First-time setup:"
echo "    openclaw onboard"
echo ""
echo "  Then open any messaging channel (iMessage, Slack,"
echo "  Telegram, etc.) and say hi to Twixy."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

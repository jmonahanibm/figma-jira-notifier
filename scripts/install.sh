#!/usr/bin/env bash
# =============================================================================
# Design Change Log v2 — One-step installer (macOS / Linux)
# =============================================================================
# Run from the project root:
#   bash scripts/install.sh
# =============================================================================

set -e

REQUIRED_NODE=22
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

print_step() { echo ""; echo "▶  $1"; }
print_ok()   { echo "   ✔  $1"; }
print_info() { echo "   ℹ  $1"; }

echo ""
echo "============================================"
echo "  Design Change Log v2 — Setup"
echo "============================================"

# ── 1. Check / install Node ───────────────────────────────────────────────────
print_step "Checking Node.js version..."

install_node_via_nvm() {
  print_info "Installing nvm..."
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash

  # Source nvm without requiring a new shell
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

  print_info "Installing Node $REQUIRED_NODE via nvm..."
  nvm install "$REQUIRED_NODE"
  nvm use "$REQUIRED_NODE"
  nvm alias default "$REQUIRED_NODE"
}

if command -v node &>/dev/null; then
  NODE_VER=$(node --version | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -ge "$REQUIRED_NODE" ]; then
    print_ok "Node $(node --version) is already installed."
  else
    print_info "Node $(node --version) found — upgrading to $REQUIRED_NODE..."
    install_node_via_nvm
    print_ok "Node $(node --version) installed."
  fi
else
  print_info "Node.js not found — installing..."
  install_node_via_nvm
  print_ok "Node $(node --version) installed."
fi

# ── 2. Install npm dependencies ───────────────────────────────────────────────
print_step "Installing dependencies..."
cd "$PROJECT_DIR"

if [ -d "node_modules" ]; then
  print_ok "node_modules already present — skipping npm install."
else
  npm install --silent
  print_ok "Dependencies installed."
fi

# ── 3. Done ───────────────────────────────────────────────────────────────────
echo ""
echo "============================================"
echo "  All done! Start the tool with:"
echo ""
echo "    npm start"
echo ""
echo "  Then open:  http://localhost:3000"
echo "============================================"
echo ""

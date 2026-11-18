#!/usr/bin/env bash
# MSuite Nexus: Linux Node.js Upgrade & Dependency Setup Script
# Upgrades Node.js to Node 22 LTS on Debian/Ubuntu/RHEL/CentOS systems

set -e

echo "=========================================================="
echo "         MSuite Nexus - Environment Setup                 "
echo "=========================================================="

if command -v node >/dev/null 2>&1; then
  CURRENT_MAJOR=$(node -v | tr -d 'v' | cut -d. -f1)
  echo "[+] Current Node.js version: $(node -v)"
  if [ "$CURRENT_MAJOR" -ge 20 ]; then
    echo "[✓] Node.js version is modern and compatible (>= 20)."
    echo "[+] Running npm install..."
    npm install
    echo "[✓] Dependencies installed successfully."
    exit 0
  fi
  echo "[!] Node.js version is outdated (< 20). Node 20+ is required for Express 5, native fetch, and ES modules."
else
  echo "[!] Node.js not detected."
fi

echo "[+] Installing Node.js 22 LTS via official NodeSource repository..."

if [ -f /etc/debian_version ] || [ -f /etc/lsb-release ]; then
  apt-get update -y
  apt-get install -y curl ca-certificates gnupg
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
elif [ -f /etc/redhat-release ]; then
  curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
  yum install -y nodejs
else
  echo "[!] Unrecognized distribution. Installing via nvm..."
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  nvm install 22
  nvm use 22
  nvm alias default 22
fi

echo "[✓] Upgraded successfully: Node $(node -v) / npm $(npm -v)"
echo "[+] Installing project dependencies..."
npm install
echo "=========================================================="
echo "[✓] MSuite Nexus is ready to run!"
echo "    Start the server: npm start"
echo "=========================================================="

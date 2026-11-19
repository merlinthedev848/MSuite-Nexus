#!/usr/bin/env bash
# ==============================================================================
#  MSuite Nexus - Universal One-Line Automated Installer
#  Compatible with Ubuntu, Debian, CentOS, RHEL, Rocky, AlmaLinux, Fedora
#  Automates:
#    1. Resolves legacy Node conflicts (libnode-dev, libnode72)
#    2. Installs modern Node.js 22 LTS & npm
#    3. Clones/Updates MSuite-Nexus to /opt/msuite-nexus (or current directory)
#    4. Installs all project dependencies
#    5. Generates production environment & secure Admin Token
#    6. Configures, enables, and starts systemd service (auto-start on boot)
# ==============================================================================

set -e

# ANSI Color formatting
BOLD='\033[1m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${CYAN}${BOLD}"
echo "================================================================================"
echo "          __  __ ____        _ _        _   _                     "
echo "         |  \/  / ___| _   _(_) |_ ___ | \ | | _____  ___   _ ___ "
echo "         | |\/| \___ \| | | | | __/ _ \|  \| |/ _ \ \/ / | | / __|"
echo "         | |  | |___) | |_| | | ||  __/| |\  |  __/>  <| |_| \__ \\"
echo "         |_|  |_|____/ \__,_|_|\__\___||_| \_|\___/_/\_\\\__,_|___/"
echo "                                                                                "
echo "               Enterprise Binary Hub, Gateway & Portal Installer                "
echo "================================================================================${NC}"

# Check for root privileges
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    echo -e "${YELLOW}[!] Root privileges required. Escalating with sudo...${NC}"
    exec sudo bash "$0" "$@"
  else
    echo -e "${RED}[✗] Error: This installer must be run as root or with sudo.${NC}"
    exit 1
  fi
fi

# Determine target installation directory
REPO_URL="https://github.com/merlinthedev848/MSuite-Nexus.git"

if [ -f "package.json" ] && grep -q '"name": "msuite-nexus"' package.json 2>/dev/null; then
  INSTALL_DIR="$(pwd)"
  echo -e "${GREEN}[+] Running inside existing MSuite-Nexus directory: ${INSTALL_DIR}${NC}"
elif [ -d "/opt/msuite-nexus" ]; then
  INSTALL_DIR="/opt/msuite-nexus"
  echo -e "${GREEN}[+] Existing installation detected at: ${INSTALL_DIR}${NC}"
else
  INSTALL_DIR="/opt/msuite-nexus"
  echo -e "${GREEN}[+] Setting installation directory to: ${INSTALL_DIR}${NC}"
fi

# Step 1: Package Manager & Environment Preparation
echo -e "${CYAN}[1/6] Preparing system dependencies...${NC}"

if [ -f /etc/debian_version ] || [ -f /etc/lsb-release ]; then
  export DEBIAN_FRONTEND=noninteractive
  # Remove conflicting or duplicate NodeSource apt sources and keyrings first
  rm -f /etc/apt/sources.list.d/nodesource*.list /etc/apt/sources.list.d/nodesource*.sources 2>/dev/null || true
  rm -f /etc/apt/keyrings/nodesource.gpg /usr/share/keyrings/nodesource.gpg 2>/dev/null || true

  # Fix any previously interrupted dpkg / apt transactions
  dpkg --configure -a 2>/dev/null || true
  apt-get -f install -y 2>/dev/null || true
  apt-get update -y
  apt-get install -y curl ca-certificates gnupg git openssl

  # Purge old conflicting Ubuntu/Debian nodejs & dev packages (resolves common.gypi conflict)
  echo -e "${CYAN}[+] Cleaning up legacy/conflicting Node packages...${NC}"
  apt-get remove --purge -y libnode-dev libnode72 nodejs npm 2>/dev/null || true
  apt-get autoremove -y 2>/dev/null || true

  # Add official NodeSource Node.js 22 LTS repository
  echo -e "${CYAN}[+] Adding NodeSource Node.js 22 LTS repository...${NC}"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -o Dpkg::Options::="--force-overwrite" nodejs

elif [ -f /etc/redhat-release ]; then
  yum install -y curl ca-certificates git openssl
  curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
  yum install -y nodejs
else
  # Generic Linux fallback
  if ! command -v node >/dev/null 2>&1 || [ "$(node -v | tr -d 'v' | cut -d. -f1)" -lt 20 ]; then
    echo -e "${YELLOW}[!] Installing Node 22 via NVM fallback...${NC}"
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    nvm install 22
    nvm use 22
    nvm alias default 22
  fi
fi

# Step 2: Validate Node.js version
NODE_VERSION=$(node -v 2>/dev/null || echo "none")
echo -e "${GREEN}[✓] Node.js installed: ${NODE_VERSION}${NC}"

NODE_MAJOR=$(node -v 2>/dev/null | tr -d 'v' | cut -d. -f1 || echo "0")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo -e "${RED}[✗] Error: Node.js 20 or higher is required. Found: ${NODE_VERSION}${NC}"
  exit 1
fi

# Step 3: Fetch / Update Repository
echo -e "${CYAN}[2/6] Setting up MSuite-Nexus source code...${NC}"
if [ -d "$INSTALL_DIR/.git" ]; then
  echo -e "${GREEN}[+] Updating existing repository at ${INSTALL_DIR}...${NC}"
  cd "$INSTALL_DIR"
  git fetch --all --prune
  git checkout main 2>/dev/null || true
  git pull origin main
else
  mkdir -p "$INSTALL_DIR"
  if [ "$INSTALL_DIR" != "$(pwd)" ]; then
    echo -e "${GREEN}[+] Cloning MSuite-Nexus into ${INSTALL_DIR}...${NC}"
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
  fi
fi

# Step 4: Install Dependencies
echo -e "${CYAN}[3/6] Installing npm packages...${NC}"
cd "$INSTALL_DIR"
npm ci 2>/dev/null || npm install

# Step 5: Configure Environment & Tokens
echo -e "${CYAN}[4/6] Initializing production configuration...${NC}"
mkdir -p "$INSTALL_DIR/.cache" "$INSTALL_DIR/data"

if [ ! -f "$INSTALL_DIR/.env" ]; then
  if [ -f "$INSTALL_DIR/.env.example" ]; then
    cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  fi

  # Generate cryptographically secure random tokens
  RANDOM_ADMIN_TOKEN="msuite_adm_$(openssl rand -hex 16 2>/dev/null || head -c 32 /dev/urandom | tr -dc 'a-zA-Z0-9' || echo 'nexus_admin_secure_999')"
  
  if grep -q "ADMIN_TOKEN=" "$INSTALL_DIR/.env" 2>/dev/null; then
    sed -i "s/^ADMIN_TOKEN=.*/ADMIN_TOKEN=${RANDOM_ADMIN_TOKEN}/" "$INSTALL_DIR/.env"
  else
    echo "ADMIN_TOKEN=${RANDOM_ADMIN_TOKEN}" >> "$INSTALL_DIR/.env"
  fi
  echo -e "${GREEN}[✓] Created .env with generated ADMIN_TOKEN${NC}"
else
  echo -e "${GREEN}[✓] Preserved existing .env configuration${NC}"
fi

# Read configured ADMIN_TOKEN and PORT
ADMIN_TOKEN=$(grep -E "^ADMIN_TOKEN=" "$INSTALL_DIR/.env" 2>/dev/null | cut -d= -f2- | tr -d ' "' || echo "msuite_secret_admin_token")
PORT=$(grep -E "^PORT=" "$INSTALL_DIR/.env" 2>/dev/null | cut -d= -f2- | tr -d ' "' || echo "8080")
[ -z "$PORT" ] && PORT=8080

# Step 6: Setup Systemd Service
echo -e "${CYAN}[5/6] Configuring systemd background service...${NC}"
NODE_PATH=$(command -v node)

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  cat <<EOF > /etc/systemd/system/msuite-nexus.service
[Unit]
Description=MSuite Nexus - GitHub Private Proxy & Enterprise Gateway
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}
ExecStart=${NODE_PATH} src/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=-${INSTALL_DIR}/.env

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable msuite-nexus.service >/dev/null 2>&1
  systemctl restart msuite-nexus.service

  echo -e "${GREEN}[✓] Systemd service 'msuite-nexus' created and started!${NC}"
  SERVICE_STATUS="Running as systemd daemon (msuite-nexus.service)"
else
  echo -e "${YELLOW}[!] systemd not active (container or WSL environment).${NC}"
  SERVICE_STATUS="Run manually via: cd ${INSTALL_DIR} && npm start"
fi

# Detect Server IP Address
IP_ADDR=$(hostname -I 2>/dev/null | awk '{print $1}' || curl -s https://api.ipify.org 2>/dev/null || echo "127.0.0.1")
[ -z "$IP_ADDR" ] && IP_ADDR="127.0.0.1"

# Final Success Banner
echo ""
echo -e "${GREEN}${BOLD}================================================================================"
echo -e "              🚀 MSuite Nexus Installed & Ready to Use!                         "
echo -e "================================================================================${NC}"
echo -e "  ${BOLD}Status:${NC}        ${SERVICE_STATUS}"
echo -e "  ${BOLD}Install Dir:${NC}   ${INSTALL_DIR}"
echo -e "  ${BOLD}Web Portal:${NC}    ${CYAN}http://${IP_ADDR}:${PORT}/${NC}"
echo -e "  ${BOLD}Setup Wizard:${NC}  ${CYAN}http://${IP_ADDR}:${PORT}/setup${NC}"
echo -e "  ${BOLD}Admin Token:${NC}   ${YELLOW}${ADMIN_TOKEN}${NC}"
echo ""
echo -e "  ${BOLD}Service Controls:${NC}"
echo -e "    • Status:   ${CYAN}systemctl status msuite-nexus${NC}"
echo -e "    • Logs:     ${CYAN}journalctl -u msuite-nexus -f${NC}"
echo -e "    • Restart:  ${CYAN}systemctl restart msuite-nexus${NC}"
echo -e "================================================================================"
echo -e "${BOLD}Next Step:${NC} Open ${CYAN}http://${IP_ADDR}:${PORT}/setup${NC} in your browser to complete onboarding!"
echo ""

#!/bin/bash
set -euo pipefail

# Babysit installer — cross-platform (macOS + Linux)
# Usage: curl -fsSL https://raw.githubusercontent.com/actuallymentor/babysit/main/scripts/install.sh | bash

REPO="actuallymentor/babysit"
INSTALL_DIR="/usr/local/bin"

echo "Installing babysit..."
echo ""

# Detect OS and architecture
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS" in
    darwin) OS="darwin" ;;
    linux)  OS="linux" ;;
    *)
        echo "Error: Unsupported OS: $OS"
        exit 1
        ;;
esac

case "$ARCH" in
    x86_64|amd64) ARCH="x64" ;;
    arm64|aarch64) ARCH="arm64" ;;
    *)
        echo "Error: Unsupported architecture: $ARCH"
        exit 1
        ;;
esac

BINARY="babysit-${OS}-${ARCH}"
echo "Platform: ${OS}/${ARCH}"

# Check dependencies
check_dep() {
    if ! command -v "$1" > /dev/null 2>&1; then
        echo ""
        echo "Missing dependency: $1"
        echo "  $2"
        return 1
    fi
    echo "  ✓ $1"
    return 0
}

echo ""
echo "Checking dependencies..."
DEPS_OK=true
check_dep docker "Install: https://docs.docker.com/get-docker/" || DEPS_OK=false
check_dep tmux "Install: brew install tmux (macOS) or sudo apt install tmux (Linux)" || DEPS_OK=false
check_dep git "Install: brew install git (macOS) or sudo apt install git (Linux)" || DEPS_OK=false

if [ "$DEPS_OK" = false ]; then
    echo ""
    echo "Some dependencies are missing. Install them and re-run this script."
    echo "Continuing with babysit installation anyway..."
    echo ""
fi

# Fetch latest release
echo ""
echo "Fetching latest release..."

LATEST_URL="https://api.github.com/repos/${REPO}/releases/latest"
DOWNLOAD_URL=$(curl -fsSL "$LATEST_URL" | grep "browser_download_url.*${BINARY}" | head -1 | cut -d '"' -f 4)

if [ -z "$DOWNLOAD_URL" ]; then
    echo "Error: Could not find binary for ${BINARY}"
    echo "Available at: https://github.com/${REPO}/releases/latest"
    exit 1
fi

# Download and install
echo "Downloading ${BINARY}..."
TMPFILE=$(mktemp)
curl -fsSL "$DOWNLOAD_URL" -o "$TMPFILE"
chmod +x "$TMPFILE"

# Move to install directory (may need sudo)
if [ -w "$INSTALL_DIR" ]; then
    mv "$TMPFILE" "${INSTALL_DIR}/babysit"
else
    echo "Installing to ${INSTALL_DIR} (requires sudo)..."
    sudo mv "$TMPFILE" "${INSTALL_DIR}/babysit"
fi

echo ""
echo "✓ babysit installed to ${INSTALL_DIR}/babysit"
echo ""
echo "Get started:"
echo "  babysit claude --yolo"
echo "  babysit --help"

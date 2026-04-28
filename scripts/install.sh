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

# Pick a package-manager hint for the current OS so missing deps can be auto-installed
detect_package_manager() {
    if [ "$OS" = "darwin" ]; then
        if command -v brew > /dev/null 2>&1; then
            echo "brew"
            return
        fi
    elif [ "$OS" = "linux" ]; then
        if command -v apt-get > /dev/null 2>&1; then
            echo "apt-get"
            return
        elif command -v dnf > /dev/null 2>&1; then
            echo "dnf"
            return
        elif command -v pacman > /dev/null 2>&1; then
            echo "pacman"
            return
        fi
    fi
    echo ""
}

PKG_MGR="$(detect_package_manager)"

# Map a dep name to the install command for the current package manager
install_dep() {
    local dep="$1"
    case "$PKG_MGR" in
        brew)
            brew install "$dep"
            ;;
        apt-get)
            sudo apt-get update -qq && sudo apt-get install -y "$dep"
            ;;
        dnf)
            sudo dnf install -y "$dep"
            ;;
        pacman)
            sudo pacman -S --noconfirm "$dep"
            ;;
        *)
            echo "  No supported package manager found — install $dep manually."
            return 1
            ;;
    esac
}

# Verify a dependency, offer to install via the detected package manager
check_dep() {
    local cmd="$1"
    local install_hint="$2"
    local pkg="${3:-$1}"

    if command -v "$cmd" > /dev/null 2>&1; then
        echo "  ✓ $cmd"
        return 0
    fi

    echo ""
    echo "Missing dependency: $cmd"
    echo "  $install_hint"

    # Docker can't be installed via apt — point the user at the official installer
    if [ "$cmd" = "docker" ]; then
        return 1
    fi

    if [ -n "$PKG_MGR" ]; then
        # Skip the prompt when stdin is a pipe (curl | bash) — auto-install instead.
        if [ -t 0 ]; then
            read -r -p "Install $cmd with $PKG_MGR? [Y/n] " ANSWER
            ANSWER="${ANSWER:-Y}"
        else
            ANSWER="Y"
        fi
        case "$ANSWER" in
            [Yy]*)
                install_dep "$pkg" && return 0
                ;;
        esac
    fi
    return 1
}

echo ""
echo "Checking dependencies..."
DEPS_OK=true
check_dep docker "Install: https://docs.docker.com/get-docker/" || DEPS_OK=false
check_dep tmux   "Install via your package manager" tmux || DEPS_OK=false
check_dep git    "Install via your package manager" git  || DEPS_OK=false

if [ "$DEPS_OK" = false ]; then
    echo ""
    echo "Some dependencies are still missing. Install them and re-run this script."
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

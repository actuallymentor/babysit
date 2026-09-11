#!/bin/bash
set -euo pipefail

# Install the native CLI without editing shell profiles. The published manifest
# supplies both architecture-specific download and checksum.
case "$(uname -m)" in
    x86_64) platform=linux_amd64 ;;
    aarch64|arm64) platform=linux_arm64 ;;
    *) printf 'Unsupported Antigravity architecture: %s\n' "$(uname -m)" >&2; exit 1 ;;
esac

temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
curl -fsSL --retry 3 "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/$platform.json" -o "$temporary/manifest.json"
url=$(jq -er '.url | select(startswith("https://storage.googleapis.com/antigravity-public/"))' "$temporary/manifest.json")
checksum=$(jq -er '.sha512 | select(test("^[a-fA-F0-9]{128}$"))' "$temporary/manifest.json")
curl -fsSL --retry 3 "$url" -o "$temporary/cli.tar.gz"
printf '%s  %s\n' "$checksum" "$temporary/cli.tar.gz" | sha512sum --check --status
tar -xzOf "$temporary/cli.tar.gz" antigravity > "$temporary/agy"
install -D -m 0755 "$temporary/agy" "$HOME/.local/bin/agy"
"$HOME/.local/bin/agy" --version

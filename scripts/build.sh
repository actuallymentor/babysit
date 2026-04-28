#!/bin/bash
set -euo pipefail

# Build babysit into static binaries for all platforms
# Requires: bun

VERSION=$(node -e "console.log(require('./package.json').version)")
echo "Building babysit v${VERSION}"

mkdir -p dist

TARGETS=(
    "bun-linux-x64"
    "bun-linux-arm64"
    "bun-darwin-x64"
    "bun-darwin-arm64"
)

for target in "${TARGETS[@]}"; do
    # Extract os-arch from bun-os-arch
    os_arch="${target#bun-}"
    outfile="dist/babysit-${os_arch}"

    echo "  Building ${outfile}..."
    bun build --compile --target="${target}" --minify ./src/index.js --outfile "${outfile}"
done

echo ""
echo "Build complete. Binaries in dist/"
ls -lh dist/

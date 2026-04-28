#!/bin/bash
set -e

# Mark /workspace as safe for git
git config --global --add safe.directory /workspace 2>/dev/null || true

# Fix ownership on isolated node_modules if present
if [ "${BABYSIT_NM_ISOLATED:-0}" = "1" ] && [ -d /workspace/node_modules ]; then
    sudo chown -R node:node /workspace/node_modules 2>/dev/null || true
fi

# Fix ownership on isolated .venv if present
if [ "${BABYSIT_VENV_ISOLATED:-0}" = "1" ] && [ -d /workspace/.venv ]; then
    sudo chown -R node:node /workspace/.venv 2>/dev/null || true
fi

# Execute the coding agent command passed as arguments
exec "$@"

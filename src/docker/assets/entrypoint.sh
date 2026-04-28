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

# For agents that read the system prompt from a file (codex/gemini/opencode),
# write it to the path the agent expects. Targets are container-local
# (~/.codex, ~/.gemini, ~/.config/opencode) so this works in every mode —
# overwrite rather than append since a fresh container starts each session.
if [ -n "${BABYSIT_SYSTEM_PROMPT:-}" ] && [ -n "${BABYSIT_SYSTEM_PROMPT_FILE:-}" ]; then
    _target="$BABYSIT_SYSTEM_PROMPT_FILE"
    _dir="$(dirname "$_target")"

    mkdir -p "$_dir" 2>/dev/null || sudo mkdir -p "$_dir" 2>/dev/null || true
    printf '%s\n' "$BABYSIT_SYSTEM_PROMPT" > "$_target" 2>/dev/null || true
fi

# Execute the coding agent command passed as arguments
exec "$@"

#!/bin/bash
# Babysit statusline — displayed in Claude Code's status bar
# Shows: modifiers · repo · branch · loop countdown

set -euo pipefail

# Colors
CYAN='\033[36m'
MAGENTA='\033[35m'
GREEN='\033[32m'
YELLOW='\033[33m'
RESET='\033[0m'

# Modifiers from environment
_modifiers="${BABYSIT_MODIFIERS:-babysit}"

# Choose color: cyan for default, magenta for custom modifiers
if [ "$_modifiers" = "babysit" ]; then
    _mod_color="$CYAN"
else
    _mod_color="$MAGENTA"
fi

# Repo name from git remote
_repo=""
if command -v git > /dev/null 2>&1 && git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    _remote=$(git remote get-url origin 2>/dev/null || true)
    if [ -n "$_remote" ]; then
        # Extract owner/repo from SSH or HTTPS URL
        _repo=$(echo "$_remote" | sed -E 's#.*[:/]([^/]+/[^/.]+)(\.git)?$#\1#')
    fi
fi

# Branch name
_branch=""
if command -v git > /dev/null 2>&1 && git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    _branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "detached")
fi

# Loop countdown
_loop_info=""
_deadline_file="/tmp/babysit-loop-deadline"
if [ -f "$_deadline_file" ]; then
    _deadline=$(cat "$_deadline_file" 2>/dev/null || true)
    if [ "$_deadline" = "idle" ]; then
        _loop_info="idle"
    elif [ -n "$_deadline" ]; then
        _now=$(date +%s)
        _remaining=$(awk "BEGIN { r = $_deadline - $_now; if (r < 0) r = 0; printf \"%d\", r }")
        _lh=$(( _remaining / 3600 ))
        _lm=$(( (_remaining % 3600) / 60 ))
        _ls=$(( _remaining % 60 ))
        _loop_info=$(printf '%02d:%02d:%02d' $_lh $_lm $_ls)
    fi
    # Inject countdown into modifiers display
    if echo "$_modifiers" | grep -q "loop"; then
        _modifiers=$(echo "$_modifiers" | sed "s/loop/loop $_loop_info/")
    fi
fi

# Build output
_output="${_mod_color}${_modifiers}${RESET}"

if [ -n "$_repo" ]; then
    _output="${_output} ${GREEN}${_repo}${RESET}"
fi

if [ -n "$_branch" ]; then
    _output="${_output} ${YELLOW}⎇ ${_branch}${RESET}"
fi

echo -e "$_output"

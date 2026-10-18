#!/bin/bash
# Installed ahead of the real claude on PATH.
#
# Claude removes its auth variables (CLAUDE_CODE_OAUTH_TOKEN and friends) from
# every child process, so a nested `claude -p` run by an agent would fall back to
# the host /login instead of the subscription Babysit chose for this session.
# This reloads the token the way the agent's own launch does (entrypoint run_agent):
# the rc token, then the chosen account, which wins. Always exec, so the agent
# keeps its pid when this is the launch itself.
rc="${BABYSIT_CLAUDE_RC:-/home/node/.babysitrc}"
account_env="${BABYSIT_CLAUDE_ACCOUNT_ENV:-/home/node/.babysit-claude-account.env}"

# The rc is shell, so read only the one variable from a subshell, never its other effects
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -f "$rc" ]; then
    rc_token="$(set -a; source "$rc" > /dev/null 2>&1; printf '%s' "${CLAUDE_CODE_OAUTH_TOKEN:-}")"
    [ -n "$rc_token" ] && export CLAUDE_CODE_OAUTH_TOKEN="$rc_token"
fi

# Literal KEY=value lines, never evaluated as shell
if [ -f "$account_env" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        [ -n "$line" ] && export "${line?}"
    done < "$account_env"
fi

# The real claude is the next one on PATH after this file. Builtins only, so a
# bare PATH cannot make the shim mistake itself for the real thing.
self="$(cd "${BASH_SOURCE[0]%/*}" && pwd -P)/${BASH_SOURCE[0]##*/}"
IFS=: read -ra path_dirs <<< "$PATH"
for dir in "${path_dirs[@]}"; do
    candidate="$dir/claude"
    [ -x "$candidate" ] || continue
    [ "$(cd "${candidate%/*}" && pwd -P)/claude" = "$self" ] && continue
    exec "$candidate" "$@"
done

echo "claude: not found on PATH" >&2
exit 127

#!/bin/bash
# Installed as /usr/local/bin/babysit-claude-token.
#
# Hot-swappable Claude account. Claude re-reads its credentials file before
# every request, but CLAUDE_CODE_OAUTH_TOKEN is fixed for the life of the
# process and outranks the file. So a session that may change accounts keeps
# its setup-token in the file, and Babysit rewrites it to switch subscriptions
# mid-session (docker exec -i -u node <container> babysit-claude-token).
#
# stdin: literal KEY=value lines, the same shape as the account env file.
# Writes both the account env file (container restarts, nested claude) and
# Claude's credentials file. Each write is atomic. The token never reaches argv.
set -euo pipefail

account_env="${BABYSIT_CLAUDE_ACCOUNT_ENV:-/home/node/.babysit-claude-account.env}"
config_dir="${CLAUDE_CONFIG_DIR:-/home/node/.claude}"

# Read everything first: stdin may be the account env file this script replaces
lines="$(cat)"
token="$(printf '%s\n' "$lines" | sed -n 's/^CLAUDE_CODE_OAUTH_TOKEN=//p' | tail -n 1)"

# Setup-tokens are sk-ant-oat<n>-<url-safe chars>, so they embed in JSON as is
if ! [[ "$token" =~ ^sk-ant-oat[0-9]+-[A-Za-z0-9_-]+$ ]]; then
    echo "babysit-claude-token: no valid CLAUDE_CODE_OAUTH_TOKEN on stdin" >&2
    exit 64
fi

# Write next to the target with 0600, then rename over it
write_private() {
    local target="$1" temporary
    temporary="$(mktemp "${target}.XXXXXX")"
    chmod 600 "$temporary"
    cat > "$temporary"
    mv -f "$temporary" "$target"
}

mkdir -p "$config_dir"
printf '%s\n' "$lines" | write_private "$account_env"

# No refresh token: setup-tokens never rotate. The expiry only has to sit far
# enough out that Claude never tries to refresh; the server enforces the real one.
expires_at=$(( ( $(date +%s) + 365 * 24 * 3600 ) * 1000 ))
printf '{"claudeAiOauth":{"accessToken":"%s","refreshToken":null,"expiresAt":%s,"scopes":["user:inference"],"subscriptionType":null}}\n' \
    "$token" "$expires_at" | write_private "$config_dir/.credentials.json"

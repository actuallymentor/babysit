#!/bin/bash
set -e

# UID remap — make the in-container `node` user match the host user that owns
# the bind-mounted /workspace, so files written by the agent inherit the host
# uid and the host can edit/commit them without git's "dubious ownership" or
# refs/lock permission errors. The image is shared with `node` baked in at
# uid 1000; we adjust it on each container start when the host uid differs.
WORKSPACE_UID=$(stat -c '%u' /workspace 2>/dev/null || echo "")
WORKSPACE_GID=$(stat -c '%g' /workspace 2>/dev/null || echo "")
HOST_UID="${WORKSPACE_UID:-1000}"
HOST_GID="${WORKSPACE_GID:-1000}"
# Sandbox / mudbox-without-host bind: /workspace was prepped in the Dockerfile
# as node:node (uid 1000), so an apparent uid 0 just means "no host user to
# match" — leave node alone.
[ "$HOST_UID" = "0" ] && HOST_UID=1000
[ "$HOST_GID" = "0" ] && HOST_GID=1000

CURRENT_UID=$(id -u node)
CURRENT_GID=$(id -g node)

if [ "$HOST_UID" != "$CURRENT_UID" ] || [ "$HOST_GID" != "$CURRENT_GID" ]; then
    groupmod -o -g "$HOST_GID" node
    usermod  -o -u "$HOST_UID" -g "$HOST_GID" node

    # Reclaim image-baked + named-volume paths under /home/node. The
    # `! -uid` filter naturally skips bind-mounted files (those already
    # carry the host uid). Explicitly prune the recursive ~/.agents bind
    # so a stray uid mismatch there can't leak a chown back to the host.
    find /home/node \
        -path /home/node/.agents -prune -o \
        \( ! -uid "$HOST_UID" -o ! -gid "$HOST_GID" \) -print0 2>/dev/null \
        | xargs -0 -r chown -h "$HOST_UID:$HOST_GID" 2>/dev/null || true
fi

# Mark /workspace as safe for git — write to node's ~/.gitconfig, not root's.
gosu node git config --global --add safe.directory /workspace 2>/dev/null || true

# Fix ownership on isolated node_modules if present
if [ "${BABYSIT_NM_ISOLATED:-0}" = "1" ] && [ -d /workspace/node_modules ]; then
    chown -R "$HOST_UID:$HOST_GID" /workspace/node_modules 2>/dev/null || true
fi

# Fix ownership on isolated .venv if present
if [ "${BABYSIT_VENV_ISOLATED:-0}" = "1" ] && [ -d /workspace/.venv ]; then
    chown -R "$HOST_UID:$HOST_GID" /workspace/.venv 2>/dev/null || true
fi

# Bring claude into the cross-agent skills convention. Codex and OpenCode
# already discover ~/.agents/skills/ natively; claude only looks at
# ~/.claude/skills/, so symlink the cross-agent path into place when the
# user has populated it. Skipped if the target already exists (e.g. a
# claude-specific skills dir was bind-mounted in by setup.js).
if [ -d /home/node/.agents/skills ] && [ ! -e /home/node/.claude/skills ]; then
    gosu node ln -s /home/node/.agents/skills /home/node/.claude/skills 2>/dev/null || true
fi

# Drop privileges back to node (now uid=$HOST_UID) and exec the agent.
exec gosu node "$@"

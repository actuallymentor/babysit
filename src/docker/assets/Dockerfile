# Babysit container image — sandboxed environment for LLM coding agents
# Base: Node.js 24 LTS on Debian slim
ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-slim

# System dependencies — matches the sir-claudius image (per spec) plus extras
# for multi-agent support. Tools added on top of sir-claudius are bun-style
# build chain bits + extra editors; everything else mirrors sir-claudius so
# agents transitioning between the two see the same toolset.
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Build tools
    gcc g++ make build-essential \
    # Version control
    git git-lfs \
    # Languages
    python3 python3-venv \
    # CLI essentials. `gosu` is used by the entrypoint to drop privileges
    # back to `node` after a uid remap (see entrypoint.sh).
    sudo gosu curl wget jq tmux openssh-client \
    openssl gnupg ca-certificates \
    rsync tar zip unzip gzip xz-utils zstd patch \
    # Codex sandboxing — codex prefers a system bubblewrap on PATH and falls
    # back to a vendored copy with a startup warning if missing
    bubblewrap \
    # Debugging
    htop strace lsof procps \
    # Network
    netcat-openbsd dnsutils iproute2 iputils-ping \
    # Editors / pagers
    vim nano less \
    # Agent-friendly extras (sir-claudius parity)
    shellcheck sqlite3 tree \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI — agents working in repos need `gh` for PR/issue/auth flows.
# Installed via the official packages repo so we get arch-correct builds.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Modern CLI tools via binary download (run as root)
RUN set -eux; \
    ARCH="$(dpkg --print-architecture)"; \
    # ripgrep
    RG_VERSION="14.1.1"; \
    curl -fsSL "https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep_${RG_VERSION}-1_${ARCH}.deb" -o /tmp/rg.deb \
    && dpkg -i /tmp/rg.deb && rm /tmp/rg.deb; \
    # fd-find
    FD_VERSION="10.2.0"; \
    curl -fsSL "https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/fd_${FD_VERSION}_${ARCH}.deb" -o /tmp/fd.deb \
    && dpkg -i /tmp/fd.deb && rm /tmp/fd.deb; \
    # bat
    BAT_VERSION="0.24.0"; \
    curl -fsSL "https://github.com/sharkdp/bat/releases/download/v${BAT_VERSION}/bat_${BAT_VERSION}_${ARCH}.deb" -o /tmp/bat.deb \
    && dpkg -i /tmp/bat.deb && rm /tmp/bat.deb; \
    # fzf
    FZF_VERSION="0.57.0"; \
    if [ "$ARCH" = "amd64" ]; then FZF_ARCH="amd64"; else FZF_ARCH="arm64"; fi; \
    curl -fsSL "https://github.com/junegunn/fzf/releases/download/v${FZF_VERSION}/fzf-${FZF_VERSION}-linux_${FZF_ARCH}.tar.gz" \
    | tar xz -C /usr/local/bin; \
    # yq
    YQ_VERSION="4.44.6"; \
    if [ "$ARCH" = "amd64" ]; then YQ_ARCH="amd64"; else YQ_ARCH="arm64"; fi; \
    curl -fsSL "https://github.com/mikefarah/yq/releases/download/v${YQ_VERSION}/yq_linux_${YQ_ARCH}" -o /usr/local/bin/yq \
    && chmod +x /usr/local/bin/yq; \
    # scc — fast LOC counter (sir-claudius parity, frequently used by agents to size codebases)
    if [ "$ARCH" = "amd64" ]; then SCC_ARCH="x86_64"; else SCC_ARCH="arm64"; fi; \
    curl -fsSL "https://github.com/boyter/scc/releases/latest/download/scc_Linux_${SCC_ARCH}.tar.gz" \
    | tar xz -C /usr/local/bin scc

# Python uv (fast pip replacement) — install system-wide
RUN curl -fsSL https://astral.sh/uv/install.sh | sh \
    && mv /root/.local/bin/uv /usr/local/bin/uv \
    && mv /root/.local/bin/uvx /usr/local/bin/uvx 2>/dev/null || true

# Non-root user with passwordless sudo and required directories.
# Pre-create every dir we plan to bind-mount into so docker's auto-mkdir
# doesn't leave them root-owned (which would block credential refreshes
# and prompt-file writes done by the `node` user).
RUN mkdir -p \
        /home/node/.npm-global \
        /home/node/.claude/projects \
        /home/node/.claude/plans \
        /home/node/.claude/todos \
        /home/node/.codex \
        /home/node/.gemini \
        /home/node/.config/opencode \
        /home/node/.local/share/opencode \
        /home/node/.agents \
        /workspace \
    && chown -R node:node /home/node /workspace \
    && echo "node ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/node \
    && chmod 0440 /etc/sudoers.d/node

# Copy in-container scripts (still as root). Reference docs about the
# container environment (sudo, /workspace, tools) used to live in
# /home/node/AGENTS.md, but that's now communicated to agents directly via
# babysit's system-prompt fragment + per-CLI first-message — nothing in the
# image needs to point to a baked file anymore.
COPY statusline.sh /usr/local/bin/statusline.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/statusline.sh

# Codex (OpenAI) — install globally via npm as root
RUN npm install -g @openai/codex 2>/dev/null || true

# Gemini CLI — install globally via npm as root
RUN npm install -g @google/gemini-cli 2>/dev/null || true

# Switch to non-root user for user-scoped agent installs
USER node
ENV NPM_CONFIG_PREFIX=/home/node/.npm-global
# Claude's `install.sh` symlinks to ~/.local/bin/claude and OpenCode's `install`
# script likewise drops a binary in ~/.local/bin (or ~/.opencode/bin). All three
# need to be on PATH or the agent commands resolve to "command not found" at runtime.
ENV PATH="/home/node/.npm-global/bin:/home/node/.local/bin:/home/node/.opencode/bin:$PATH"

# Claude Code — installs into /home/node
RUN curl -fsSL https://claude.ai/install.sh | bash || true
ENV DISABLE_AUTOUPDATER=1

# OpenCode — installs into /home/node
RUN curl -fsSL https://opencode.ai/install 2>/dev/null | bash || true

# Git identity defaults (overridden by env passthrough from host)
ENV GIT_AUTHOR_NAME="Babysitter"
ENV GIT_COMMITTER_NAME="Babysitter"
ENV GIT_AUTHOR_EMAIL="babysit@github.com"
ENV GIT_COMMITTER_EMAIL="babysit@github.com"

# Switch back to root so the entrypoint can remap `node` to the host user's
# uid/gid before dropping privileges via gosu. The image is shared (uid 1000
# baked in); the actual runtime uid is set per-container in entrypoint.sh.
USER root

WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

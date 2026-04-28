# Babysit container image — sandboxed environment for LLM coding agents
# Base: Node.js 24 LTS on Debian slim
ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-slim

# System dependencies — matches sir-claudius + extras for multi-agent support
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Build tools
    gcc g++ make build-essential \
    # Version control
    git git-lfs \
    # Languages
    python3 python3-venv \
    # CLI essentials
    sudo curl wget jq tmux openssh-client \
    openssl gnupg ca-certificates \
    rsync tar zip gzip xz-utils zstd patch \
    # Debugging
    htop strace lsof procps \
    # Network
    netcat-openbsd dnsutils iproute2 iputils-ping \
    # Editors
    vim nano \
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
    && chmod +x /usr/local/bin/yq

# Python uv (fast pip replacement) — install system-wide
RUN curl -fsSL https://astral.sh/uv/install.sh | sh \
    && mv /root/.local/bin/uv /usr/local/bin/uv \
    && mv /root/.local/bin/uvx /usr/local/bin/uvx 2>/dev/null || true

# Non-root user with passwordless sudo and required directories
RUN mkdir -p \
        /home/node/.npm-global \
        /home/node/.claude/projects \
        /home/node/.claude/plans \
        /home/node/.claude/todos \
        /home/node/.agents \
        /workspace \
    && chown -R node:node /home/node /workspace \
    && echo "node ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/node \
    && chmod 0440 /etc/sudoers.d/node

# Copy in-container reference docs and scripts (still as root)
COPY AGENTS.md /home/node/AGENTS.md
COPY statusline.sh /usr/local/bin/statusline.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/statusline.sh \
    && chown node:node /home/node/AGENTS.md

# Codex (OpenAI) — install globally via npm as root
RUN npm install -g @openai/codex 2>/dev/null || true

# Gemini CLI — install globally via npm as root
RUN npm install -g @google/gemini-cli 2>/dev/null || true

# Switch to non-root user for user-scoped agent installs
USER node
ENV NPM_CONFIG_PREFIX=/home/node/.npm-global
ENV PATH="/home/node/.npm-global/bin:$PATH"

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

WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

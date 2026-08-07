# Operational Research

Agent model defaults and container tool pins last verified against primary sources: 2026-08-07.

## Container toolchain
- Current pinned releases: fd 10.4.2, bat 0.26.1, fzf 0.74.1, yq 4.53.3, scc 3.7.0, just 1.58.0, Bun 1.3.14, and nvm 0.40.6.
- Both amd64 and arm64 artifact URLs were checked before updating the Dockerfile. Pin scc to a versioned release URL rather than the floating `latest/download` path so builds remain reproducible.
- The release workflow uses actions/cache v6 and the same Bun 1.3.14 version as the image build.

## Docker-outside-of-Docker
- Verified against Docker docs on 2026-05-05.
- Normal containers are unprivileged and cannot run a Docker daemon inside the container without `--privileged`; `--privileged` gives broad host-equivalent device/capability access, so Babysit should prefer Docker-outside-of-Docker over true Docker-in-Docker.
- Bind mount sources are resolved on the Docker daemon host, not the client container. Nested Babysit sessions therefore need the original host workspace path (`BABYSIT_HOST_WORKSPACE`) when building `docker run -v ...:/workspace`.
- Docker's Debian install docs support installing the client-side packages `docker-ce-cli`, `docker-buildx-plugin`, and `docker-compose-plugin` from the official Docker apt repository. Babysit's image installs those CLI/plugin packages only, not `docker-ce` or `containerd.io`.

## Watchtower compatibility
- Verified against upstream repositories, image registries, and container-selection docs on 2026-08-06.
- The maintained containrrr lineage preserves `com.centurylinklabs.watchtower.enable=false`: containrrr, Nicholas Fedor, Beatkind, OpenSerbia, Storj, Marrrrrrrrry, Torus Research, and their confirmed registry aliases (including Beatkind and Marrrrrrrrry on GHCR). Webhippie/Dockhippie and Jauder Ho rebuild compatible upstream releases. Whefter's deprecated fork is safe through mandatory explicit target tags rather than the standard false label.
- Repository names are the trust boundary. Strip tags/digests and normalize Docker Hub aliases, but do not trust a private mirror or unrelated owner merely because the final path is `watchtower`.
- `centurylink/watchtower` and Docker Hub's `v2tec/watchtower:latest` are unsafe assumptions: their legacy builds may watch an unlabeled or false-labeled container by default. Unknown, renamed, and legacy Watchtower-like containers should produce a conspicuous warning rather than block startup silently.

## GitHub CLI
- Verified against the official GitHub CLI manual on 2026-06-08.
- `GH_CONFIG_DIR` controls where gh reads/writes config. Without it, gh uses `$XDG_CONFIG_HOME/gh`, then platform-specific defaults, then `$HOME/.config/gh` on Unix-like systems.
- `gh auth login` can store tokens in a system credential store; only fallback/insecure storage writes the token directly into the config files. Use host `gh auth token` to materialise the active token for containers.
- Headless container auth should use `GH_TOKEN` / `GITHUB_TOKEN` for github.com and `GH_ENTERPRISE_TOKEN` / `GITHUB_ENTERPRISE_TOKEN` for GitHub Enterprise Server. If `GH_HOST` is set, pass it through alongside the matching token.

## Claude Code
- **Binary**: `claude`
- **Skip perms**: `--dangerously-skip-permissions`
- **System prompt**: Claude supports `--append-system-prompt "text"` and `--system-prompt "text"`, but Babysit deliberately uses neither for its launch brief. It types `config.initial_prompt` into the ready TUI and mounts shared user globals at Claude's native instruction path.
- **Resume**: `claude --resume <id>` or `claude -r <id>`
- **Model**: `--model best` tracks Claude Code's highest-capability generally available model and currently resolves equivalently to Opus.
- **Effort**: `--effort xhigh` is Babysit's quality-first default. Claude Code recommends it for most coding work; `max` remains opt-in because it can overthink and use substantially more tokens.
- **Creds**: `~/.claude/.credentials.json` (linux), Keychain service "Claude Code-credentials" (macOS)
- **Install location**: `~/.local/bin/claude` (binary lives under `~/.local/share/claude/versions/` with a symlink in `~/.local/bin`). Container Dockerfile must add `~/.local/bin` to PATH.
- **Home env**: `CLAUDE_CONFIG_DIR` — default `~/.claude`. Documented behavior is partial: claude still creates local `.claude/` directories in workspaces and `/ide` integration may misbehave when set. Babysit pins it to `/home/node/.claude` inside the container so it matches the credential, settings, and projects mounts.

## Codex
- **Binary**: `codex`
- **Skip perms**: `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`). `--full-auto` only skips approvals — it leaves codex's `workspace-write` sandbox active, which blocks real edits inside our docker container.
- **System prompt**: no CLI flag — Codex reads `AGENTS.override.md` then `AGENTS.md` from `${CODEX_HOME}` (default `~/.codex`). The legacy `instructions.md` filename is silently ignored. Babysit pins `CODEX_HOME=/home/node/.codex`, makes shared user globals available at `AGENTS.md`, and types the separate `config.initial_prompt` launch brief into the ready TUI.
- **Resume**: `codex resume <id>` for interactive (what we use), `codex exec resume <id>` for non-interactive
- **Model**: `--model gpt-5.6-sol` (verified 2026-08-01 against OpenAI's live latest-model resolver and model guide as the frontier GPT-5.6 model for complex reasoning and coding; the `gpt-5.6` alias currently routes to it)
- **Effort**: `-c model_reasoning_effort="xhigh"` is Babysit's preferred quality-first default (NOT bare `reasoning_effort` — that key is silently ignored). GPT-5.6 supports `none`, `low`, `medium`, `high`, `xhigh`, and `max`; Babysit intentionally leaves `max` opt-in.
- **Creds**: `${CODEX_HOME}/auth.json` for ChatGPT-OAuth login (default flow, `~/.codex/auth.json` only when `CODEX_HOME` is unset). `CODEX_API_KEY` / `OPENAI_API_KEY` env var as fallback for API-key auth. babysit forwards both — file first, env additively on top so users can override.
- **Home env**: `CODEX_HOME` — default `~/.codex`, controls where global AGENTS.md / config / sessions / auth.json live

## Gemini CLI
- **Binary**: `gemini`
- **Skip perms**: `--approval-mode=yolo`; the older `--yolo` alias is deprecated.
- **System prompt**: context file `GEMINI.md`. Babysit mounts shared user globals at `${GEMINI_CLI_HOME}/.gemini/GEMINI.md` and types the separate `config.initial_prompt` launch brief into the TUI. Gemini also honors `GEMINI_SYSTEM_MD` as a full override, which Babysit intentionally does not use.
- **Resume**: `gemini --resume latest` or `--resume <uuid>` or `--resume <session_index>`
- **Model**: no forced default. Gemini's agent router selects a model supported by the configured enterprise or API-key account.
- **Effort**: no equivalent
- **Creds**: `~/.gemini/oauth_creds.json` for the Google-OAuth login flow. `GEMINI_API_KEY` env var as fallback for API-key auth. babysit forwards both — file first, env additively.
- **Home env**: `GEMINI_CLI_HOME` — default `$HOME`. Gemini creates a `.gemini/` folder *inside* this dir, so set it to the parent (we use `/home/node`). Not to be confused with `GEMINI_CLI_SYSTEM_DEFAULTS_PATH` / `GEMINI_CLI_SYSTEM_SETTINGS_PATH`, which point at single files.
- **Account boundary**: individual Google-login support ended on 2026-06-18 and moved to Antigravity. Enterprise Code Assist and API-key access remain supported by Gemini CLI.

## OpenCode
- **Binary**: `opencode`
- **Skip perms**: `--dangerously-skip-permissions`
- **System prompt**: `AGENTS.md`. Babysit mounts shared user globals at `${OPENCODE_CONFIG_DIR}/AGENTS.md` and types the separate `config.initial_prompt` launch brief into the TUI.
- **Resume**: `opencode --session <id>` (or `-c` for continue)
- **Model**: `--model provider/model`; `openai/gpt-5.6-sol` is the current Babysit default and appears in OpenCode's OpenAI catalog.
- **Creds**: `~/.local/share/opencode/auth.json` on every platform (opencode does NOT use the macOS Keychain — beware adapters that only check Keychain on darwin, they will silently drop opencode creds).
- **Install location**: `~/.local/bin/opencode` (curl install) or `~/.opencode/bin/opencode` (alternate). Container Dockerfile puts both on PATH.
- **Home env**: `OPENCODE_CONFIG_DIR` — points at the config dir directly (no `.opencode` suffix). Default is `~/.config/opencode`. Known bug upstream: when set, the global AGENTS.md inside it can be ignored if `~/.config/opencode/AGENTS.md` also exists (issues #7003, #11534) — we sidestep this by pinning OPENCODE_CONFIG_DIR to that same path inside the container.

## Session inventory
- Verified against the official Codex manual and Claude Code session docs on 2026-08-04.
- `codex resume` and `claude --resume` open native interactive pickers when no id is provided. Codex has no resume-picker JSON flag; its app-server `thread/list` method is the supported programmatic inventory. Claude stores transcript filenames by session UUID but documents the JSONL entry shape as internal and unstable.
- Host-native Codex and Claude transcripts are not automatically resumable inside Babysit. Babysit uses separate persistent Docker volumes for managed agent state, so its host-side `~/.babysit/sessions` registry is the truthful inventory for `babysit resume`.
- Treat the Babysit ID as the canonical selector because it restores the agent, workspace, and launch context. Show a captured native agent ID separately; repeated launches of one conversation can legitimately share that native ID.

## Host agent profile isolation
- Verified against official agent documentation on 2026-08-07.
- Gemini loads global instructions from `~/.gemini/GEMINI.md`, permits custom context filenames through `context.fileName`, and stores the selected login lane at `security.auth.selectedType`. Isolation must retain only the `security.auth` subtree from host settings so OAuth/API-key selection works without importing context, MCP, tool, model, or UI preferences.
- Gemini's `state.json` is persistent CLI UI/nudge state and `installation_id` is an installation-tracking identifier, not authentication. Isolated sessions retain `oauth_creds.json`, `google_accounts.json`, and sanitized auth selection, while allowing UI/tracking state to regenerate.
- OpenCode discovers global rules at `~/.config/opencode/AGENTS.md` and global skills from its own, Claude-compatible, and `~/.agents/skills` locations. Removing the shared `~/.agents` bind and dedicated native globals bind prevents those host definitions from reaching an OpenCode container.
- Gemini and OpenCode both continue to discover project-local instructions/skills under `/workspace`; `--ignore-host-agents-md` is intentionally host-global isolation, not repository instruction isolation.
- GitHub authentication can be reduced to `GH_TOKEN` / `GH_ENTERPRISE_TOKEN` by asking the host `gh auth token`; the container does not need the full config directory when host preferences are isolated. `~/.babysitrc` cannot be divided safely into credentials and preferences because it is executable shell, so strict isolation skips it instead of sourcing or parsing it on the host.

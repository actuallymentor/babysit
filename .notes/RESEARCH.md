# Agent CLI Research

Last verified against vendor docs: April 2026.

## Docker-outside-of-Docker
- Verified against Docker docs on 2026-05-05.
- Normal containers are unprivileged and cannot run a Docker daemon inside the container without `--privileged`; `--privileged` gives broad host-equivalent device/capability access, so Babysit should prefer Docker-outside-of-Docker over true Docker-in-Docker.
- Bind mount sources are resolved on the Docker daemon host, not the client container. Nested Babysit sessions therefore need the original host workspace path (`BABYSIT_HOST_WORKSPACE`) when building `docker run -v ...:/workspace`.
- Docker's Debian install docs support installing the client-side packages `docker-ce-cli`, `docker-buildx-plugin`, and `docker-compose-plugin` from the official Docker apt repository. Babysit's image installs those CLI/plugin packages only, not `docker-ce` or `containerd.io`.

## Claude Code
- **Binary**: `claude`
- **Skip perms**: `--dangerously-skip-permissions`
- **System prompt**: `--append-system-prompt "text"` (preferred — preserves built-in capabilities). `--system-prompt "text"` replaces the entire prompt.
- **Resume**: `claude --resume <id>` or `claude -r <id>`
- **Model**: `--model opus` / `--model sonnet` (aliases roll forward; opus → claude-opus-4-7 as of 2026-04-23)
- **Effort**: `--effort max` (other levels: low, medium, high, xhigh; available levels depend on the model)
- **Creds**: `~/.claude/.credentials.json` (linux), Keychain service "Claude Code-credentials" (macOS)
- **Install location**: `~/.local/bin/claude` (binary lives under `~/.local/share/claude/versions/` with a symlink in `~/.local/bin`). Container Dockerfile must add `~/.local/bin` to PATH.

## Codex
- **Binary**: `codex`
- **Skip perms**: `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`). `--full-auto` only skips approvals — it leaves codex's `workspace-write` sandbox active, which blocks real edits inside our docker container.
- **System prompt**: no CLI flag — codex reads `AGENTS.override.md` then `AGENTS.md` from `${CODEX_HOME}` (default `~/.codex`). The legacy `instructions.md` filename is silently ignored. Babysit pins `CODEX_HOME=/home/node/.codex` and writes the prompt to `AGENTS.md` via the entrypoint.
- **Resume**: `codex resume <id>` for interactive (what we use), `codex exec resume <id>` for non-interactive
- **Model**: `--model gpt-5.5` (as of April 2026; `gpt-5.4` is the API-key fallback if 5.5 isn't accessible)
- **Effort**: `-c model_reasoning_effort="xhigh"` for max effort (NOT bare `reasoning_effort` — that key is silently ignored). Values: `minimal`, `low`, `medium`, `high`, `xhigh` (xhigh is the highest)
- **Creds**: `${CODEX_HOME}/auth.json` for ChatGPT-OAuth login (default flow, `~/.codex/auth.json` only when `CODEX_HOME` is unset). `CODEX_API_KEY` / `OPENAI_API_KEY` env var as fallback for API-key auth. babysit forwards both — file first, env additively on top so users can override.
- **Home env**: `CODEX_HOME` — default `~/.codex`, controls where global AGENTS.md / config / sessions / auth.json live

## Gemini CLI
- **Binary**: `gemini`
- **Skip perms**: `--yolo` or `--approval-mode=yolo`
- **System prompt**: context file `GEMINI.md` (project-local). Babysit writes `${GEMINI_CLI_HOME}/.gemini/GEMINI.md` via entrypoint. Gemini *also* honors `GEMINI_SYSTEM_MD` (path or `1` = `~/.gemini/system.md`) to fully override the system prompt — we don't use that path because GEMINI.md additively layers on top of gemini's built-in prompt rather than replacing it.
- **Resume**: `gemini --resume latest` or `--resume <uuid>` or `--resume <session_index>`
- **Model**: `--model gemini-pro-latest` (alias resolves to gemini-3.1-pro as of March 2026; rolls forward automatically)
- **Effort**: no equivalent
- **Creds**: `~/.gemini/oauth_creds.json` for the Google-OAuth login flow. `GEMINI_API_KEY` env var as fallback for API-key auth. babysit forwards both — file first, env additively.
- **Home env**: `GEMINI_CLI_HOME` — default `$HOME`. Gemini creates a `.gemini/` folder *inside* this dir, so set it to the parent (we use `/home/node`). Not to be confused with `GEMINI_CLI_SYSTEM_DEFAULTS_PATH` / `GEMINI_CLI_SYSTEM_SETTINGS_PATH`, which point at single files.

## OpenCode
- **Binary**: `opencode`
- **Skip perms**: `--dangerously-skip-permissions`
- **System prompt**: `AGENTS.md` (project-local). Babysit writes `${OPENCODE_CONFIG_DIR}/AGENTS.md` via entrypoint.
- **Resume**: `opencode --session <id>` (or `-c` for continue)
- **Model**: `--model provider/model` — depends on user's auth.json provider, no sensible default to inject
- **Creds**: `~/.local/share/opencode/auth.json` on every platform (opencode does NOT use the macOS Keychain — beware adapters that only check Keychain on darwin, they will silently drop opencode creds).
- **Install location**: `~/.local/bin/opencode` (curl install) or `~/.opencode/bin/opencode` (alternate). Container Dockerfile puts both on PATH.
- **Home env**: `OPENCODE_CONFIG_DIR` — points at the config dir directly (no `.opencode` suffix). Default is `~/.config/opencode`. Known bug upstream: when set, the global AGENTS.md inside it can be ignored if `~/.config/opencode/AGENTS.md` also exists (issues #7003, #11534) — we sidestep this by pinning OPENCODE_CONFIG_DIR to that same path inside the container.

## Claude Code
- **Home env**: `CLAUDE_CONFIG_DIR` — default `~/.claude`. Documented behavior is partial: claude still creates local `.claude/` directories in workspaces and `/ide` integration may misbehave when set. We pin it to `/home/node/.claude` inside the container so it matches our credential / settings / projects mounts.

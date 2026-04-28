# Gotchas

Accumulated from sir-claudius + babysit development.

1. **Two-phase OAuth** — detect creds existence *before* pre-flight auth check. Pre-flight can rotate tokens. Capture *after* pre-flight.
2. **Docker inode tracking** — never `mv` a bind-mounted credential file. Docker tracks the original inode. Use `writeFileSync` (in-place) instead.
3. **ANSI cursor-forward** — `\x1b[nC` is used as visual whitespace by TUI agents. Replace with real space *before* stripping ANSI, or pattern matching breaks.
4. **Tmux session name limit** — ~256 chars max. Hash long paths (>200 chars) using SHA-256 truncated to 16 chars.
5. **Debounce auto-accept** — 3s minimum between consecutive auto-accepts. TUI redraw flicker causes false double-fire.
6. **Sync daemon cleanup** — use `unref()` on detached children, not `disown`. Avoids "Terminated" message on stderr.
7. **node_modules isolation** — Linux container produces Linux-native binaries. Mount a docker volume over `/workspace/node_modules` instead of bind-mount to prevent host breakage.
8. **Claude plan acceptance** — post-v2.1, plan accept is `\x1b[Z` (Shift+Tab), NOT Enter. Enter now rejects.
9. **mri's `unknown` callback halts parsing** — when set, mri returns the callback's return value instead of the parsed result. Don't use it for "include unknown args" — omit `unknown` entirely and identify known flags after parsing.
10. **tmux `send-keys -l` consumes all remaining args** — `Enter` after a `-l text` arg gets sent as literal text, not a key press. Send the literal text and the Enter in two separate `send-keys` calls.
11. **tmux `send-keys` shift+tab** — pass the named key `BTab`, not the literal escape string `\x1b[Z`. tmux interprets unrecognised key names as text input.
12. **Don't bind-mount the host's `~/.claude/settings.json`** — Claude rewrites it at runtime and would overwrite the user's host settings. Build a tmpfile that merges host settings + babysit overrides and mount that instead.
13. **`build_docker_command` returns a string consumed by `sh -c`** — every value-bearing arg (system prompt, env values, paths with spaces) MUST be shell-quoted. We use a single-quote wrap with `'\''` escaping for embedded quotes. Tests in `tests/docker.test.js` guard this; do not regress to a plain `flags.join(' ')`.
14. **Codex `resume` is interactive, `exec resume` is non-interactive** — babysit supervises through tmux, so the codex adapter must use `[ 'resume', id ]`. The `exec resume` form would launch in a non-interactive mode that can't be supervised.
15. **Docker image namespace is `actuallymentor/babysit`, not `babysit/babysit`** — both the publish workflow and the runtime pull/run must agree. Source in `src/docker/update.js` was originally wrong; tests in `tests/docker.test.js` lock this in.
16. **System prompt for non-claude agents goes via env + entrypoint** — codex/gemini/opencode have no `--append-system-prompt` flag, so the docker run injects `BABYSIT_SYSTEM_PROMPT` and `BABYSIT_SYSTEM_PROMPT_FILE` and the entrypoint writes the right file in `/home/node/.codex|.gemini|.config/opencode/`. Use container-local paths (NOT `/workspace/...`) — `/workspace` is read-only in mudbox and ephemeral in sandbox, so the write would silently fail there.
17. **mri normalises `--no-X` to `{X:false}`, not `{'no-X':true}`** — listing `'no-update'` in `boolean:` makes mri quietly drop the flag and store `update:false` instead. Detect with `args.update === false`. Symptom: `--no-update` was silently ignored, self-update always ran.
18. **Bun-compiled binaries can't `readFileSync` source-tree assets** — `__dirname` resolves to `/$bunfs` at runtime, so `readFileSync(join(__dirname, '../foo'))` errors with ENOENT for both `package.json` and our `system_prompt/*.md`. Use import attributes instead: `import x from './x.json' with { type: 'json' }` for JSON, or move text content into a `.js` module and import it normally. (Bun supports `with { type: 'text' }` but Node 24 does not, so the JS-module pattern is the cross-runtime safe choice.)

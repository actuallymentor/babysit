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

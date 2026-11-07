# Refactor plan (2026-11-07, user accepted all prefactor items; #8 = remove Antigravity) — DONE, shipped in 2.0.0

Order: S1 #8 → parallel A / B / C (worktrees) → D after A+C merged → merge, test:all + live smoke, 2.0.0, push+deploy.

- A credentials/launch: #1 setup-token-only Claude in containers (keep API key/Bedrock/Vertex routes; token import path without host claude / TTY; Claude token staged for nested claude in codex/opencode sessions too; legacy sessions keep sync until final flush) → #2 drop launch model probe (adapter-specific usable/refreshable/unknown gate; KEEP capture lease; checker enrollment = credentials present) → #9a one credential setup routine (adapter flags, one Keychain reader) → #7 sync state in durable BABYSIT_DIR state (not tmpdir), serialized reconcile kept, crash ordering defined → #9b start_session phases + single failure handler that retains recoverable state.
- B CLI: #4 registry for flags/commands/help/launcher/yaml/modifiers; grammar preserved byte-for-byte (babysit flags after agent word consumed, --log optional value, --no-X, literal --); README table check.
- C agents: #6 adapter `screen`/`state`/`accounts`/option fields (exact volume names, order, scoping); #5 shared transcript readers only (archive copier stays separate, durable receipt transport stays).
- D supervision: #3 events.jsonl producers first (Claude UserPromptSubmit/Stop/Notification, Codex notify, OpenCode), events augment pane scraping; missing events → pane fallback.

Review notes: two Codex plan reviews (Linus, DHH) 2026-11-07 drove the constraints above.

# Timeline

- **2026-04-28**: Project scaffolded. Based on sir-claudius analysis + agent CLI research. Tech: Node.js 24, bun compile, mentie, mri, yaml.
- **2026-04-28**: Full implementation completed across all 10 phases. All 55 tests passing. Discovered mentie `hash()` is async — switched to synchronous `crypto.createHash` in matcher, session, volumes, and credential refresh modules.
- **2026-04-28**: Spec compliance pass — fixed seven concrete bugs and wired up the statusline path that was missing from the v0.1.0 cut. See `.notes/GOTCHAS.md` for the new mri caveat. 73 tests passing.

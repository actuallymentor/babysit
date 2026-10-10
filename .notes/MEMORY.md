# Agent Memory Index

| File | Relevance | When to load |
|------|-----------|-------------|
| [MEMORY.md](MEMORY.md) | Index of persistent notes and load guidance | Read on every run |
| [GOTCHAS.md](GOTCHAS.md) | Active implementation pitfalls and invariants | Always on implementation changes |
| [HUMAN.md](HUMAN.md) | Decisions or blockers that require human review | Before releases or when work is blocked |
| [DEPLOYMENTS.md](DEPLOYMENTS.md) | Release distribution targets and deployment workflow | Before publishing or checking deployed releases |
| [RESEARCH.md](RESEARCH.md) | External platform, toolchain, agent CLI research, Codex auth reload findings, Claude bypass-immune dialogs, Docker daemon latency measurements | When updating integrations, defaults, dependencies, or diagnosing host re-login propagation |
| [AUTO_LOGIN_DESIGN.md](AUTO_LOGIN_DESIGN.md) | Parked design for automated Claude re-login (deterministic browser+IMAP, LLM fallback) and when to build it | When logouts persist despite setup-token, or re-login automation comes up |
| [RECOVERY_RESEARCH.md](RECOVERY_RESEARCH.md) | Accepted recovery design and Ubuntu boot validation | Before changing session recovery or boot services |
| [REASONING_CONTROL_PROOF.md](REASONING_CONTROL_PROOF.md) | Live Codex/OpenCode effort-switching evidence, transport requirements, and limits | Before changing agent-requested reasoning controls |
| [TIMELINE.md](TIMELINE.md) | Major recent decisions, changes, and release outcomes | When reviewing recent history |

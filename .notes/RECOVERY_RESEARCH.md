# Recovery research — 2026-09-09

Design proposal only. User requested research and decisions before implementation.

## Findings

- Babysit already has a per-launch JSON registry, native resume support, detached monitors, persistent transcript volumes outside sandbox, and partial clone-container reconciliation. Extend these concepts; a second registry/database is not necessary initially.
- Observed process exit and desired session lifetime must be separate. Detach, monitor failure, host shutdown, intentional CLI exit, and raw tmux deletion cannot all mean the same thing. A power loss can only be inferred from missing expected processes and durable intent; its physical cause cannot be proven.
- Atomic replacement prevents partial JSON reads, but power-loss durability also requires syncing the file and containing directory. Serialize concurrent intent updates so monitor cleanup cannot overwrite a recovery or closure decision. See [Linux fsync](https://www.man7.org/linux/man-pages/man2/fsync.2.html).
- Recover the last persisted conversation and workspace. Lost RAM, in-flight subprocesses, and unflushed transcript/workspace changes cannot be reconstructed. Completed external side effects may have happened even if the conversation did not record them.
- Exact native conversation identity is a prerequisite. Current terminal extraction can miss it before a crash; existing structured completion/session bindings are a useful integration surface, but need durable host publication. Never automatically fall back to the latest conversation. Root conversation changes must update identity too.
- Named Docker volumes outlive containers, but do not guarantee every recent agent write reached disk. Sandbox deliberately has no persistent transcript/workspace mounts; exclude it unless the user explicitly chooses persistence. See [Docker volumes](https://docs.docker.com/engine/storage/volumes/).

## Recommended behavior

- Recover all workspaces owned by the invoking user; allow one-session targeting and dry-run/JSON output. Relaunch detached, preserving permissions, workspace/clone, agent/model, ports, and recovery-relevant settings. Resolve credentials freshly; do not store secrets or blindly replay positional prompts/arbitrary launch arguments.
- Track expected-open intent before launch. Record intentional closure before stopping. Host teardown preserves intent. Add an explicit close/forget path so raw process deletion is not the only way to retire a session.
- Reconcile the latest launch in each resume chain under shared lifecycle locks. Verify launch identity, exact tmux pane, monitor, Docker endpoint/container, and workspace ownership. Probe failures mean unknown, not dead. Repair only the monitor when the agent survives. Recover credentials from surviving containers before disposal. Coordinate with clone pruning.
- Recover interrupted attempts as well as original sessions: a crash between relaunch and continuation must not create duplicates. Tie continuation to an attempt; wait for verified agent input readiness and serialize against loop/web input. If delivery is ambiguous after another crash, report it rather than blindly repeating. Raw terminal input cannot provide exactly-once delivery.
- Suggested continuation: "You were interrupted. Check the current state, then continue unfinished work." Keep automatic continuation enabled as requested; do not inherit the reviewer suggestion to disable it by default. This wording reduces blind replay but cannot guarantee idempotent external effects.
- Skip/report old records without trustworthy intent or exact conversation identity. Report inaccessible workspaces, missing transcripts, auth failures, unsupported replay settings, and Docker failures per session. Bound transient retries; one failure must not terminate successful recoveries. No implicit software/image upgrades.

## Ubuntu boot integration

- Prefer an opt-in systemd system unit running as the original Unix user on a conventional Ubuntu Docker host. Configure absolute executable, HOME/PATH, Docker access, and required mounts; order after Docker and network readiness. Login-only environment, passworded sudo, locked keyrings, and encrypted homes are boot prerequisites to resolve explicitly.
- Network ordering does not guarantee API reachability. Use bounded retries and per-session reporting. See [systemd network readiness](https://systemd.io/NETWORK_ONLINE/).
- A successful oneshot with RemainAfterExit=yes is a candidate for the existing detached model. It requires deliberate batch exit semantics and shutdown handling: service failure or stop can kill children in its cgroup. A shared tmux server may also own later interactive sessions. Do not solve this with KillMode=none. Validate process ownership, logout, shutdown, and restart in a real Ubuntu VM before shipping a unit. See [service lifecycle](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml) and [kill behavior](https://github.com/systemd/systemd/blob/main/man/systemd.kill.xml).
- A user unit with loginctl enable-linger is an alternative, especially for rootless Docker. Linger starts the user manager at boot; it does not automatically move existing tmux processes out of login scopes. See [loginctl](https://raw.githubusercontent.com/systemd/systemd/main/man/loginctl.xml) and [logind](https://raw.githubusercontent.com/systemd/systemd/main/man/logind.conf.xml).

## Decisions for the user

1. Recover across ordinary reboots too? Recommend yes: explicit closure retires a session; host lifecycle does not.
2. Reopen idle sessions too? Recommend all expected-open sessions. Continuation policy is separate: requested default sends to all recovered sessions; offer no-continue. Active-turn-only continuation needs durable turn state, not terminal-idle heuristics.
3. Missing transcript or unknown delivery: stop/report or best-effort guess/repeat? Recommend stop/report.
4. Sandbox: remain ephemeral or introduce persistent recovery? Recommend exclude from v1.
5. Replay configuration: preserve original effective launch settings or re-read current defaults? Recommend preserve execution settings, load current credentials, report unsupported/changed prerequisites.
6. Boot installer scope: recommend explicit installation for one account, bounded boot recovery rather than a perpetual restart watchdog.

## Validation before release

Real hard power-off of a disposable Ubuntu VM; normal reboot; clean CLI exit; explicit close; detach/logout; monitor-only kill; tmux-only kill with surviving container; simultaneous recover/resume/prune; failure during relaunch and message delivery; mixed successful/failed batch; delayed Docker/network/mounts; expired credentials; missing native ID; repeated invocation; all supported agents and clone mode. No runtime tests executed for this research-only task.

## Independent design review

Claude CLI review completed using model alias best, high effort. Accepted: reuse resume/start behind a strict recovery policy; prioritize durable native identity; account for boot-stale clone/auth locks as well as monitor PIDs; keep lifecycle locks shared with manual resume; specify systemd startup timeout and successful partial-batch semantics. Current monitor has no signal handlers, so default SIGTERM can bypass finally entirely; merely adding shutdown cleanup must not accidentally retire expected-open sessions.

Reviewer preferred user units with linger and per-session transient scopes. Keep this as an alternative until a VM validates the shared tmux server's ownership: separate scopes do not automatically isolate panes hosted by one existing server. Rejected continuation-off-by-default because the user explicitly requested sending continuation. Claims about how often native IDs are missing were not measured; only the unreliable extraction path was verified in source.

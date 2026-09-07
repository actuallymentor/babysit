# Live reasoning-control proof

Verified 2026-09-07 with installed `codex-cli 0.153.4` and real `gpt-6-astra` requests. The initial research below was followed by live implementation verification.

## Implementation verification — 2026-09-07

- The actual managed Codex TUI executed `babysit effort` through its shell tool. Real upstream requests changed **low → high → low → medium** within one turn, all HTTP 200 with the same model. Invalid effort returned nonzero without changing medium; the next user turn and footer retained medium. `/exit` stopped the TUI and owned server.
- **Enable `step_model_switching` in both server and TUI configuration.** The attached TUI supplies local configuration when creating the thread; setting the server flag alone produced a real partial failure: future defaults changed, active settings were rejected.
- The remote TUI needs explicit `--cd` to retain local workspace filtering in resume/fork pickers. Installed 0.153.4 accepts both `cli` and `vscode` histories; real picker and explicit UUID resume checks passed.
- Explicit Codex app servers record root sessions as `vscode` and do **not** invoke legacy `notify` in the verified remote flow; a matching plain TUI did invoke it. Preserve completion capture through a server observer. Unsubscribed clients receive global thread status changes; joining a root thread enables completion events. Idle status plus a full last-turn read handles turns that finish before subscription. The config-read API omits `notify`, so share the existing launch parser when resolving the configured callback.
- Final captured-launch verification passed real high → low effort changes, exact final-reply capture, and the pre-existing custom notification callback together. This closes the native-notify regression introduced by remote mode.
- OpenCode **1.18.29** real inference with OpenRouter GPT-5.6 Sol disproved native v2 `switchModel`: successful HTTP 204 responses still produced low/low/low/low in its TUI loop. The official `chat.params` plugin hook driven by session metadata produced low/high/low/medium, persisted to another turn, and reset to the TUI's low with `default`.
- OpenCode's latest user message identifies the inference model; v2 `session.model` can disagree. Bind overrides to provider/model. The TUI footer does not reflect the plugin override.
- Capture OpenCode's plugin constructor directory and send encoded `x-opencode-directory`: shell tools can run in another directory. The final managed TUI proof exercised commands from `/tmp` and `/` successfully.
- Sources: [Codex app server](https://developers.openai.com/codex/app-server), [OpenCode plugins](https://opencode.ai/docs/plugins/), and installed CLI schemas/source. Provider evidence recorded only model, reasoning, and status, never credentials. Temporary live harnesses were stopped after testing.

## Method

- Started a separate `codex app-server` with `features.step_model_switching=true` and an explicit loopback WebSocket listener.
- Attached the real Codex TUI through `codex resume --remote ws://... <test-thread-id>` in a private tmux server. Submitted the experiment and follow-up through its composer.
- A local HTTP relay forwarded requests to the real ChatGPT Codex backend over HTTPS. It recorded only model/reasoning fields and HTTP status, never authentication headers. The custom provider used OpenAI authentication and disabled provider WebSocket transport for observable HTTP requests.
- A dynamic `checkpoint` tool held each step open until the controller updated settings. The real model called three checkpoints sequentially. Each control change preceded the next model request within the same turn.
- A second independent control client connected after checkpoint 1 had started and rejoined the active thread with `thread/resume`, without overrides. The response identified the same thread with status `active`.

## Observed results

First run, thread `01a07c6b-057d-7a22-9c37-dd74294a6604`, active turn `01a07c6b-4cf6-7f90-963d-8a26a4836612`:

| Control operation | Next actual request effort | Live TUI footer |
| --- | --- | --- |
| Initial turn | `low` | `low` |
| Active-turn update to `high` | `high` | `low` |
| Active-turn update to `low` | `low` | `low` |
| Thread-only update to `medium` while still active | `low` | `medium` |
| Next user turn | `medium` | `medium` |

Second run, thread `01a07c6c-b2a6-7482-b062-f4462ded241c`, active turn `01a07c6c-cae6-7671-bccc-7e64260c5f74`:

| Time (UTC) | Operation | Actual request after checkpoint | Footer |
| --- | --- | --- | --- |
| 15:11:43 | Second client joins active session; thread + turn update | `medium` | `medium` |
| 15:11:46–47 | Thread + turn update | `high` | `high` |
| 15:11:49–50 | Thread + turn update | `low` | `low` |
| 15:11:53 | Follow-up submitted through TUI | `low` | `low` |

All listed requests used `gpt-6-astra`, received HTTP 200 from the actual upstream service, and the turns completed. Assertions over the captured evidence checked each update against the next request and footer, all checkpoints against one turn ID, successful active-session attachment, and follow-up completion. The startup banner remains historical; the live footer is the relevant UI observation.

## Required semantics and failure cases

- `turn/settings/update` accepts `{threadId, turnId, effort}` and changes later inference steps in that active turn. It does not change future-turn defaults or the footer.
- `thread/settings/update` accepts `{threadId, effort}` and changes future-turn defaults plus the live footer. It does not change the running turn's inference settings.
- Updating both produced the requested current-turn behavior, UI state, and next-turn persistence. These are separate requests, not an atomic operation; handle partial success and a turn ending between them.
- Wrong and already-completed turn IDs returned `targetUnavailable` rather than affecting another turn.
- An invented nonempty effort string returned `applied`. It was replaced with a valid effort while the checkpoint remained blocked, before any inference used it. Validate against `model/list.supportedReasoningEfforts` before either update; success does not validate the value.
- The model catalog advertised `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`. Real requests exercised `low`, `medium`, and `high`; do not claim the other levels were inference-tested.
- The earlier isolated probe established that `turn/settings/update` rejects requests when the under-development `step_model_switching` feature is disabled. Do not assume it can be enabled retroactively in an existing session.
- These tests changed the next request at a tool boundary. They do not claim to alter a request already executing at the provider, change child agents, or verify every provider transport.

## Transport findings

- A Unix listener also works, but carries WebSocket framing: a separate isolated, unauthenticated test received HTTP `101 Switching Protocols` and a successful framed `initialize` response over `AF_UNIX`.
- `codex app-server proxy --sock ...` passes bytes through. Sending raw JSONL to it does not perform the Unix socket's WebSocket handshake; that caused the first stalled probe.
- A newly created thread without any turn could be listed as loaded but could not be resumed by either a second client or the TUI (`no rollout found`). A short initial real turn made it resumable. Do not build discovery tests around empty threads alone.
- `codex app-server daemon start` in a fresh home required the standalone installer path and failed with only the npm CLI installation. Explicit `codex app-server --listen ...` worked with that same installed CLI.
- A plain authenticated `codex` launch reached the ready TUI with the same installed npm CLI, but `$CODEX_HOME/app-server-control/app-server-control.sock` remained absent. The unauthenticated fresh-home TUI likewise created no such socket before sign-in. The proven integration must own an explicit app-server endpoint; do not promise transparent attachment to arbitrary existing plain-TUI sessions.

## Implementation consequence

A native adapter is viable for Codex 0.153.4 when it controls the exact server hosting the TUI and the feature is enabled. Use an explicit request such as `babysit effort <supported-level>`, target the exact thread and current turn, validate the model's capability list, update both scopes, and report partial application accurately. A dedicated Unix socket avoids a network listener once Babysit's launch path owns the endpoint.

This requires changing Babysit's Codex launch path to start the explicit server and attach its TUI. It is not a proven retrofit for sessions already running under the ordinary launch path.

This proof does not establish live control for Claude Code, OpenCode, or Gemini CLI. Their earlier findings remain documentation research.

## Sources

- Installed CLI help, generated experimental protocol schemas, actual control responses, outbound request fields, and captured TUI screens.
- [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server): general protocol and model capability discovery; the tested settings-update methods were not described there at research time.
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference): custom provider authentication, base URL, and transport controls used by the relay.

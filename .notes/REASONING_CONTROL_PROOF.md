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

The initial Codex experiment did not establish live control for other agents. OpenCode was subsequently verified as recorded above; Claude Code and Gemini CLI remain outside the implemented effort controls.

## Fresh production-container verification — 2026-09-08

Launched through the actual Babysit CLI using published image `actuallymentor/babysit@sha256:7a8d9fc5252e80f1cb8de100908b9383abc11e4327ad9c4be93502a0b57b3f28` (image ID `sha256:b7f4709d07161565749d2c19c2509411ce25f4c63a2b86498663d6453503b077`). All image effort modules and entrypoint hashes matched the committed source. These checks used real credentials, native TUIs, installed `babysit effort`, and transparent relays forwarding real provider requests. Authentication preflight was skipped through its supported Enter prompt; actual inference verified authentication directly.

- OpenCode 1.18.29, container `98486133a229`, session `ses_f7f86d91dffe9tnU6PbQbGvL8g`: nine LLM-issued helper commands across three user turns. Actual GPT-5.6 Sol requests changed omitted/default → high → low → medium; invalid effort exited 1 and preserved medium. Medium persisted into the next turn. `default` restored an omitted reasoning field, including another user turn. All 12 main-model requests returned HTTP 200. Completion capture matched the session and final reply. Root independently correlated command completion timestamps with the next provider request. Sanitized evidence: `/tmp/opencode-fresh-container-evidence/` (ephemeral).
- Codex 0.153.4, container `44d8f46bdfba`, thread `01a0807d-08f7-7890-9cee-4dcf64ac2a8f`: six LLM-issued helper commands in turn `01a0807e-29cb-7eb3-8837-5b89e2cdf6e7`. Actual gpt-6-astra requests changed low → high → low → medium; invalid effort exited 1 and preserved medium. A subsequent user turn used medium, the native footer showed medium, and production completion capture matched the exact final reply. All nine real model requests returned HTTP 200. Root independently asserted native command sequence/exit codes, completed turn IDs, request effort sequence within turn timestamps, and completion capture. Sanitized evidence: `/tmp/codex-real-container-evidence-20260908/` (ephemeral).

Both successful launches used `--yolo --ignore-host-agents-md` with real native credentials. Only low, medium, and high were inference-tested; this does not establish every supported level or provider. No effort source changes were necessary for these passes.

### Launch pitfalls exposed by the full path (subsequently fixed)

- Explicit `--model`/`-m` is appended after Babysit's default model flag. Codex 0.153.4 rejects the duplicate; OpenCode 1.18.29 parses an array and crashes with `U.split is not a function`. Use the configured/default model for these verification launches. The unconditional default flag predates the effort feature.
- Codex configuration staging detects NUX model keys only when double-quoted. A valid native config with bare keys acquires duplicate quoted keys and becomes invalid TOML (`Cannot overwrite a value`). This predates the effort feature. The supported `--ignore-host-agents-md` option supplies a fresh config while retaining natural authentication and production completion/effort integration. Successful isolated-config tests do not establish that the inherited-config launch works.

Follow-up on 2026-09-08 fixed both pitfalls: explicit model flags suppress default injection, and Codex staging parses/serializes the temporary TOML with integer/float types preserved. Native config key spelling is not stable; never identify existing TOML keys by requiring quotation marks. Invalid input errors must omit source excerpts because configuration may contain secrets.

The fixed OpenCode path was exercised through Babysit in fresh container `bb86863d8f88`: exactly one explicit GPT-5.6 Sol model flag overrode a different project model. The real model executed `babysit effort high` then `low`; actual requests were omitted/high/low, all HTTP 200, and completion capture passed. Evidence: `/tmp/opencode-explicit-model-evidence/` (ephemeral).

The fixed Codex path passed in fresh container `c5f9553bad58` with an explicit model and inherited host configuration, without `--ignore-host-agents-md`. The actual command contained one model flag; staged TOML parsed with 11 integer NUX entries, and the host config hash stayed unchanged. Thread `01a0808b-3283-7bf1-9b10-37af18a84b4b` executed `babysit effort high` then `low`; four real gpt-6-astra requests used low/low/high/low, all HTTP 200. Production completion capture passed. Evidence: `/tmp/codex-fixed-container-evidence-20260908/` (ephemeral).

## Sources

- Installed CLI help, generated experimental protocol schemas, actual control responses, outbound request fields, and captured TUI screens.
- [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server): general protocol and model capability discovery; the tested settings-update methods were not described there at research time.
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference): custom provider authentication, base URL, and transport controls used by the relay.

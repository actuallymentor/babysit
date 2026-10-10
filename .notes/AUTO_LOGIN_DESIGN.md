# Automated Claude re-login — parked design (options B and D)

Status 2026-10-10: **B built in 1.36.0** on user request (A stays the primary path; B replaces whichever login died). D not built. As built, it differs from the plan below:
- No separate image. The babysit image already ships Chrome, puppeteer, xvfb, tmux, python3, and claude; the driver is `/opt/relogin`.
- No pane scraping of URLs and no pasted codes. `$BROWSER` gets the authorize URL with a `localhost:PORT/callback` redirect, so Chrome in the same container finishes the CLI's own OAuth. `claude auth login --claudeai --email` exists (2.1.296) for login mode. Token mode reads the `sk-ant-oat` token from the tmux pane (`capture-pane -J`, 500 columns).
- The auth lease is released before re-login (a browser login can take minutes; the lease timeout is 8 min). Its own lock is `~/.babysit/relogin.lock`.
- **Cloudflare finding (live, 2026-10-10):** with puppeteer-default Chrome under xvfb on this host, submitting the email on claude.ai/login leads to `/api/challenge_redirect` ("Verify you are human"); it did not clear in 60s. Not solved and not evaded (no stealth flags), per the rule below. So the email path likely fails here, and the practical path is a seeded claude.ai session (`babysit auth relogin --session-key`, a pasted `sessionKey` cookie), where only "Authorize" is clicked. Whether the consent page itself gets challenged is **untested** (no session available to test with).
- The `/login` account email is the host `~/.claude.json` `oauthAccount.emailAddress` by default (the user's Claude account is not the Gmail address; mail must be forwarded into Gmail).

## Build B when any of these holds
- A setup-token login gets revoked or logged out in practice (alert names it).
- Anthropic restricts setup-tokens for interactive use, or shortens their 1-year life.
- A needed feature requires a full `/login` scope: Remote Control, claude.ai connectors, `/schedule`, or usage with no `/login` file left.

## Check first (option 0)
~3h logout cadence ≠ Anthropic expiry (`refreshTokenExpiresAt` ≈ 27 days). Most likely cause: a one-use refresh token consumed by two holders (sessions, host CLI, probes; GOTCHAS 41/94/160 and HUMAN.md "6h container probe runs during live sessions"). Logout alerts now carry a `reason`. Correlate `~/.babysit/alerts.json` timestamps with session launches and checker runs before automating around a babysit bug.

## B — deterministic re-login (recommended if A fails)

**Shape.** A separate on-demand container (`babysit-relogin` image: Playwright + headful Chromium under xvfb). Not a daemon. The auth checker starts it. Rationale: it keeps browser deps out of the CLI image, keeps mailbox credentials out of agent containers, and gives a clean kill boundary.

**Trigger.** `cmd_auth_check` confirms Claude is `unauthenticated` (host or container probe, never the pane alone). It runs `babysit auth relogin claude` before `alert_logouts`, under the global host auth lease plus `~/.babysit/relogin.lock`. Caps: one attempt per logout key, ≤3 per day, then alert only.

**Flow.**
1. Spawn `claude` in tmux inside the relogin container against a temp `CLAUDE_CONFIG_DIR`. Drive `/login` → "Claude account with subscription" and capture the authorize URL from the pane. Wait for `Paste code here if prompted`. (Verify first whether a non-interactive `claude auth login` exists in the installed version; prefer it.)
2. Open the URL in the persistent Chromium profile (`~/.babysit/relogin/profile`, 0700, volume).
   - claude.ai session alive → consent page → click Authorize → the code page shows the code → extract it.
   - Session expired → enter `CLAUDE_LOGIN_EMAIL` (default `GMAIL_USER`) → "check your email" state → step 3.
3. Mail: IMAP (IDLE, else poll every 5s, 10 min window) on the Gmail mailbox (`GMAIL_USER`). Accept only messages that pass all of these:
   - From an allowlisted sender (`@anthropic.com`, `@mail.anthropic.com`).
   - Authenticated From: trust only the `Authentication-Results` header stamped by the receiving mailbox's own `authserv-id` (`mx.google.com` for Gmail; RFC 8601 §1.6; ignore every other copy). Require `dkim=pass` with `header.d` aligned to the From domain. A forwarder that breaks DKIM must hand over a passing ARC chain sealed by the known forwarding provider, with the original `dkim=pass` aligned to the From domain inside it. A bare "pass" anywhere is not enough.
   - `Date` ≥ login start − 1 min.
   - Link host in `{claude.ai, anthropic.com, *.anthropic.com}`.

   Open the link in the same profile; it may instead show a verification code to type into the email page, so support both. Delete or flag the message after use; never reuse it.
4. Paste the code into the pane and wait for `Login successful`. Anything else is a failure.
5. Install (the `/login` path): atomic write (tmp in the same dir + rename, keep 0600) of the temp `.credentials.json` over host `~/.claude/.credentials.json`, under the lease. Running sessions receive it through the source-wins sync. Then `auth check claude --force` re-records the cache. Never touch Keychain; macOS Keychain logins are out of scope for v1.
   **If A is in use, the dead credential is `CLAUDE_CODE_OAUTH_TOKEN`, not the file.** It outranks `/login`, so a fresh file changes nothing. Mint a replacement with `claude setup-token` (same browser authorize flow, the token prints to the pane) and rewrite the variable in its env file, or remove the variable so sessions fall back to `/login`.
6. Pushover result: success, or the failing step name plus a screenshot path (`~/.babysit/relogin/runs/<ts>/`).

**Config.** Gmail only: IMAP `imap.gmail.com:993` (TLS), login `GMAIL_USER` + `GMAIL_APP_PASSWORD` (16-letter app password; strip spaces before use). `CLAUDE_LOGIN_EMAIL` is optional and defaults to `GMAIL_USER`; set it only when Claude mail is forwarded in from another address. Optional `BABYSIT_RELOGIN_SENDERS` overrides the sender allowlist. All of it lives in `~/.babysitrc` as plain `KEY=value` (the host loader and entrypoint source with `set -a`). User decision 2026-10-10: exposure to agent containers is accepted. Validated 2026-10-10: both vars set, IMAP login OK, inbox opened read-only, IDLE advertised.
Preflight: missing or empty var → skip the mail step and alert "set GMAIL_USER / GMAIL_APP_PASSWORD in ~/.babysitrc". IMAP `AUTHENTICATIONFAILED` → alert "Gmail app password rejected" and never retry in a loop.

**Page states** are a pure classifier `(url, DOM snapshot) → consent | email_entry | check_email | code_shown | email_code_entry | success | error | captcha | unknown`, unit-tested on saved HTML fixtures. `captcha`/Cloudflare challenge → stop and alert; never solve it.

**Tests.** Classifier fixtures, `.eml` parser fixtures (spoofed sender, failed DKIM, stale date, off-domain link), and a pane-driver test against a fake `claude` script. Real e2e is manual only.

**Risks.**
- UI drift breaks selectors → alert, and D covers it.
- Bot detection on claude.ai → headful plus a persistent profile reduces it but cannot guarantee it.
- **Mailbox = account.** Whoever controls the agent mailbox or the forwarding rule can log in as the user. Use a dedicated mailbox, an app password, and a narrow forward rule (sender + subject).

## D — B plus a sandboxed LLM for unknown page states

Only when the classifier returns `unknown`. Driver is Codex: Claude is the agent that is logged out. With A working, Claude could drive via the setup-token, but then B isn't needed.

**Contract.**
- **Input:** screenshot, accessibility tree (refs, roles, names), current URL, and goal ("reach the page that shows the login code").
- **Never sent:** email bodies, terminal access, credentials. Redact before sending or logging: drop URL query strings and fragments (magic-link tokens, OAuth `code`/`state`), mask text inputs and any element that looks like a code, and take no screenshot once a known `code_shown` state is reached. Run logs stay 0600 and get pruned after 7 days.
- **Output:** JSON validated against a schema: `{ action: click|type|wait|abort, ref?, text_source?: email|code }`. Typed text can only come from the named constants, never from free text.
- **Executor:** the script performs the action, refuses navigation off allowlisted hosts, and stops after ≤8 steps.
- **Logging:** every LLM decision and screenshot goes to the run dir. Recurring unknown states get promoted into deterministic handlers; the LLM path should shrink over time.

**Rejected: option C (LLM + markdown skill as the main path).** Email content would steer an agent that holds browser and terminal access to the account. That is prompt injection into account control. It is also nondeterministic and costs tokens on every login.

## Other agents
- **Codex.** Rarely logs out. `codex login --device-auth` (code at a URL) with a persistent ChatGPT browser profile fits B's skeleton. An API key (`CODEX_API_KEY`) avoids it entirely.
- **Antigravity.** Google sign-in fights automation hard. Use `GEMINI_API_KEY` instead.

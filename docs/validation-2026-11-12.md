# Official Codex CLI validation

Environment: Linux, Bun 1.4.4, and `codex-cli 0.167.2`. Source reviewed: tag `rust-v0.167.2`, commit `ce21072c90d32c40af7a55b60b2fb35c84a43a6a` in [openai/codex](https://github.com/openai/codex/tree/ce21072c90d32c40af7a55b60b2fb35c84a43a6a).

All tests used fake identities and tokens, isolated `CODEX_HOME` and SQLite directories, local SSE inference, and a local OAuth endpoint. The native CLI test blocks external traffic through an unavailable local proxy and permits only localhost. No real subscription was authenticated or charged.

## Replacing only the cache does not work

`bun run test:auth-case` starts the official App Server and runs three turns in the same conversation. A `PostModelRequest` hook atomically replaces account A's file with account B's file.

| Stage | Account on disk | Account observed in the request |
| --- | --- | --- |
| First turn | A → B through the hook | A |
| Second turn in the same process | B | A |
| Third turn after the RPC update | B | B |

The second and third turns included the first turn's marker. The file alone does not provide live account switching; the RPC changes authentication in memory without discarding local context.

This behavior matches the [AuthManager implementation in this version](https://github.com/openai/codex/blob/ce21072c90d32c40af7a55b60b2fb35c84a43a6a/codex-rs/login/src/auth/manager.rs#L2195), which documents the in-memory cache and the need for an explicit reload.

## Plugin and backend launched through the official binary

`bun run test:native-case` installs the package through the local marketplace in a temporary directory, trusts only the four fixture hooks, starts the official daemon, and launches:

```text
codex --no-alt-screen "Remember NATIVE_CONTEXT_42 and reply."
```

It does not use `--remote`, a wrapper, an alias, a skill, MCP, executable modifications, or injected account manager instructions.

The local server returns HTTP 429 with `usage_limit_reached` for account A. The hook registers the switch offer in the backend. The test confirms that account A remains active until confirmation, rejects a submission with an invalid CSRF token, cancels an offer without switching accounts, and then confirms account B through the same form used in the browser.

Account B's first request returns HTTP 401. The backend handles the refresh request, uses a separate official App Server in managed mode to refresh the login, and saves the new refresh token generation. The local service accepts the refreshed generation and returns the SSE response.

Checks that passed:

- The CLI PID stayed the same before and after switching.
- The loaded conversation ID stayed the same in the daemon.
- The `ChatGPT-Account-Id` header changed from A to B.
- Account B's request included the previous history marker.
- The inference payload contained no account manager identification or instructions.
- No model call occurred while displaying the form or switching accounts.
- Cancellation kept account A; invalid confirmation returned HTTP 403.
- The HTTP 401 was recovered, and the refreshed token was preserved in both the vault and active cache.
- The official interface received account B's response in the same terminal.

Automation does not open the browser (`CODEX_ACCOUNTS_NO_BROWSER=1`). The test inspects the page and submits forms over local HTTP. Actual browser launching through `xdg-open` or `open`, and operation with two real subscriptions, still require manual validation.

## Confirmed implementation details

- The daemon's control socket speaks WebSocket, not JSONL. `codex app-server proxy` is a byte tunnel; the backend connects directly through WebSocket over Unix.
- `--dangerously-bypass-hook-trust` prevents daemon reuse in this version. Automation writes trust settings equivalent to `/hooks`, exclusively in the temporary configuration.
- After a quota failure, the conversation state may be `systemError` rather than `idle`. The switch guard rejects `active` turns.
- Server requests may be broadcast to multiple clients. The backend answers only authentication refresh requests and ignores approvals owned by the native CLI.
- The verified hooks-only plugin package uses the compatible `.codex-plugin/plugin.json` format without skills.

## Scope of the findings

The local mechanism was demonstrated with the installed binary. This does not establish eligibility, model availability, workspace policies, or billing behavior for real accounts. The `chatgptAuthTokens` RPC is experimental and must be revalidated with each version. The prototype requires `cli_auth_credentials_store = "file"`; it does not migrate the keyring. There is no automatic restart fallback.

Official references: [Hooks](https://learn.chatgpt.com/docs/hooks), [App Server](https://developers.openai.com/codex/app-server/), and [Plugin packaging](https://developers.openai.com/plugins/build/plugins).

## Unified suite and automatic continuation

Command: `TMPDIR=/var/tmp bun run test:all` (`/tmp` on the test machine did not have enough space for the daemon).

Result: **seven stages passed in 27.8 seconds**, using Bun 1.4.4 and Codex CLI 0.167.2:

1. TypeScript checking.
2. All 15 unit tests passed, covering preferences, credential protection, RPC, and continuation.
3. Build of the three plugin executables.
4. Authentication and history through the official App Server.
5. Manual switching, CSRF and origin checks, refresh after HTTP 401, removal, sign-out, restart, SSE, and persistence of both preferences.
6. Autoswitch with continuation disabled: no account B request started automatically.
7. Autoswitch with continuation enabled: the official CLI received the response in the same process with the history marker preserved.

Continuation identifies quota failures in each loaded conversation's latest turn, ignores ephemeral threads, and reads the turn again after switching. If the user has already changed the conversation, submission is skipped. A `turn/start` timeout does not trigger resubmission or another account switch.

The integration test revealed that the daemon also lists internal ephemeral threads, which reject turn history reads. The routine ignores those threads. Temporary projects must stay outside the repository tree to avoid inheriting its `AGENTS.md`; short paths also avoid Unix socket path limits.

## CLI quota commands and quota-reset continuation

Implemented `usage [NAME] [--json]`, `switch NAME`, command help, argument errors,
and `resume-after-reset on|off`, with Bun script shortcuts. The native CLI case
checks all-account and single-account quota JSON, live switching, and persistence
of the independent reset-continuation preference.

The suite now includes two additional official CLI scenarios using only local
fake services:

- Early/token reset: the published reset timestamp remains in the future, but
  restored quota causes one continuation in the original account and conversation.
- Weekly reset: restored weekly capacity does not resume while the 5-hour quota
  remains exhausted. Restoring both windows causes continuation with the original
  context and CLI process. The scenario checks the conversation has exactly two
  turns (the failed turn and its continuation) and one durable submission claim.

The backend uses a 30-second recurring job plus daemon notifications, not a system
crontab. Enable it explicitly from the panel or CLI. Reset tokens are redeemed
outside the plugin; tests simulate their resulting quota recovery.

Validation: `bun run test:all` with a short, private on-disk `TMPDIR` passed all nine
stages in 96.6 seconds. The initial attempt using `/tmp` could not install the
isolated daemon because that tmpfs had insufficient free space; no tests were
skipped to work around it. The final unit run passed 16 tests with 118 assertions;
`bun run check` and the final `bun run build` also passed. Test fixtures use no real
accounts, and generating conversation titles may make auxiliary inference calls,
so duplicate detection counts conversation turns rather than raw HTTP requests.

## Terminal interface and expanded documentation

The suite now has ten stages. The additional PTY scenario exercises the terminal
manager with an isolated fake client: arrow navigation, explicit switch
confirmation, cancellation, setting toggles, failed removal, canceled login,
and restoration of raw mode, cursor visibility, and the alternate screen.
No real vault, account, or inference service is used by that scenario.

Terminal rendering tests also cover remaining-capacity bars, unknown quotas,
selection wrapping, small-terminal scrolling, and removal of service-supplied
control characters. The theme uses the terminal defaults, bold headings, dim
metadata, and reverse-video selection without a fixed accent palette.

Final validation: `bun run test:all` with a short, private on-disk `TMPDIR` passed
all **ten stages in 95.1 seconds**, including **19 unit tests and 150 assertions**.
Type checking, regenerated plugin bundles, authentication integrations, manual
switching, both autoswitch modes, early/token reset, and weekly reset waiting for
five-hour capacity all passed. `git diff --check` reported no whitespace errors.

User documentation is organized in the [CLI/TUI guide](cli.md),
[automation guide](automation.md), and [README](../README.md). The upstream MIT
attribution is retained in `LICENSE`; Git history is preserved when linking the
Codex adaptation to the upstream fork network.

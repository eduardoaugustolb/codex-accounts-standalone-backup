# Automatic behavior and recovery

The manager can switch accounts, continue after a switch, or wait for quota
recovery. These are separate, opt-in preferences. None restarts the official CLI,
replaces its binary, or injects keystrokes into its terminal.

## Preferences

| Setting | Default | Requirement | Effect |
| --- | --- | --- | --- |
| `autoSwitch` | Off | Another saved identity with confirmed capacity in both windows | Switch the shared session after quota exhaustion. |
| `autoContinue` | Off | `autoSwitch` enabled and a successful automatic switch | Continue loaded quota-failed conversations after login. |
| `resumeAfterReset` | Off | Current identity is saved and both windows report positive capacity | Continue loaded quota-failed conversations after quota recovery. |

Set these in the browser's **Preferências** section or in `bun run tui` with a,
c, and w respectively. To configure reset continuation directly:

```bash
bun run resume-after-reset on
bun run resume-after-reset off
```

Preferences persist in `settings.json` under the vault root. Avoid editing the
file while the backend runs; use the UI or CLI so memory and disk stay in sync.
Turning a setting off prevents future submissions but cannot cancel requests the
daemon has already accepted.

## Automatic switching

On quota exhaustion, the backend waits until all loaded turns sharing the daemon
are idle. It checks saved aliases in alphabetical order and selects a different
account identity with positive, confirmed remaining capacity in **both** the
five-hour and weekly windows. Missing or unavailable quotas do not qualify.

If no candidate qualifies, the current session stays in place and the panel
reports the reason. Autoswitch never opens the browser. A switch changes the
account for all conversations sharing the daemon, not only the failed conversation.

With `autoContinue` enabled, the backend captures eligible failed turns before
login and rechecks them afterward. A continuation failure after login does not
cause another account switch. Manual and preventive switches do not submit turns.

## Continue after quota recovery

`resumeAfterReset` runs independently of autoswitch. The backend owns a recurring
job, using an in-process timer rather than an operating-system crontab. While it
and the official daemon are running, it reads the current saved account's quotas
every 30 seconds, and schedules checks after relevant daemon notifications.

This is polling, not an exact wall-clock promise. Reads, network latency, active
backend operations, machine sleep, and daemon availability can delay a check.
The service's observed capacity is authoritative; `resetsAt` is display metadata,
not permission to submit a turn.

| Event | Resume? |
| --- | --- |
| Five-hour quota recovers; weekly capacity is positive | Yes, for eligible failed turns. |
| Weekly quota recovers; five-hour capacity is positive | Yes, for eligible failed turns. |
| Weekly quota recovers; five-hour quota is still exhausted | No; keep waiting. |
| A reset token restores capacity early | Yes, after the service reports positive capacity in both windows. |
| A reset time passes but a read still reports exhaustion | No; keep waiting. |
| A quota window is missing or the read fails | No; capacity is unconfirmed. |
| User already continued or started another turn | No; the old failed turn is superseded. |
| Failure is unrelated to quota | No. |

The plugin **does not redeem reset tokens** or require their values. Redeem them
through the supported external flow. The plugin detects the resulting quota
change without waiting for the previously advertised reset time.

## Conversation eligibility

For either continuation path, the conversation must:

1. Be loaded in the shared official daemon and not be ephemeral.
2. Have no active turn.
3. Have a latest turn whose status is failed and whose error indicates a usage
   limit or exceeded quota.
4. Still have that exact failed turn as its latest turn immediately before
   submission.

The manager sends the text `continue` through `turn/start` in the same thread.
It preserves conversation history and skips generic HTTP 429, network, and
unrelated failures. It does not reopen unloaded conversations.

## Persistence and uncertain submissions

Reset continuation writes a private, durable claim for the conversation/failed
turn pair before submitting. Claims live in `reset-continuation-claims.json`
under the vault root. They survive backend restarts and prevent a submission with
an uncertain result from being attempted again automatically.

This deliberately favors avoiding duplicate turns. A crash after claiming but
before submission may leave a conversation uncontinued. Likewise, a timeout does
not prove the daemon rejected the request. Inspect Codex before continuing
manually; do not delete claims to force a retry.

The browser panel and TUI display backend messages about waiting or failed
continuation. Closing either UI does not stop the job. Stopping the backend,
logging out, shutting down the daemon, or suspending the machine prevents checks.
On restart, enabled reset continuation scans currently loaded conversations and
rechecks service capacity.

## Common configurations

**Wait for the same account:** enable only `resumeAfterReset`. Quota exhaustion
keeps the current account; the backend continues after both windows recover.
This mode does not open the browser automatically.

**Rotate accounts and continue immediately:** enable `autoSwitch` and
`autoContinue`. A qualifying account is selected after active turns finish, then
eligible failed conversations receive `continue`.

**Rotate when possible, otherwise wait:** enable all three. Autoswitch can use a
qualifying identity; if no account qualifies, reset continuation keeps checking
the current account. Since both continuation options are enabled, capacity on a
newly selected account can also allow reset continuation to resume a loaded
quota-failed turn. Manual switching itself never sends a continuation.

**Keep control of every turn:** leave all three disabled. Choose an account in
the TUI or browser and send `continue` yourself in Codex.

## Runtime and storage

The default vault is `~/.local/share/codex-accounts`, overridden by
`CODEX_ACCOUNTS_HOME`. Credential files and settings are private (`0600`) inside
private directories (`0700`). `CODEX_HOME` selects the official session; use the
same value in Codex and the manager. `CODEX_ACCOUNTS_CODEX` selects the official
binary. `CODEX_ACCOUNTS_NO_BROWSER=1` suppresses browser launching.

Do not run real-account tests to validate automation. The
[validation report](validation-2026-11-12.md) describes isolated fake-account
scenarios with the official binary, including early reset and weekly recovery.

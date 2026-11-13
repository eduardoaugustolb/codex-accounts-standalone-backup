# CLI and terminal interface

Run commands from the project directory with **Bun**. No global installation or
wrapper around `codex` is required. Keep using the official `codex` command to
work on your conversations.

## Start here

```bash
bun run help
bun run tui
bun run usage
bun run usage work
bun run switch personal
```

Names such as `personal` and `work` are local aliases. Register them with `add` or
`capture` first. Each name must start with a letter or number, followed by letters,
numbers, underscores, or hyphens, up to 64 characters. Names are case-sensitive.

In an interactive terminal, `bun run start` opens the TUI. When input or output is
redirected, the command without arguments prints help. `tui` requires a TTY and
returns an error in scripts; use `usage --json` instead.

## Command reference

The canonical form is `bun run start <command> [arguments]`. Commands also work
with `bun src/native-cli.ts <command>`. Script shortcuts are shown where available.

| Command | Shortcut | Purpose |
| --- | --- | --- |
| `help`, `--help`, `-h` | `bun run help` | Show help without accessing the vault or starting the backend. |
| `tui` | `bun run tui` | Open the interactive terminal account manager. |
| `add NAME [--device]` | — | Register a new account through official login, in an isolated home. |
| `capture NAME` | — | Save the current official file-based login. |
| `list` | — | Print saved account aliases, one per line. |
| `usage [NAME] [--json]` | `bun run usage` | Read fresh limits for one or all saved accounts. |
| `switch NAME` | `bun run switch NAME` | Switch the shared idle Codex session to a saved account. |
| `resume-after-reset on\|off` | `bun run resume-after-reset on` | Persist the independent reset-continuation preference. |
| `remove NAME` | `bun run remove NAME` | Delete an inactive account from this device. |
| `logout` | `bun run logout` | Sign out of the daemon without deleting saved accounts. |
| `panel` | `bun run panel` | Start the backend if needed and open its local browser panel. |
| `status` | `bun run status` | Print the private panel URL, or report that the backend is stopped. |
| `start` | `bun run start start` | Start the backend and print the private panel URL. |
| `restart` | `bun run restart` | Restart the plugin backend, preserving accounts and preferences. |
| `stop` | `bun run stop` | Stop the plugin backend; this does not stop the official daemon. |
| `install` | — | Register the built plugin and start the official daemon. Prefer `bun run setup` to build first. |

`<command> --help` shows the command overview. Invalid arguments and unknown
commands return a nonzero exit code. Quota windows that cannot be read are data
availability failures rather than a command failure: inspect `unavailable` and
null windows in JSON. `status` reports a stopped backend without starting it.

## Register accounts

Configure file-based authentication as described in the [README](../README.md#installation).
Then save the current login or add another one:

```bash
bun run start capture personal
bun run start add work
bun run start add secondary --device
bun run start list
```

Registration does not switch your current session. Existing aliases cannot be
overwritten; choose another name or remove the inactive saved account first.
`capture` reads the official login cache and never asks you to paste tokens.

## Read quotas

```bash
bun run usage
bun run usage work
bun run usage work --json
```

The text output identifies the current account and reports **remaining** capacity,
not used capacity. Reset timestamps are ISO 8601 in UTC. The browser panel formats
reset times in Brasilia time; the TUI shows time remaining until the reported reset.
An elapsed timestamp is not evidence that the service has restored capacity.

Illustrative output:

```text
work (current)
  5h: 40% remaining; resets 2026-11-12T18:00:00.000Z
  Weekly: 70% remaining; resets unknown
```

The JSON shape is the same for single-account and all-account queries:

```json
{
  "accounts": [
    {
      "name": "work",
      "current": true,
      "usage": {
        "fiveHour": { "remaining": 40, "resetsAt": 1794506400 },
        "weekly": { "remaining": 70, "resetsAt": null },
        "updatedAt": 1794502800000
      }
    }
  ]
}
```

`resetsAt` is Unix time in **seconds**, or `null`; `updatedAt` is Unix time in
**milliseconds**. Missing windows are `null`. A failed read sets `unavailable:
true` and both windows to `null`. Unknown capacity never qualifies an account for
automatic switching or continuation. An empty vault returns `{"accounts": []}`.
The response does not include emails, authentication tokens, or the private panel URL.

Reads for inactive accounts use isolated official App Server helpers. They do not
switch the live session or make inference requests. Large vaults may take longer
because quota reads are sequential.

## Switch and sign out

```bash
bun run switch work
bun run logout
bun run switch personal
bun run remove secondary
```

Switching and logout affect all conversations sharing the official daemon. They
are rejected while any loaded turn is active. Finish or stop those turns in Codex
and retry. Manual switching preserves history but does not start a new turn: send
`continue` yourself in the original conversation when ready.

An active account cannot be removed. Switch to another account or log out first.
Removal deletes only that alias's local credentials and uploaded profile image;
it does not delete the remote account or conversation history.

## Terminal interface

```bash
bun run tui
```

The active account is marked `* current`. Quota bars fill with **remaining**
capacity. Select a row with Up/Down or j/k; selection wraps and scrolls as needed.
The interface uses your terminal colors rather than imposing a separate theme.
Resize the terminal to see both quota windows together on wider screens.

| Key | Result |
| --- | --- |
| Enter | Ask to switch to the selected account; y confirms, any other key cancels. |
| r | Refresh all quotas immediately. |
| a | Toggle `autoSwitch`. |
| c | Toggle `autoContinue`. |
| w | Toggle `resumeAfterReset`. |
| n | Enter a new alias and start official device login. |
| s | Enter an alias and capture the current official login. |
| d | Ask to remove the selected account; y confirms. |
| l | Ask to log out; y confirms. |
| Esc | Cancel a name prompt or confirmation; exit from the main view. |
| q / Ctrl+C | Exit the main view / exit the manager. |

Quotas refresh on entry, on r, and every 30 seconds while the manager is idle and
no prompt is open. The manager does not submit overlapping UI actions. Backend
locks still protect concurrent operations from other terminals or the browser.
Device login temporarily leaves raw mode and the alternate screen so the official
login flow owns input. The TUI restores the cursor, terminal mode, and previous
screen when it exits. Closing the TUI leaves the backend running.

## Automation

```bash
bun run resume-after-reset on
bun run resume-after-reset off
```

Use the TUI's a/c/w keys or the browser preferences to configure the three
independent settings. Turning on reset continuation does not enable autoswitch.
See [Automatic behavior and recovery](automation.md) for timing and eligibility.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| TUI requires an interactive terminal | Open it in a terminal; use `usage --json` for redirected input/output. |
| Unknown command or invalid arguments | Run `bun run help`; include an account alias where required. |
| Account not registered | Run `bun run start list`, then register the intended alias. |
| Quotas unavailable | Check official login and daemon connectivity; refresh with r or `bun run usage NAME`. Never replace unknown quotas with zero in scripts. |
| Turn still active | Wait for all daemon conversations to finish, then retry switching or logout. |
| Backend unavailable or old commands unsupported | Run `bun run restart` after updating; reopen the TUI. |
| Panel link no longer works | Backend restarts rotate its private address; run `bun run panel`. |
| Authentication refresh stopped after a backend restart | Select the saved account again after turns are idle to restore backend-owned refresh handling. |
| Temporary daemon cannot be installed | Choose a short, writable `TMPDIR` with enough free space; integration tests install isolated daemons. |
| Lock remains after a crash | Confirm no manager process owns the vault before removing a stale lock. Do not remove a live lock. |

Treat `status` output and panel links as private. Do not paste authentication files,
private panel URLs, or account emails into issues. Report vulnerabilities using
[SECURITY.md](../SECURITY.md).

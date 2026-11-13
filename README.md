# Codex Accounts

[![Test suite](https://github.com/eduardoaugustolb/codex-accounts/actions/workflows/ci.yml/badge.svg)](https://github.com/eduardoaugustolb/codex-accounts/actions/workflows/ci.yml) [![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Manage ChatGPT accounts in the **official Codex CLI** through a terminal interface,
a browser panel, or direct commands. Switch accounts, inspect quota windows, and
optionally resume conversations after switching or quota recovery.

This is a Codex-focused adaptation of [SrDarf/claude-accounts](https://github.com/SrDarf/claude-accounts),
with its own Bun implementation and official Codex daemon integration. Start
Codex normally with `codex`; the plugin does not replace its binary with a wrapper,
alias, or launcher. Live authentication switching remains experimental.

Quick links: [Installation](#installation) · [Terminal interface](#terminal-interface-and-cli) · [Command reference](docs/cli.md) · [Automation](docs/automation.md) · [Validation](docs/validation-2026-11-12.md).

The plugin provides four hooks (`SessionStart`, `PostModelRequest`, `Stop`, and `Interrupt`). A local backend manages confirmation and authentication through the official daemon's Unix socket. No skill, MCP server, or instructions about the account manager are sent to the model.

## Installation

Tested requirements: Linux, Bun 1.4.4, and Codex CLI 0.167.2. Authentication uses an experimental RPC; other versions require verification. Browser launching is implemented for macOS but has not been tested. Windows is not supported by this prototype.

The prototype requires file-based authentication. Set the following in `~/.codex/config.toml`:

```toml
cli_auth_credentials_store = "file"
```

If you previously used the keyring, sign in again through the official login flow in this mode before using the plugin. The installer does not change this setting or extract credentials from the keyring.

From the project directory:

```bash
bun install
bun run setup
```

Setup builds the package into `marketplace/plugin/bin`, registers the local marketplace, installs the plugin with the official command, and starts the official daemon. It does not modify the binary or configure aliases.

Open `codex`, enter `/hooks`, and review and trust **all four Codex Accounts hooks**. Then start a new conversation. Trust is tied to the plugin contents, so an update may require another review. Do not use `--dangerously-bypass-hook-trust`: this option disables daemon reuse in Codex 0.167.2.

## Adding accounts

Save the current file-based ChatGPT login:

```bash
bun run start capture personal
```

Add another account through the official login flow in an isolated temporary directory:

```bash
bun run start add work
# Alternatively, use a device code:
bun run start add secondary --device
bun run start list
```

Adding an account does not switch the current session. Select the intended account in the browser for each login. Account names accept letters, numbers, `_`, and `-`, up to 64 characters.

Then open any project and run the official binary:

```bash
codex
```

## Account details and removal

The panel displays a profile picture when one is available in the login data. Because App Server does not provide a profile picture endpoint, the panel also lets you upload a local PNG, JPEG, or WebP image up to 2 MB. The local image is deleted when you remove the account.

Each account's usage refresh action calls the official `account/rateLimits/read` RPC without switching the shared session. The panel displays the **five-hour** and **weekly** windows, remaining percentages, reset times in Brasilia time, and the last refresh time. Missing windows and failed requests appear as unavailable. Values remain in memory until the next refresh or backend restart. These are the account's Codex limits reported by the service, not general ChatGPT limits.

To remove an individual saved account:

```bash
bun run remove secondary
# Equivalent:
bun run start remove secondary
```

In the panel, expand the account's removal action and confirm it. This deletes that account's local credentials; add the account again to use it later. The active account is protected: sign out or switch to another account before removing it. Other accounts and conversation history are preserved.

## Terminal interface and CLI

Open the interactive account manager:

```bash
bun run tui
# With an interactive terminal, this also opens the TUI:
bun run start
```

Select an account with **Up/Down** or **j/k**. The screen shows the active account,
five-hour and weekly **remaining** capacity, and relative reset times. Press
**Enter**, then **y**, to switch the shared session. The TUI follows the terminal's
default foreground and background colors, using bold headings, dim details, and
reverse-video selection so it fits light and dark Codex terminal themes.

| Key | Action |
| --- | --- |
| Up/Down or j/k | Select an account |
| Enter | Confirm an account switch with y |
| r | Refresh all account quotas |
| a | Toggle automatic switching |
| c | Toggle continuation after autoswitch |
| w | Toggle continuation after quota recovery |
| n | Add an account using official device login |
| s | Capture the current official login under a new name |
| d | Remove the selected account, after confirmation |
| l | Sign out of the shared session, after confirmation |
| q, Esc, Ctrl+C | Exit; Esc cancels an open prompt first |

The backend keeps running when the TUI closes. Login temporarily returns control
to the terminal; the manager restores its screen afterward. No wrapper or
keystrokes are sent to the official Codex terminal.

For scripts or direct commands:

```bash
bun run help
bun run usage                     # Fresh quotas for every saved account
bun run usage work                # Fresh quotas for one account
bun run usage work --json         # Machine-readable quotas
bun run switch personal           # Switch the shared session
bun run resume-after-reset on     # Resume quota-failed conversations when capacity returns
bun run resume-after-reset off
```

All commands, arguments, output formats, and recovery steps are documented in the
[CLI and TUI guide](docs/cli.md). Use the local account aliases assigned with
`add` or `capture`; they are not email addresses.

## Automatic switching and continuation

All three preferences are **off by default** and persisted in the private vault.
Configure them in the TUI or the browser panel's **Preferências** section.

| Preference | TUI | Behavior |
| --- | --- | --- |
| `autoSwitch` | a | Switch to another identity with confirmed capacity in both windows when quota is exhausted. |
| `autoContinue` | c | After autoswitch, send `continue` to conversations interrupted by quota. Requires `autoSwitch`. |
| `resumeAfterReset` | w | Resume quota-failed conversations on the current saved account once both quotas have capacity. Independent of autoswitch. |

For reset continuation, the backend checks authoritative quotas every 30 seconds
and after relevant daemon notifications. This covers five-hour resets, weekly
resets, and early recovery from a reset token redeemed outside the plugin. A
weekly reset alone does not resume a conversation while its five-hour quota is
still exhausted. An advertised reset timestamp is never treated as proof that
capacity is available.

Only loaded, non-ephemeral conversations whose latest turn failed because of
quota are eligible. Active or superseded turns are skipped. The original history
and CLI process stay in place. Uncertain submissions are not retried; reset
continuation records a durable claim before sending the request.

See [Automatic behavior and recovery](docs/automation.md) for eligibility,
scheduling, persistence, safety rules, and examples of interacting preferences.

## Browser panel and backend lifecycle

```bash
bun run panel     # Start the backend if needed and open the panel
bun run status    # Show its private local address, or stopped status
bun run restart   # Restart the plugin backend and generate a new panel address
bun run stop
bun run logout    # Sign out, keeping saved accounts
```

With automatic switching and reset continuation disabled, a detected quota failure
opens the local panel. Choose an account, wait for all connected turns to finish,
and switch. Return to the same Codex conversation and send `continue` yourself.
Manual switches never start turns. The TUI offers the same backend operations.
There is no `/accounts` slash command.

Switching and logout affect **every conversation connected to the shared daemon**.
They return an error while a loaded turn is active. The backend's autoswitch loop
waits and checks again instead of interrupting it.

While the browser is focused, the panel uses SSE and periodic local state checks;
external quota reads are throttled to 30 seconds without new events. The browser
pauses its own connections when it loses focus. Hook monitoring, authentication
refresh, and enabled reset continuation keep running without an open panel.

To update an installation, run `bun run setup`, review all four hooks in `/hooks`,
and start a new conversation. Then run `bun run restart` and reopen the panel or
TUI. Restarting the backend changes the panel's private URL. If the previous
backend owned external authentication, select the saved account again to restore
refresh handling.

## Storage and limitations

- Vault: `~/.local/share/codex-accounts/accounts/NAME/auth.json`, or `CODEX_ACCOUNTS_HOME`. Credentials use `0600` files inside `0700` directories.
- The backend keeps the connection that handles external token refresh requests. It uses a separate official App Server to refresh saved account credentials and stores the updated refresh token.
- The panel listens only on `127.0.0.1`, with a random address per run, origin checks, and CSRF-protected forms. IPC uses a Unix socket in a private temporary directory.
- The backend runs in the background. `bun run stop` stops it; `bun run panel` starts it again. Stopping it while external authentication is active interrupts token refresh handling. After restarting the backend, select the account again in the panel to restore that handling. Restarting the daemon or CLI returns managed authentication to Codex.
- The connection requires the shared Codex daemon. `--no-daemon`, `--strict-config`, certain `-c` options, and remote sessions may select another server and are not supported by this prototype. If necessary, run `codex app-server daemon start` before opening the CLI.
- There is no automatic restart fallback for incompatible versions: the operation fails and keeps or restores the previous cache. The prototype does not use signals or keyboard injection to restart your terminal.
- Hooks detect errors described as usage limits, not percentage warnings or generic HTTP 429 responses. Because `PostModelRequest` supplies error text, changes to that text may require an update.
- Live account switching is experimental. Authentication with two real subscriptions and real quota consumption have not been tested. Tests use the real Codex binary, two fake identities, and a local inference server.

## Reproducible verification

```bash
bun run test:all
```

One command runs ten stages: type checking, unit tests, build, the terminal UI with a fake client, authentication, the CLI with manual switching, autoswitch without continuation, autoswitch with continuation, early/token reset continuation, and weekly reset waiting for 5-hour capacity. The suite stops on the first failure and also runs in GitHub Actions on pushes to `main` and pull requests. Use `bun test` for a quick feedback loop. Individual scripts remain available for troubleshooting.

Integration scenarios open sockets and a pseudoterminal, install the plugin in a temporary `CODEX_HOME`, and stop only their own processes. They do not authenticate real accounts or call external models. They require permission to open local sockets. `KEEP_CASE=1` preserves temporary artifacts when running an individual scenario for inspection.

The native CLI scenario verifies launch through the official binary without `--remote`, quota failure, confirmation, switching in the same window and conversation, preserved context, and the absence of account manager instructions in model input. A separate diagnostic demonstrates why replacing only `auth.json` does not update authentication held in memory.

Upstream attribution: the account-selector workflow is inspired by [SrDarf/claude-accounts](https://github.com/SrDarf/claude-accounts). This adaptation targets Codex; upstream targets Claude Code. Their credential reload mechanisms and integrations differ. The upstream and adaptation copyrights are retained in [LICENSE](LICENSE).

Sources: [Hooks](https://learn.chatgpt.com/docs/hooks), [App Server](https://developers.openai.com/codex/app-server/), and [Plugins](https://developers.openai.com/plugins/build/plugins).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and [SECURITY.md](SECURITY.md) for private vulnerability reports. Licensed under [MIT](LICENSE). This is an independent project, not an official OpenAI product.

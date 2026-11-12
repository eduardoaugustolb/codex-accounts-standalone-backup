# Codex Accounts

[![Test suite](https://github.com/eduardoaugustolb/codex-accounts/actions/workflows/ci.yml/badge.svg)](https://github.com/eduardoaugustolb/codex-accounts/actions/workflows/ci.yml) [![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An experimental plugin for switching ChatGPT accounts in the **official Codex CLI**, with local confirmation or optional automatic switching when a quota is exhausted. Start Codex normally with `codex`; the plugin does not replace the binary with a wrapper, alias, or launcher.

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

## When a quota is exhausted

1. The hook receives the failed request and notifies the backend without querying the model.
2. The browser opens a local panel offering an account switch. With automatic switching disabled, you must select an account to confirm the switch.
3. The backend verifies that all turns connected to the daemon have stopped, preserves the current credentials, and applies the selected account through RPC.
4. Return to the same terminal and send `continue` whenever you are ready. If automatic continuation (`autoContinue`) is enabled in preferences, autoswitch sends `continue` in the same conversation after switching accounts.

Switching affects every conversation connected to the same App Server. History stays in the original `CODEX_HOME`; subsequent requests use the selected account's identity and policies. The CLI window and conversation do not need to restart in the tested scenario.

To open the panel manually without involving the model:

```bash
bun run start panel
```

This command can run in another terminal and starts the backend automatically, even after `stop`. Existing accounts do not need to be added again. `bun run start status` displays the local address or reports that the backend is stopped. There is no `/accounts` slash command: integration uses hooks without skill prompts.

```bash
bun run panel     # Start the backend if needed and open the panel
bun run status
bun run restart   # Restart only the plugin backend and print its new address
bun run stop
bun run logout    # Sign out of the shared Codex session, keeping saved accounts
```

The commands `bun run start start`, `bun run start restart`, and `bun run start logout` are also available. The panel includes a sign-out confirmation. Signing out and switching accounts require every daemon turn to be stopped. After signing out, select a saved account in the panel to sign in again. Sign-out uses the official [`account/logout`](https://learn.chatgpt.com/docs/app-server#5-logout) RPC.

## Automatic switching and live updates

Enable automatic account switching (`autoSwitch`) in preferences and save. It is disabled by default and stored in the vault's `settings.json`. When the five-hour or weekly quota is exhausted, or a hook reports a quota failure, the backend waits for all turns to stop and checks other accounts in alphabetical order. It switches to the first different identity with confirmed remaining capacity in both windows. Automatic mode does not open the browser. If no eligible account is available, it keeps the session and displays the reason in the panel. Switching affects all connected conversations.

Automatic continuation (`autoContinue`) is also disabled by default and saved in `settings.json`. When enabled together with autoswitch, it sends `continue` to loaded conversations whose latest turn failed because of a quota, preserving history. The backend checks the turn again after login and skips conversations that have changed or are active. Manual switches and preventive switches without a quota failure do not start turns. If submission cannot be confirmed, the panel reports the issue and the backend does not automatically retry the submission.

`SessionStart` starts the backend without opening the browser. Hooks must be installed, enabled, and trusted in `/hooks`. `PostModelRequest`, `Stop`, and `Interrupt`, together with App Server notifications, signal changes and trigger quota checks. The browser opens through `bun run panel` or, in manual mode, when a hook detects an exhausted quota.

While the browser tab is visible and focused, the panel receives SSE events and checks local state every three seconds. External quotas for all accounts are queried when focus returns, after relevant events, and at most once every 30 seconds without events. Updates reflect the service's available data and are not a guarantee of instant changes from external sources. When the tab loses focus, the browser closes SSE, cancels its request, and stops timers. When focus returns, it reconnects and requests fresh data. An external query already running on the server may still finish. Open confirmations and selected upload files are preserved. Hook monitoring and authentication refresh continue without the panel.

To update an existing installation, run `bun run setup`, review all four hooks in `/hooks`, and start a new conversation. Then use `bun run restart` and `bun run panel` to load the updated backend. Restarting the backend generates a new address; reopen old panel tabs with `bun run panel`.

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

One command runs seven stages: type checking, unit tests, build, authentication, the CLI with manual switching, autoswitch without continuation, and autoswitch with continuation. The suite stops on the first failure and also runs in GitHub Actions on pushes to `main` and pull requests. Use `bun test` for a quick feedback loop. Individual scripts remain available for troubleshooting.

Integration scenarios open sockets and a pseudoterminal, install the plugin in a temporary `CODEX_HOME`, and stop only their own processes. They do not authenticate real accounts or call external models. They require permission to open local sockets. `KEEP_CASE=1` preserves temporary artifacts when running an individual scenario for inspection.

The native CLI scenario verifies launch through the official binary without `--remote`, quota failure, confirmation, switching in the same window and conversation, preserved context, and the absence of account manager instructions in model input. A separate diagnostic demonstrates why replacing only `auth.json` does not update authentication held in memory.

Sources: [Hooks](https://learn.chatgpt.com/docs/hooks), [App Server](https://developers.openai.com/codex/app-server/), and [Plugins](https://developers.openai.com/plugins/build/plugins). Comparison reference: [SrDarf/claude-accounts](https://github.com/SrDarf/claude-accounts). The products use different credential reload mechanisms.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and [SECURITY.md](SECURITY.md) for private vulnerability reports. Licensed under [MIT](LICENSE). This is an independent project, not an official OpenAI product.

# Agent instructions

## Runtime

Always use **Bun** as the runtime and package manager: `bun install`, `bun run <script>`, `bun <file>`, and `bunx --bun <package>`. Do not use npm, npx, or Node to run this project. Do not create `package-lock.json`; update `bun.lock` when dependencies change.

## Project map

- `src/native-backend.ts`: local HTTP panel, Unix IPC, quota monitoring, and account switching.
- `src/auto-continue.ts`: detection of quota-interrupted turns and continuation in the same conversation.
- `src/native-cli.ts`: commands, installation, and backend lifecycle.
- `src/tui.ts`: terminal account selector, quota display, confirmations, and terminal restoration.
- `src/native-hook.ts`: forwarding of the four hook events.
- `src/rpc.ts`: communication with the official App Server and isolated helpers.
- `src/store.ts`: vault, permissions, locks, and credential persistence.
- `src/account-panel.ts`, `src/panel-live.ts`, `src/panel-navigation.ts`: local interface.
- `test/`: unit tests using `bun:test`.
- `tools/test-suite.ts`: complete sequential test suite.
- `tools/*-case.ts`: isolated integrations with the official binary and fake services.
- `marketplace/`: manifest, hooks, and compiled executables distributed with the plugin.

## Development and validation

```bash
bun install --frozen-lockfile
bun run test:all
```

The complete suite checks types, unit tests, build, authentication, manual switching, and autoswitch with and without continuation, terminal interaction, and quota-reset continuation. Run it before publishing changes to authentication, hooks, RPC, or lifecycle behavior. For small changes, start with `bun test` and `bun run check`; before publishing, complete validation appropriate to the scope. Do not hide failing tests or report integrations as passing without running them.

Validated requirements: Linux, Bun 1.4.4, and Codex CLI 0.167.2. Integrations require local sockets, a pseudoterminal, and space for a temporary daemon. Use `CODEX_ACCOUNTS_CODEX` to select a binary. If setting `TMPDIR`, choose a short path with enough space. Prefer the suite for routine validation; run individual scenarios only to investigate failures.

When changing `src/`, regenerate `marketplace/plugin/bin` with `bun run build` and include updated artifacts. Do not edit bundles manually. Update the README and validation documentation when behavior or preferences change.

## Authentication and security

- Never read or expose real tokens for debugging. Do not include `auth.json`, cookies, personal email addresses, private conversations, or secret panel URLs in commits, logs, or issues.
- Tests must use temporary `CODEX_HOME` and vault directories, fake identities, and local endpoints. Do not use real accounts or consume external quotas to validate the plugin.
- Preserve `0700` directories, `0600` credentials, atomic writes, and mutation locks. Do not weaken identity, origin, CSRF, or path validation.
- Switching affects all conversations connected to the daemon. Wait for all active turns to finish before switching accounts or signing out.
- Preserve the official binary, conversation history, and CLI process. Do not introduce wrappers, aliases, forced restarts, or keyboard injection as production fallbacks.
- App Server is shared. Do not answer approvals owned by the native client; handle only authentication requests owned by the backend.
- Automatic continuation is opt-in, applies to autoswitch or confirmed quota recovery, and continues only quota failures. Reset continuation requires confirmed capacity in both windows and a durable claim before submission. Ignore ephemeral threads and active or superseded turns. Do not retry `turn/start` after a timeout without knowing whether the server accepted it.
- A continuation failure after login must not trigger a second account switch. Report the state in the panel.
- See `SECURITY.md` for vulnerability reporting.

## Documentation and Git

Keep Markdown documentation and repository metadata in US English (`en-US`).

For questions about libraries, SDKs, or services, consult current documentation through Context7: first `bunx --bun ctx7@latest library <name> "<question>"`, then `bunx --bun ctx7@latest docs /org/project "<question>"`. Never include secrets in queries.

Write clear commit messages, preferably using Conventional Commits. Do not publish personal configuration, `.env` files, `node_modules`, temporary directories, or test artifacts. Preserve other contributors' existing changes. Do not force-push or remove history without explicit authorization.

## Terminal interface

Use the terminal's default foreground and background, with bold headings, dim
metadata, and reverse-video selection. Do not introduce a fixed accent palette.
Restore raw mode, cursor visibility, and the alternate screen on every exit.
Sanitize account labels and backend messages before rendering terminal output.
Use private backend IPC for actions; never send keystrokes to the official CLI.

# Contributing

Use Bun as the runtime and package manager. The validated environment uses Linux, Bun 1.4.4, and Codex CLI 0.167.2.

```bash
bun install --frozen-lockfile
bun run test:all
```

The suite runs type checking, unit tests, build, and integrations with the official CLI, including the terminal UI, manual switching, autoswitch with continuation enabled and disabled, early/token reset continuation, and weekly reset waiting for five-hour capacity. It requires the `codex` binary on `PATH`, local sockets, a pseudoterminal, and space for temporary daemon installations. `CODEX_ACCOUNTS_CODEX` selects another binary. `TMPDIR` selects a temporary directory with available space; keep the path short because of Unix socket limits.

Scenarios isolate `CODEX_HOME`, use fake accounts, and stop their processes when finished. The suite stops at the first failed stage. Use `bun test` for a quick unit test feedback loop. Individual scripts remain available for troubleshooting a stage.

Open an issue describing the expected behavior and reproduction steps before making large changes. In pull requests, explain the problem, change, and validation. Protocol changes should include a reproducible test and the CLI version used. Update documentation when changing preferences or behavior. Keep Markdown documentation and repository metadata in US English (`en-US`).

Do not include credentials, personal configuration directories, or test artifacts. Follow [SECURITY.md](SECURITY.md) for vulnerabilities.


## Source map and documentation

- `src/tui.ts`: interactive terminal view and input lifecycle; backend operations
  go through the same private IPC as the CLI. Restore raw mode, cursor visibility,
  and the alternate screen on every exit path.
- `src/native-cli.ts`: command parsing, help, lifecycle, and terminal entry point.
- `src/native-backend.ts`: shared daemon integration, quotas, preferences, and jobs.
- `docs/cli.md`: user-facing command reference and terminal shortcuts.
- `docs/automation.md`: automation settings, scheduling, eligibility, and recovery.
- `docs/validation-2026-11-12.md`: tested environment and reproducible evidence.

The terminal theme inherits the user's foreground and background. Use bold, dim,
and reverse video instead of a fixed accent or background palette. Keep terminal
control characters out of account labels and service messages.

When changing `src/`, run `bun run build` and commit the generated files in
`marketplace/plugin/bin`. Validate behavioral changes with `bun run test:all`.
Keep the upstream fork history and MIT attribution; configure `upstream` to point
to `https://github.com/SrDarf/claude-accounts.git` when working with the source fork.

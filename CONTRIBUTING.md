# Contributing

Use Bun as the runtime and package manager. The validated environment uses Linux, Bun 1.4.4, and Codex CLI 0.167.2.

```bash
bun install --frozen-lockfile
bun run test:all
```

The suite runs type checking, unit tests, build, and integrations with the official CLI, including manual switching and autoswitch with continuation enabled and disabled. It requires the `codex` binary on `PATH`, local sockets, a pseudoterminal, and space for temporary daemon installations. `CODEX_ACCOUNTS_CODEX` selects another binary. `TMPDIR` selects a temporary directory with available space; keep the path short because of Unix socket limits.

Scenarios isolate `CODEX_HOME`, use fake accounts, and stop their processes when finished. The suite stops at the first failed stage. Use `bun test` for a quick unit test feedback loop. Individual scripts remain available for troubleshooting a stage.

Open an issue describing the expected behavior and reproduction steps before making large changes. In pull requests, explain the problem, change, and validation. Protocol changes should include a reproducible test and the CLI version used. Update documentation when changing preferences or behavior. Keep Markdown documentation and repository metadata in US English (`en-US`).

Do not include credentials, personal configuration directories, or test artifacts. Follow [SECURITY.md](SECURITY.md) for vulnerabilities.

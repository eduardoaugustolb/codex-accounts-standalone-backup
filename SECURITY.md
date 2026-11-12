# Security policy

## Supported versions

Security fixes are applied to the latest version on the `main` branch. This project is experimental; verify compatibility with your Codex version before updating.

## Reporting a vulnerability

Use [Report a vulnerability](https://github.com/eduardoaugustolb/codex-accounts/security/advisories/new) to submit a private report. Do not disclose authentication or credential vulnerabilities in public issues. If the form is unavailable, request a private channel in an issue without including exploitable technical details.

Include the plugin, Bun, and Codex versions, operating system, reproducible steps using fake data, impact, and any suggested fix. Remove tokens, cookies, email addresses, conversation content, sensitive paths, and private panel URLs. Do not submit `auth.json` files.

This project is maintained by volunteers and does not promise response times or rewards.

## Security model

- Credentials are stored locally in `0600` files and `0700` directories. There is no additional encryption at rest: protect your operating system account and backups.
- The HTTP panel binds to loopback, with a random URL per run, origin checks, and CSRF-protected forms. The URL contains an access secret; do not share it.
- IPC uses a Unix socket in a private directory. A process with the same user privileges can access your credentials and session.
- Account switching affects all conversations connected to the daemon. Automatic continuation is optional and starts a model request using the new account.
- The plugin uses the official login flow and an experimental RPC. It does not collect credentials in its own remote service or remove account limits or policies.
- Tests use fake identities and local services. No test should require real accounts or tokens.

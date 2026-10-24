# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue. Either:

- use **Report a vulnerability** under this repository's
  [Security tab](https://github.com/usehyperodds/hyperodds-mcp/security/advisories/new), or
- email security@usehyperodds.com.

Include what you found, how to reproduce it and what an attacker could do with it. We aim to
reply within three working days, keep you updated while we fix it, and credit you in the advisory
unless you would rather we did not.

## Scope

- This package, `@hyperodds/mcp`.
- The hosted MCP endpoint it talks to, `https://api.usehyperodds.com/mcp`.

Report problems in the console at usehyperodds.com the same way. Issues in Hyperliquid,
Polymarket, Kalshi or other third parties belong with them.

## Supported versions

Fixes go into the latest release. Upgrade with `npx -y @hyperodds/mcp@latest`, or let `npx` pick
up the new version the next time the client starts it.

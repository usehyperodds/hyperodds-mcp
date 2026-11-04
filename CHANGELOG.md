# Changelog

Notable changes to `@hyperodds/mcp`, newest first. Versions follow
[Semantic Versioning](https://semver.org/).

## [0.1.1] - 2026-11-04

### Changed

- Published from GitHub Actions with npm provenance, so the package on npm links to the commit and
  workflow that built it.
- The README and the package description say what this is: a bridge to the hosted Hyperodds MCP
  server, where the tools and their data run.

## [0.1.0] - 2026-10-25

### Added

- A stdio MCP server for `npx -y @hyperodds/mcp` that forwards to the hosted Hyperodds server over
  Streamable HTTP.
- A request that fails or gets no answer within 30 seconds gets a JSON-RPC error naming the cause.
- A batch goes out one message at a time, and a cancelled request is dropped.
- Messages split at newlines only, so U+2028 and U+2029 inside strings arrive intact.
- When `HYPERODDS_MCP_URL` points elsewhere, errors name that URL.
- Closing stdin, the protocol's way to stop a server, drops what is in flight and exits.

[0.1.1]: https://github.com/usehyperodds/hyperodds-mcp/releases/tag/v0.1.1
[0.1.0]: https://github.com/usehyperodds/hyperodds-mcp/releases/tag/v0.1.0

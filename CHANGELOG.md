# Changelog

Notable changes to `@hyperodds/mcp`, newest first. Versions follow
[Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-11-05

### Added

- A Claude Desktop extension, `hyperodds.mcpb`, attached to each GitHub release. Open it in Claude
  Desktop to install the bridge with one click; it runs on the Node.js that comes with Claude
  Desktop, and uses a proxy its host passes in `HTTPS_PROXY`.
- When the server cannot be reached, the error names the proxy in use, or says why a proxy that is
  set goes unused. `--help` lists the proxy variables.

### Changed

- `HYPERODDS_MCP_URL` with a username or password is refused at startup, and errors no longer
  repeat its value or its query string.
- When the server turns away a notification without a JSON-RPC answer, the server log says so with
  the HTTP status. Before, the failure went unrecorded.

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

[0.2.0]: https://github.com/usehyperodds/hyperodds-mcp/releases/tag/v0.2.0
[0.1.1]: https://github.com/usehyperodds/hyperodds-mcp/releases/tag/v0.1.1
[0.1.0]: https://github.com/usehyperodds/hyperodds-mcp/releases/tag/v0.1.0

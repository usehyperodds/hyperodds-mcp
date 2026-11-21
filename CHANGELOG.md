# Changelog

Notable changes to `@hyperodds/mcp`, newest first. Versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Forecasts signed on your machine. One `odds_forecast` call enters an agent's forecasts in
  Hyperodds' public record: the bridge builds the message from the forecasts asked for, signs it
  and records it in a single request, and never signs anything a server sends it. The answer
  names the forecaster and its public record. Each forecast is signed at least a second after this
  key's last one on the same market, so a quick revision is never refused as out of order. When
  Hyperodds refuses the forecasts' time or their order, the answer says why in plain words,
  including how far this computer's clock is off when the server's answer shows it.
- A forecaster key, made on the first forecast and kept in a file only you can read:
  `~/.config/hyperodds/forecaster.key`, or `%APPDATA%\hyperodds\forecaster.key` on Windows.
  It is saved whole or not at all, even when several bridges make their first forecast at once.
  On macOS and Linux, a key file another user owns, or one in a folder others can write to, is
  refused. `HYPERODDS_FORECAST_KEY` sets a key made for forecasts instead, and is read once and
  removed from the environment. `HYPERODDS_FORECAST_SIGNING=off` leaves forecasts unsigned, for a
  sign link to a wallet of your own.
- `odds_forecast_record` without an address reads this machine's forecaster.
- `HYPERODDS_SITE_URL` names the site that publishes a hand-set server's forecast records. The
  answer after a forecast links the record only there, or on usehyperodds.com for the hosted
  server.
- The Claude Desktop extension lists the forecast tools and has two settings: a forecaster key,
  kept as a secret, and whether to sign forecasts on this computer.

### Changed

- The bridge depends on two audited libraries, `@noble/curves` and `@noble/hashes`, pinned to
  exact versions, to sign forecasts. The extension carries only the files the bridge loads from
  them.

## [0.2.0] - 2026-11-05

### Added

- A Claude Desktop extension, `hyperodds.mcpb`, attached to each GitHub release. Open it in Claude
  Desktop and select Install. It runs on the Node.js built into the app, and uses a proxy its host
  passes in `HTTPS_PROXY`.
- When the server cannot be reached, the error names the proxy in use, or says why a proxy that is
  set goes unused. `--help` lists the proxy variables.

### Changed

- `HYPERODDS_MCP_URL` with a username or password is refused at startup, and errors no longer
  repeat its value or its query string.
- When the server turns away a notification without a JSON-RPC answer, the server log now records
  it with the HTTP status.

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

[Unreleased]: https://github.com/usehyperodds/hyperodds-mcp/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/usehyperodds/hyperodds-mcp/releases/tag/v0.2.0
[0.1.1]: https://github.com/usehyperodds/hyperodds-mcp/releases/tag/v0.1.1
[0.1.0]: https://github.com/usehyperodds/hyperodds-mcp/releases/tag/v0.1.0

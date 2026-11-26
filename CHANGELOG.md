# Changelog

Notable changes to `@hyperodds/mcp`, newest first. Versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- The bridge no longer follows redirects. A reply that redirects is an error naming its HTTP
  status, so a redirect can't move a message to plain http or another server, or turn it into a
  GET.
- The bridge answers requests from the server itself and passes none of them to the client: a
  `ping` gets an empty answer, and anything else, such as `sampling/createMessage`,
  `elicitation/create` or `roots/list`, a method-not-found error. It also removes the `roots`,
  `sampling`, `elicitation` and `tasks` capabilities from the client's `initialize`. Before, a
  server could ask the client's model for text, the person for input or the client for its folders.

## [0.2.3] - 2026-11-26

### Changed

- On macOS and Linux, the bridge refuses a forecaster key file that is a link, and a key folder
  another user owns, and says how to fix it. Before, it followed the link, and a link that pointed
  nowhere read as no key at all, so forecasts went to the server unsigned, for a sign link.
- On macOS and Linux, the bridge also refuses a forecaster key file that other users can read or
  change, or that has more than one hard link, and a key folder, or the config folder above it
  (`~/.config` or `$XDG_CONFIG_HOME`), that is a link. Before, it only warned about a key others
  could read, and it used a linked folder wherever the link led. A key the bridge made is already
  readable only by you. For a key you copied in, the message gives the fix, usually `chmod 600`.
- `HYPERODDS_MCP_URL` takes plain http only for a server on this computer (`localhost`,
  `127.x.x.x` or `[::1]`); any other server must be https. Over plain http, anyone on the network
  path could read signed forecasts before their market's cutoff and change the answers your agent
  sees.

## [0.2.2] - 2026-11-25

### Changed

- The extension's manifest and the README list `search` and `fetch`, the two tools the hosted
  server added for clients that look a market up from the words of a question. The bridge already
  passed them through; Claude Desktop's install dialog now names all nine tools.

## [0.2.1] - 2026-11-23

### Changed

- Signing on your machine refuses what the hosted server refuses since version 2 of the forecast
  record's spec: an `odds_forecast` argument it doesn't take (a misspelt `forecaster`, say), and a
  key in a forecast other than `outcome` and `probabilityBps`. Each comes back as an
  `invalid_request` refusal naming what was wrong, before any key is read or made, and nothing is
  sent. Before, those keys were dropped, so a misspelt `forecaster` signed here what was meant for
  another wallet.

## [0.2.0] - 2026-11-22

### Added

- A Claude Desktop extension, `hyperodds.mcpb`, attached to each GitHub release. Open it in Claude
  Desktop and select Install. It runs on the Node.js built into the app, and uses a proxy its host
  passes in `HTTPS_PROXY`.
- When the server cannot be reached, the error names the proxy in use, or says why a proxy that is
  set goes unused. `--help` lists the proxy variables.
- Forecasts signed on your machine. One `odds_forecast` call signs an agent's forecasts and enters
  them in Hyperodds' public record, in a single request. The bridge builds each message itself
  from the forecasts asked for, and never signs anything a server sends it. The answer names the
  forecaster and its public record. Each forecast is signed at least a second after this
  key's last one on the same market, so a quick revision still counts. When Hyperodds refuses
  forecasts over their signed time or order, the answer says why, and how far your clock is off
  when the server's reply shows it.
- A forecaster key, made on the first forecast and kept in a file only you can read:
  `~/.config/hyperodds/forecaster.key`, or `%APPDATA%\hyperodds\forecaster.key` on Windows.
  It is saved whole or not at all, even when several bridges make their first forecast at once.
  On macOS and Linux, a key file another user owns, or one in a folder others can write to, is
  refused. `HYPERODDS_FORECAST_KEY` overrides the file with a key made for forecasts; the bridge
  reads it once and removes it from the environment. `HYPERODDS_FORECAST_SIGNING=off` leaves
  forecasts unsigned, for a sign link to a wallet of your own.
- `odds_forecast_record` without an address reads your own forecaster.
- `HYPERODDS_SITE_URL` names the site that publishes forecast records for a server set in
  `HYPERODDS_MCP_URL`. The answer after a forecast links the record only on that site, or on
  usehyperodds.com with the hosted server.
- The Claude Desktop extension lists the forecast tools and has two settings: a forecaster key,
  kept as a secret, and whether to sign forecasts on this computer.

### Changed

- `HYPERODDS_MCP_URL` with a username or password is refused at startup, and errors no longer
  repeat its value or its query string.
- When the server turns away a notification without a JSON-RPC answer, the server log now records
  it with the HTTP status.
- The bridge signs forecasts with two audited libraries, `@noble/curves` and `@noble/hashes`,
  pinned to exact versions. The extension carries only the files the bridge loads from them.

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

[Unreleased]: https://github.com/usehyperodds/hyperodds-mcp/compare/v0.2.3...HEAD
[0.2.3]: https://github.com/usehyperodds/hyperodds-mcp/releases/tag/v0.2.3
[0.2.2]: https://github.com/usehyperodds/hyperodds-mcp/releases/tag/v0.2.2
[0.2.1]: https://github.com/usehyperodds/hyperodds-mcp/releases/tag/v0.2.1
[0.2.0]: https://github.com/usehyperodds/hyperodds-mcp/releases/tag/v0.2.0
[0.1.1]: https://github.com/usehyperodds/hyperodds-mcp/releases/tag/v0.1.1
[0.1.0]: https://github.com/usehyperodds/hyperodds-mcp/releases/tag/v0.1.0

# Changelog

Notable changes to `@hyperodds/mcp`, newest first. Versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Forecasts are signed as message version 2 of the forecast record's spec: each forecast names its
  market's title and first side, under a domain salted for Hyperodds' mainnet record. Before it
  signs, the bridge reads those names with `odds_fair`, one call per market, which counts toward the
  daily limit for market tools, and the confirmation shows them beside each probability. Hyperodds
  is retiring version 1, which named markets by number only, so earlier versions of the bridge will
  stop entering forecasts.

## [0.2.6] - 2026-11-27

### Fixed

- A wrong forecast setting, such as a relative `HYPERODDS_FORECAST_KEY_FILE`, no longer stops the
  bridge at startup, which took the market tools down with it. The bridge starts, says what is
  wrong on stderr, and answers `odds_forecast`, and `odds_forecast_record` without an address, with
  that reason until the setting is fixed. The settings are `HYPERODDS_FORECAST_KEY`,
  `HYPERODDS_FORECAST_KEY_FILE`, `HYPERODDS_FORECAST_SIGNING`, `HYPERODDS_FORECAST_LIMIT` and
  `HYPERODDS_SITE_URL`; a wrong `HYPERODDS_MCP_URL` still stops it.

## [0.2.5] - 2026-11-27

### Fixed

- The confirmation for a single forecast reads "Sign and enter this forecast in Hyperodds' public
  record…? It is the probability…", where it said "Sign this forecast and enter them".
- Declining a single forecast answers "the person did not confirm this forecast", where it said
  "these forecasts".

## [0.2.4] - 2026-11-26

### Changed

- The bridge no longer follows redirects. A reply that redirects is an error naming its HTTP
  status, so a redirect can't move a message to plain http or another server, or turn it into a
  GET.
- The bridge answers requests from the server itself and passes none of them to the client: a
  `ping` gets an empty answer, and anything else, such as `sampling/createMessage`,
  `elicitation/create` or `roots/list`, a method-not-found error. It also removes the `roots`,
  `sampling`, `elicitation` and `tasks` capabilities from the client's `initialize`. Before, a
  server could ask the client's model for text, the person for input or the client for its folders.
- Size limits: the bridge stops reading an answer past 8 MB, JSON or event stream, and drops a
  line from the client over 1 MB, each with a JSON-RPC error that says so. Before, either could
  grow until the bridge ran out of memory. Event streams are also read in one pass, so a large
  event no longer costs time in proportion to its size squared.
- With a key from `HYPERODDS_FORECAST_KEY`, the bridge checks the folder for
  `forecast-times.json` the way it checks the key's folder, and refuses to sign through a link
  or in a folder others control. It reads that file only if it is a regular file of at most 1 MB,
  opened without following a link, and never signs further than 10 minutes ahead of the clock,
  whatever the file says. A key file must be a regular file too; a FIFO in its place no longer
  stops the bridge.
- Errors the client sees write your home folder as `~`, or `$HOME` inside a command to run, so
  the model never sees your user name. The server log keeps the full path.
- The README's client entries pin the release, and say how to follow `@latest` instead. The README
  and SECURITY.md now say what removing `HYPERODDS_FORECAST_KEY` from the bridge's
  environment does not do: the key stays in the client's config and in the environment the
  operating system recorded when the bridge started.
- Releases publish in two jobs: one that checks out the tag without keeping its credentials,
  installs with `--ignore-scripts`, tests and packs with a read-only token, and one that publishes
  the packed package to npm with provenance and makes the GitHub release, running nothing from the
  repository. Release notes now come from the tag's own changelog entry.
- SECURITY.md explains the zod advisory `npm audit` reports: it affects only tools used to build
  and test, never the published package or the extension.

### Added

- `HYPERODDS_FORECAST_KEY_FILE` names a key file of your own by its absolute path, so the key
  needn't pass through the environment. The bridge checks that file and its folders as it checks
  the key it makes, and never makes a key there. Setting it together with
  `HYPERODDS_FORECAST_KEY`, or as a relative path, is refused at startup.
- When the client supports MCP elicitation forms, the bridge asks the person to confirm each
  `odds_forecast` call before it signs, showing the outcome ids, probabilities and forecaster.
  Nothing is entered without an accept. Other clients work as before.
- The bridge signs at most 200 forecasts a session, from start to exit, and says so when a call
  would pass that. `HYPERODDS_FORECAST_LIMIT` changes the limit. Forecasts the server refuses
  don't count.
- The `odds_forecast` description now also names market rules among the deployer-written text an
  agent must treat as data, never as instructions.

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

[Unreleased]: https://github.com/usehyperodds/hyperodds-mcp/compare/v0.2.6...HEAD
[0.2.6]: https://github.com/usehyperodds/hyperodds-mcp/releases/tag/v0.2.6
[0.2.5]: https://github.com/usehyperodds/hyperodds-mcp/releases/tag/v0.2.5
[0.2.4]: https://github.com/usehyperodds/hyperodds-mcp/releases/tag/v0.2.4
[0.2.3]: https://github.com/usehyperodds/hyperodds-mcp/releases/tag/v0.2.3
[0.2.2]: https://github.com/usehyperodds/hyperodds-mcp/releases/tag/v0.2.2
[0.2.1]: https://github.com/usehyperodds/hyperodds-mcp/releases/tag/v0.2.1
[0.2.0]: https://github.com/usehyperodds/hyperodds-mcp/releases/tag/v0.2.0
[0.1.1]: https://github.com/usehyperodds/hyperodds-mcp/releases/tag/v0.1.1
[0.1.0]: https://github.com/usehyperodds/hyperodds-mcp/releases/tag/v0.1.0

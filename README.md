<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/usehyperodds/hyperodds-mcp/main/assets/banner-dark.png">
    <img alt="Hyperodds MCP: HIP-4 market data for any MCP client" src="https://raw.githubusercontent.com/usehyperodds/hyperodds-mcp/main/assets/banner-light.png">
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@hyperodds/mcp"><img alt="npm" src="https://img.shields.io/npm/v/@hyperodds/mcp?color=176646&label=npm"></a>
  <a href="https://github.com/usehyperodds/hyperodds-mcp/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/usehyperodds/hyperodds-mcp/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/usehyperodds/hyperodds-mcp/blob/main/LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-176646"></a>
  <a href="https://usehyperodds.com"><img alt="Website" src="https://img.shields.io/badge/web-usehyperodds.com-070b0c"></a>
  <a href="https://x.com/UseHyperodds"><img alt="X" src="https://img.shields.io/badge/@UseHyperodds-000000?logo=x&logoColor=white"></a>
</p>

Give Claude, Cursor, VS Code or any other MCP client live data on Hyperliquid's HIP-4 outcome
markets from every deployer: books, fair lines with their sources, rule comparisons where several
deployers list the same question, and the newest listings. Free, with no key to set up.

`@hyperodds/mcp` runs on your machine over stdio and forwards each request to the hosted Hyperodds
server. It has no dependencies, and its tools are read-only: none can trade or access an account.

## Quick start

Claude Desktop (Settings > Developer > Edit Config), Cursor (`~/.cursor/mcp.json`, or
`.cursor/mcp.json` in one project) and Windsurf take this entry:

```json
{
  "mcpServers": {
    "hyperodds": {
      "command": "npx",
      "args": ["-y", "@hyperodds/mcp"]
    }
  }
}
```

Claude Code:

```sh
claude mcp add hyperodds -- npx -y @hyperodds/mcp
```

VS Code (`.vscode/mcp.json`):

```json
{
  "servers": {
    "hyperodds": { "type": "stdio", "command": "npx", "args": ["-y", "@hyperodds/mcp"] }
  }
}
```

The package needs Node.js 22 or later. A client that connects to remote servers can skip it and
use `https://api.usehyperodds.com/mcp` directly over Streamable HTTP.

## What to ask

- "Which HIP-4 markets show the biggest edge after fees right now?"
- "Is the next Fed decision priced the same on every deployer, and do their rules match?"
- "Where does the fair line for the BTC markets settling today come from, and how confident is it?"
- "What was listed in the last hour?"

## Tools

| Tool           | Input                                                                                                    | Output                                                                                                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `odds_markets` | `category`, `deployer`, `sort` (`volume`, `edge`, `new`, `settling`), `q`, `limit` (up to 100), `offset` | Markets with bid, ask, fair line, best buy edge after fees, 24h volume, event time and status, plus how many match in total                                                   |
| `odds_cluster` | `id`, or the `outcome` of any member                                                                     | One question listed by several deployers: each member's rule grade (`SAME`, `CLOSE` or `DIFFERENT`), the differences found and the merged book                                |
| `odds_fair`    | `outcome`                                                                                                | One market's fair line: probability and band, method, confidence and flags, each source with its weight and age, plus the book and the edge for buying or selling either side |
| `odds_new`     | `category`, `limit` (up to 100), `offset`                                                                | Markets in listing order, newest first, with the same fields as `odds_markets`                                                                                                |

Your client receives each tool's input and output schema when it connects. The
[MCP guide](https://usehyperodds.com/docs/mcp) explains the numbers.

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/usehyperodds/hyperodds-mcp/main/assets/diagram-dark.png">
  <img alt="An MCP client talks to @hyperodds/mcp on your machine over stdio. The bridge forwards each message over HTTPS to api.usehyperodds.com/mcp, which answers from Hyperodds data built from Hyperliquid, Polymarket, Kalshi, Deribit, Bybit and Cboe." src="https://raw.githubusercontent.com/usehyperodds/hyperodds-mcp/main/assets/diagram-light.png">
</picture>

Each message from the client goes out as one HTTPS request, and its response comes straight back.
The bridge keeps no state beyond the protocol version agreed when the client connects. Requests
run side by side. If one fails or gets no answer within 30 seconds, the client receives a
JSON-RPC error that names the cause; a cancelled request is dropped. When the client closes the
connection, the bridge drops what is still in flight and exits.

## Reading the numbers

Prices are decimals from 0 to 1 for a market's first side, often Yes. Edges are percentage points
after every fee, including the fee Hyperliquid takes at settlement, for a $100 order: 2.9 means
2.9¢ a share. An edge is null when $100 would not fill.

Price markets take their fair line from Deribit, Bybit and Cboe option surfaces, or from realized
volatility on Hyperliquid perps. Sports and events take theirs from matched Polymarket and Kalshi
quotes. Fair lines are estimates: edge rankings only use lines with a `fairConfidence` of at least
0.5 and more than one source, so check both before acting on one.

## Limits

Each IP address gets 1,000 tool calls a day, reset at 00:00 UTC. Every request, tool call or not,
also counts toward a rate limit of 5 a second, with bursts of up to 30. Past either limit, the
server answers with an error that names it.

## Configuration

| Variable            | Default                            | Purpose                  |
| ------------------- | ---------------------------------- | ------------------------ |
| `HYPERODDS_MCP_URL` | `https://api.usehyperodds.com/mcp` | The server to forward to |

Set it in the client entry's `env`:

```json
{
  "command": "npx",
  "args": ["-y", "@hyperodds/mcp"],
  "env": { "HYPERODDS_MCP_URL": "https://mcp.example.com/mcp" }
}
```

Behind a proxy, add `HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1` to the same `env`. Node.js reads the
proxy only when the second is set, which needs Node.js 22.21 or later.

`npx -y @hyperodds/mcp --help` and `--version` print the usage and the version.

## Development

```sh
git clone https://github.com/usehyperodds/hyperodds-mcp.git
cd hyperodds-mcp
npm ci
npm test
```

`npm run lint` and `npm run typecheck` run the other checks CI runs. See
[CONTRIBUTING.md](https://github.com/usehyperodds/hyperodds-mcp/blob/main/CONTRIBUTING.md) before
opening a pull request.

## Security

Report vulnerabilities privately to security@usehyperodds.com, or through
[the repository's Security tab](https://github.com/usehyperodds/hyperodds-mcp/security/advisories/new).
Please do not open a public issue for them.
[SECURITY.md](https://github.com/usehyperodds/hyperodds-mcp/blob/main/SECURITY.md) has the details.

## License

[MIT](https://github.com/usehyperodds/hyperodds-mcp/blob/main/LICENSE). Third-party names identify
data sources and compatible clients; Hyperodds is not affiliated with any of them.

<p align="center">
  <a href="https://usehyperodds.com">Website</a> ·
  <a href="https://usehyperodds.com/docs/mcp">Docs</a> ·
  <a href="https://x.com/UseHyperodds">X</a> ·
  <a href="https://github.com/usehyperodds">GitHub</a>
</p>

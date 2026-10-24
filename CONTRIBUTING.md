# Contributing

Thanks for helping. This repository holds `@hyperodds/mcp`, the stdio bridge to the hosted
Hyperodds MCP server.

- A bug in how the bridge relays messages, a client it does not work with, or a gap in these
  docs: open an issue or a pull request here.
- A tool's output, a missing field or a new tool: open a
  [feature request](https://github.com/usehyperodds/hyperodds-mcp/issues/new?template=feature_request.yml).
  Those changes ship on the hosted server, with no new package version.

## Set up

You need Node.js 22 or later.

```sh
git clone https://github.com/usehyperodds/hyperodds-mcp.git
cd hyperodds-mcp
npm ci
npm test
```

`npm test` builds `dist/` and runs every test with Node's own test runner. `npm run lint` checks
formatting and lint rules with Biome (`npm run format` fixes what it can), and `npm run typecheck`
runs TypeScript. CI runs all three on Node 22 and 24 on Linux, and on Node 24 on Windows.

To try a change in a real client, point the client's command at your build:

```json
{ "command": "node", "args": ["/path/to/hyperodds-mcp/dist/cli.js"] }
```

`HYPERODDS_MCP_URL` sends it to another server, such as a mock you run in a test.

## Pull requests

- Keep each pull request to one change, with a test that fails without it.
- Keep the package dependency-free; it runs through `npx` every time a client starts it.
- Write commit messages in the imperative, short and lowercase: `answer batched requests one by one`.
- Describe how you tested it, including the client and Node version if it matters.

By contributing, you agree to release your work under the [MIT license](LICENSE) and to follow the
[code of conduct](CODE_OF_CONDUCT.md).

## Releases

Maintainers release from `main`: bump the version in `package.json`, add the entry to
[CHANGELOG.md](CHANGELOG.md), tag `vX.Y.Z` and publish with `npm publish`.

#!/usr/bin/env node
import { createRequire } from "node:module";
import { Bridge } from "./bridge.js";
import { proxyNote } from "./proxy.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const DEFAULT_URL = "https://api.usehyperodds.com/mcp";

const USAGE = `hyperodds-mcp ${version}

Connects an MCP client on stdio to Hyperodds: read-only data on Hyperliquid HIP-4 outcome
markets. Add it to your client with the command: npx -y @hyperodds/mcp

Options:
  -h, --help           show this help
  -v, --version        show the version

Environment:
  HYPERODDS_MCP_URL    server to forward to (default ${DEFAULT_URL})
  HTTPS_PROXY          proxy for an https server
  HTTP_PROXY           proxy for an http server
  NO_PROXY             hosts to reach without the proxy
  NODE_USE_ENV_PROXY   1 turns on the three above (Node.js 22.21, 24.5 or later)
  The proxy variables also work in lowercase, which takes precedence.

Docs: https://usehyperodds.com/docs/mcp`;

function fail(message: string): never {
  console.error(`hyperodds-mcp: ${message} Run with --help for usage.`);
  process.exit(2);
}

const [arg, extra] = process.argv.slice(2).filter((a) => a !== "--");
if (arg === "--help" || arg === "-h") {
  console.log(USAGE);
  process.exit(0);
}
if (arg === "--version" || arg === "-v") {
  console.log(version);
  process.exit(0);
}
if (arg !== undefined || extra !== undefined) fail(`Unknown argument ${arg ?? extra}.`);

// Errors never repeat the variable's value: it could carry a secret.
const url = process.env.HYPERODDS_MCP_URL || DEFAULT_URL;
if (!URL.canParse(url)) fail("HYPERODDS_MCP_URL is not a URL.");
const target = new URL(url);
if (target.username || target.password) fail("HYPERODDS_MCP_URL must not contain a username or password.");
if (target.protocol !== "https:" && target.protocol !== "http:")
  fail(`HYPERODDS_MCP_URL must be an http or https URL, not "${target.protocol.slice(0, -1)}".`);
// Names the server in errors and logs, without a query string, which could also carry a secret.
const shown = `${target.origin}${target.pathname}`;

const log = (line: string) => process.stderr.write(`hyperodds-mcp: ${line}\n`);
const flags = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? "").split(/\s+/)];
const proxy = proxyNote(target, process.env, process.versions.node, flags);
if (proxy?.ignored) log(proxy.text);
// The client went away: nothing is left to answer.
process.stdout.on("error", () => process.exit(0));
const bridge = new Bridge({
  url: target.href,
  label: target.href === DEFAULT_URL ? "Hyperodds" : `${shown} (set by HYPERODDS_MCP_URL)`,
  write: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
  log,
  userAgent: `hyperodds-mcp/${version} node/${process.versions.node}`,
  networkNote: proxy?.text,
});

if (process.stdin.isTTY)
  log(`Waiting for an MCP client on stdin, forwarding to ${shown}. Run with --help for usage.`);

// Messages end at "\n" only. readline would also split at U+2028 and U+2029, which JSON allows
// unescaped inside strings; a trailing "\r" is whitespace to JSON.parse.
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
    bridge.receive(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
  }
});
// The client closing stdin is how MCP asks a server to stop: drop what is in flight and exit.
process.stdin.on("end", () => {
  bridge.close();
  process.stdout.write("", () => process.exit(0));
});

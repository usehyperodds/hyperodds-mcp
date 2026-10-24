#!/usr/bin/env node
import { createRequire } from "node:module";
import { Bridge } from "./bridge.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const DEFAULT_URL = "https://api.usehyperodds.com/mcp";

const USAGE = `hyperodds-mcp ${version}

Connects an MCP client on stdio to Hyperodds: read-only data on Hyperliquid HIP-4 outcome
markets. Add it to your client with the command: npx -y @hyperodds/mcp

Options:
  -h, --help          show this help
  -v, --version       show the version

Environment:
  HYPERODDS_MCP_URL   server to forward to (default ${DEFAULT_URL})

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

const url = process.env.HYPERODDS_MCP_URL || DEFAULT_URL;
let protocol = "";
try {
  protocol = new URL(url).protocol;
} catch {
  fail(`HYPERODDS_MCP_URL is not a URL: "${url}".`);
}
if (protocol !== "https:" && protocol !== "http:")
  fail(`HYPERODDS_MCP_URL must be an http or https URL: "${url}".`);

const log = (line: string) => process.stderr.write(`hyperodds-mcp: ${line}\n`);
// The client went away: nothing is left to answer.
process.stdout.on("error", () => process.exit(0));
const bridge = new Bridge({
  url,
  label: url === DEFAULT_URL ? "Hyperodds" : `${url} (set by HYPERODDS_MCP_URL)`,
  write: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
  log,
  userAgent: `hyperodds-mcp/${version} node/${process.versions.node}`,
});

if (process.stdin.isTTY)
  log(`Waiting for an MCP client on stdin, forwarding to ${url}. Run with --help for usage.`);

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

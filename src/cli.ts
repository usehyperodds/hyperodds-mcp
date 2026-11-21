#!/usr/bin/env node
import { createRequire } from "node:module";
import { Bridge } from "./bridge.js";
import { keyPath, takeKey } from "./key.js";
import { proxyNote } from "./proxy.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const DEFAULT_URL = "https://api.usehyperodds.com/mcp";

const USAGE = `hyperodds-mcp ${version}

Connects an MCP client on stdio to Hyperodds: data on Hyperliquid HIP-4 outcome markets, and
forecasts entered in Hyperodds' public record, signed on this computer. Add it to your client
with the command: npx -y @hyperodds/mcp

Options:
  -h, --help                  show this help
  -v, --version               show the version

Environment:
  HYPERODDS_MCP_URL           server to forward to (default ${DEFAULT_URL})
  HYPERODDS_FORECAST_KEY      the forecaster's private key, 64 hex digits (default: a key made on
                              the first forecast and kept in ${keyPath()})
  HYPERODDS_FORECAST_SIGNING  off to leave forecasts unsigned, for a sign link (default on)
  HYPERODDS_SITE_URL          the site with a hand-set server's forecast records, for links to
                              them (the hosted server's is https://usehyperodds.com)
  HTTPS_PROXY                 proxy for an https server
  HTTP_PROXY                  proxy for an http server
  NO_PROXY                    hosts to reach without the proxy
  NODE_USE_ENV_PROXY          1 turns on the three above (Node.js 22.21, 24.5 or later)
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
// The query string could carry a secret too, so errors and logs leave it out.
const shown = `${target.origin}${target.pathname}`;

// Answers link a forecaster's public record only on a site known to publish it.
const siteSetting = process.env.HYPERODDS_SITE_URL;
let site: string | undefined;
if (siteSetting) {
  if (!URL.canParse(siteSetting)) fail("HYPERODDS_SITE_URL is not a URL.");
  const { protocol, origin } = new URL(siteSetting);
  if (protocol !== "https:" && protocol !== "http:") fail("HYPERODDS_SITE_URL must be an http or https URL.");
  site = origin;
} else if (target.hostname === "api.usehyperodds.com") site = "https://usehyperodds.com";

// Taken out of the environment at once, so nothing else in the process finds the key there.
const envKey = takeKey();
const signing = process.env.HYPERODDS_FORECAST_SIGNING ?? "";
if (!["", "on", "off", "true", "false"].includes(signing.trim().toLowerCase()))
  fail("HYPERODDS_FORECAST_SIGNING must be on or off.");
const signs = !["off", "false"].includes(signing.trim().toLowerCase());

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
  keys: signs ? { env: envKey, path: keyPath(), log } : undefined,
  siteUrl: site,
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

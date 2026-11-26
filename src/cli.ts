#!/usr/bin/env node
import { createRequire } from "node:module";
import { Bridge, FORECAST_LIMIT } from "./bridge.js";
import { keyPath, takeKey } from "./key.js";
import { proxyNote } from "./proxy.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const DEFAULT_URL = "https://api.usehyperodds.com/mcp";

const USAGE = `hyperodds-mcp ${version}

Connects an MCP client on stdio to Hyperodds: data on Hyperliquid HIP-4 outcome markets, and
forecasts for Hyperodds' public record, signed on this computer. Add it to your client with the
command: npx -y @hyperodds/mcp@${version}

Options:
  -h, --help                  show this help
  -v, --version               show the version

Environment:
  HYPERODDS_MCP_URL           server to forward to, https or on this computer
                              (default ${DEFAULT_URL})
  HYPERODDS_FORECAST_KEY      private key made for forecasts, 64 hex digits (default: the key
                              made on the first forecast, kept in ${keyPath()})
  HYPERODDS_FORECAST_SIGNING  off to leave forecasts unsigned, for a sign link (default on)
  HYPERODDS_FORECAST_LIMIT    most forecasts signed in a session, from start to exit
                              (default ${FORECAST_LIMIT})
  HYPERODDS_SITE_URL          site that publishes the server's forecast records, for links to
                              them (default https://usehyperodds.com with the hosted server)
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
// Over plain http anyone on the path could read signed forecasts before their market's cutoff, and
// rewrite the answers the agent acts on. URL has already turned 127.1 and [0::1] into their usual form.
const loopback = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/;
if (target.protocol === "http:" && !loopback.test(target.hostname))
  fail(
    "HYPERODDS_MCP_URL must be https unless the server is on this computer (localhost, 127.x.x.x or [::1]).",
  );
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

const envKey = takeKey();
const signing = process.env.HYPERODDS_FORECAST_SIGNING ?? "";
if (!["", "on", "off", "true", "false"].includes(signing.trim().toLowerCase()))
  fail("HYPERODDS_FORECAST_SIGNING must be on or off.");
const signs = !["off", "false"].includes(signing.trim().toLowerCase());
const limitSetting = process.env.HYPERODDS_FORECAST_LIMIT?.trim() || String(FORECAST_LIMIT);
if (!/^\d{1,6}$/.test(limitSetting) || Number(limitSetting) < 1)
  fail("HYPERODDS_FORECAST_LIMIT must be a whole number of forecasts, from 1 to 999999.");

const log = (line: string) => process.stderr.write(`hyperodds-mcp: ${line}\n`);
const flags = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? "").split(/\s+/)];
const proxy = proxyNote(target, process.env, process.versions.node, flags);
if (proxy?.ignored) log(proxy.text);
// The client went away: nothing is left to answer.
process.stdout.on("error", () => process.exit(0));
const write = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);
const bridge = new Bridge({
  url: target.href,
  label: target.href === DEFAULT_URL ? "Hyperodds" : `${shown} (set by HYPERODDS_MCP_URL)`,
  write,
  log,
  userAgent: `hyperodds-mcp/${version} node/${process.versions.node}`,
  networkNote: proxy?.text,
  keys: signs ? { env: envKey, path: keyPath(), log } : undefined,
  siteUrl: site,
  forecastLimit: Number(limitSetting),
});

if (process.stdin.isTTY)
  log(`Waiting for an MCP client on stdin, forwarding to ${shown}. Run with --help for usage.`);

// The server takes 256 KB a message, so a line four times that is never one, and the bridge won't
// hold it.
const MAX_LINE_BYTES = 1_000_000;
const tooLong = () => {
  log("The client sent a line over 1 MB; the bridge dropped it.");
  write({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32600, message: "Invalid request: a message is over 1 MB, the most the bridge takes." },
  });
};

// Messages end at "\n" only. readline would also split at U+2028 and U+2029, which JSON allows
// unescaped inside strings; a trailing "\r" is whitespace to JSON.parse.
let buffer = "";
// Set while the rest of a line over the limit is still to come; all of it is dropped.
let dropping = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (dropping) dropping = false;
    else if (Buffer.byteLength(line) > MAX_LINE_BYTES) tooLong();
    else bridge.receive(line);
  }
  if (!dropping && Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
    dropping = true;
    tooLong();
  }
  if (dropping) buffer = "";
});
// The client closing stdin is how MCP asks a server to stop: drop what is in flight and exit.
process.stdin.on("end", () => {
  bridge.close();
  process.stdout.write("", () => process.exit(0));
});

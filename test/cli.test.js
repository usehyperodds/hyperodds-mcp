import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { serve, standIn } from "./stand-in.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// Every run gets its own config directory and no forecast settings from the shell running the tests.
const config = mkdtempSync(join(tmpdir(), "hyperodds-mcp-cli-test-"));
after(() => rmSync(config, { recursive: true, force: true }));
process.env.XDG_CONFIG_HOME = config;
process.env.HYPERODDS_FORECAST_KEY = "";
process.env.HYPERODDS_FORECAST_SIGNING = "";

/**
 * Starts the CLI, sends `messages` and waits for `count` answers, then closes stdin; resolves with
 * the answers by id, its stderr and its exit code.
 */
async function session(env, messages, count) {
  const proc = spawn(process.execPath, [cli], { env: { ...process.env, ...env } });
  let stdout = "";
  let stderr = "";
  proc.stderr.on("data", (d) => {
    stderr += d;
  });
  const exited = new Promise((r) => proc.on("close", r));
  for (const m of messages) proc.stdin.write(`${JSON.stringify(m)}\n`);
  await new Promise((done) =>
    proc.stdout.on("data", (d) => {
      stdout += d;
      if (stdout.split("\n").filter(Boolean).length === count) done();
    }),
  );
  proc.stdin.end();
  const code = await exited;
  const answers = Object.fromEntries(
    stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .map((a) => [a.id, a]),
  );
  return { answers, stderr, code };
}

/** Runs the CLI with `input` on stdin; resolves with its exit code, stdout lines and stderr. */
function run(input, env = {}, args = []) {
  return new Promise((done) => {
    const proc = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += d;
    });
    proc.stderr.on("data", (d) => {
      stderr += d;
    });
    proc.on("close", (code) => done({ code, lines: stdout.split("\n").filter(Boolean), stderr }));
    proc.stdin.end(input);
  });
}

/** Sends one request and resolves with the first line the CLI answers and its stderr so far. */
function ask(message, env) {
  return new Promise((done, fail) => {
    const proc = spawn(process.execPath, [cli], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d;
    });
    proc.stdout.on("data", (d) => {
      stdout += d;
      if (!stdout.includes("\n")) return;
      proc.stdin.end();
      done({ answer: JSON.parse(stdout.split("\n")[0]), stderr });
    });
    proc.on("close", (code) => fail(new Error(`exited with ${code} before answering: ${stderr}`)));
    proc.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

// Proxy settings from the environment running the tests would change what the CLI does.
const noProxy = {
  HTTPS_PROXY: undefined,
  https_proxy: undefined,
  HTTP_PROXY: undefined,
  http_proxy: undefined,
  NODE_USE_ENV_PROXY: undefined,
};

describe("hyperodds-mcp", () => {
  let server;
  let url;
  before(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => {
        raw += d;
      });
      req.on("end", () => {
        const body = JSON.parse(raw);
        if (body.id === undefined) return res.writeHead(202).end();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { echo: body.params ?? null, ua: req.headers["user-agent"] },
          }),
        );
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${server.address().port}/mcp`;
  });
  after(() => server.close());

  test("answers each request on stdout, and exits at once when the client closes stdin", async () => {
    const proc = spawn(process.execPath, [cli], { env: { ...process.env, HYPERODDS_MCP_URL: url } });
    let stdout = "";
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d;
    });
    const answered = new Promise((done) =>
      proc.stdout.on("data", (d) => {
        stdout += d;
        if (stdout.split("\n").filter(Boolean).length === 2) done();
      }),
    );
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\r\n`);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    await answered;
    proc.stdin.end();
    assert.equal(await new Promise((r) => proc.on("close", r)), 0);
    assert.equal(stderr, "");
    const answers = stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.deepEqual(answers.map((a) => a.id).sort(), [1, 2]);
    assert.match(answers[0].result.ua, new RegExp(`^hyperodds-mcp/${version} node/`));
  });

  test("a request still out when the client closes stdin is dropped, and the process exits", async () => {
    const hang = createServer(() => {});
    await new Promise((r) => hang.listen(0, "127.0.0.1", r));
    const started = Date.now();
    const r = await run(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" })}\n`, {
      HYPERODDS_MCP_URL: `http://127.0.0.1:${hang.address().port}/mcp`,
    });
    hang.closeAllConnections();
    hang.close();
    assert.equal(r.code, 0);
    assert.deepEqual(r.lines, []);
    assert.ok(Date.now() - started < 5_000);
  });

  test("a line separator inside a string stays part of the message", async () => {
    const proc = spawn(process.execPath, [cli], { env: { ...process.env, HYPERODDS_MCP_URL: url } });
    const call = {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { q: "Fed rate\u2028decision\u2029" },
    };
    const line = new Promise((done) => proc.stdout.once("data", (d) => done(String(d))));
    proc.stdin.write(`${JSON.stringify(call)}\n`);
    const answer = await line;
    proc.stdin.end();
    assert.equal(answer.trim().split("\n").length, 1);
    assert.deepEqual(JSON.parse(answer).result.echo, call.params);
  });

  test("exits quietly when the client stops reading", async () => {
    const proc = spawn(process.execPath, [cli], { env: { ...process.env, HYPERODDS_MCP_URL: url } });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d;
    });
    proc.stdout.destroy();
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" })}\n`);
    const code = await new Promise((r) => proc.on("close", r));
    assert.equal(code, 0);
    assert.equal(stderr, "");
  });

  test("prints its version and usage, and refuses a bad argument or server", async () => {
    assert.deepEqual((await run("", {}, ["--version"])).lines, [version]);
    assert.match((await run("", {}, ["--help"])).lines.join("\n"), /HYPERODDS_MCP_URL/);
    const unknown = await run("", {}, ["foo"]);
    assert.equal(unknown.code, 2);
    assert.equal(unknown.stderr, "hyperodds-mcp: Unknown argument foo. Run with --help for usage.\n");
    assert.deepEqual((await run("", {}, ["--", "--version"])).lines, [version]);
    const ftp = await run("", { HYPERODDS_MCP_URL: "ftp://example.com/mcp" });
    assert.equal(ftp.code, 2);
    assert.match(ftp.stderr, /must be an http or https URL/);
    assert.equal((await run("", { HYPERODDS_MCP_URL: "https://exa mple.com" })).code, 2);
    assert.equal((await run("", { HYPERODDS_MCP_URL: url.replace("http:", "HTTP:") })).code, 0);
    const signing = await run("", { HYPERODDS_FORECAST_SIGNING: "maybe" });
    assert.equal(signing.code, 2);
    assert.equal(
      signing.stderr,
      "hyperodds-mcp: HYPERODDS_FORECAST_SIGNING must be on or off. Run with --help for usage.\n",
    );
    for (const value of ["on", "OFF", "true", "false"])
      assert.equal((await run("", { HYPERODDS_FORECAST_SIGNING: value })).code, 0, value);
  });

  describe("forecasts", () => {
    const forecast = (id, args) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "odds_forecast", arguments: args },
    });
    const forecasts = [
      { outcome: 42400, probabilityBps: 6200 },
      { outcome: 42501, probabilityBps: 3100 },
    ];

    test("are signed with a key made in the config directory, which goes nowhere else", async (t) => {
      const server = standIn();
      const { url, close } = await serve(server);
      t.after(close);
      const home = mkdtempSync(join(config, "signing-"));
      const r = await session(
        { HYPERODDS_MCP_URL: url, XDG_CONFIG_HOME: home },
        [forecast(1, { forecasts })],
        1,
      );
      assert.equal(r.code, 0);
      const { structuredContent, content } = r.answers[1].result;
      assert.equal(structuredContent.status, "recorded");
      assert.match(content[1].text, /^Signed on this computer by forecaster 0x[0-9a-f]{40}\./);
      const key = readFileSync(join(home, "hyperodds", "forecaster.key"), "utf8").trim();
      assert.equal(
        r.stderr,
        `hyperodds-mcp: Made forecaster ${structuredContent.forecaster} and saved its key to ${join(home, "hyperodds", "forecaster.key")}. Back up that file to keep it.\n`,
      );
      assert.ok(!JSON.stringify(r).includes(key.slice(2)));
      assert.equal(server.recorded.length, 2);
    });

    test("link the record only on HYPERODDS_SITE_URL when the server was set by hand", async (t) => {
      const { url, close } = await serve(standIn({ web: "https://phish.example" }));
      t.after(close);
      const env = { HYPERODDS_MCP_URL: url, XDG_CONFIG_HOME: mkdtempSync(join(config, "site-")) };
      const line = async (more) =>
        (await session({ ...env, ...more }, [forecast(1, { forecasts })], 1)).answers[1].result.content[1]
          .text;
      assert.match(
        await line({}),
        /^Signed on this computer by forecaster 0x[0-9a-f]{40}\. Each forecast appears in its public record after its market's cutoff\.$/,
      );
      assert.match(
        await line({ HYPERODDS_SITE_URL: "http://localhost:3291/ignored/path" }),
        /Its public record is http:\/\/localhost:3291\/forecasts\/0x[0-9a-f]{40}, where/,
      );
      for (const bad of ["not a url", "ftp://example.com"]) {
        const r = await run("", { HYPERODDS_SITE_URL: bad });
        assert.equal(r.code, 2, bad);
        assert.match(r.stderr, /^hyperodds-mcp: HYPERODDS_SITE_URL /, bad);
        assert.ok(!r.stderr.includes(bad), bad);
      }
    });

    test("pass through unsigned when HYPERODDS_FORECAST_SIGNING is off", async (t) => {
      const server = standIn();
      const { url, close } = await serve(server);
      t.after(close);
      const home = mkdtempSync(join(config, "off-"));
      const r = await session(
        { HYPERODDS_MCP_URL: url, XDG_CONFIG_HOME: home, HYPERODDS_FORECAST_SIGNING: "off" },
        [forecast(1, { forecasts })],
        1,
      );
      assert.equal(r.answers[1].result.structuredContent.status, "draft");
      assert.equal(r.answers[1].result.structuredContent.forecaster, null);
      assert.equal(existsSync(join(home, "hyperodds")), false);
      assert.equal(server.recorded.length, 0);
      assert.equal(r.stderr, "");
    });
  });

  test("takes plain http only for a server on this computer", async () => {
    const remote = [
      "http://example.com/mcp",
      "http://10.0.0.5:3100/mcp",
      "http://127.0.0.1.nip.io/mcp",
      "http://[::ffff:127.0.0.1]/mcp",
    ];
    for (const server of remote) {
      const r = await run("", { HYPERODDS_MCP_URL: server });
      assert.equal(r.code, 2, server);
      assert.equal(
        r.stderr,
        "hyperodds-mcp: HYPERODDS_MCP_URL must be https unless the server is on this computer (localhost, 127.x.x.x or [::1]). Run with --help for usage.\n",
      );
    }
    const local = [
      "http://localhost:1/mcp",
      "http://127.0.0.2:1/mcp",
      "http://[::1]:1/mcp",
      "HTTP://127.1:1/mcp",
    ];
    for (const server of [...local, "https://example.com/mcp"])
      assert.equal((await run("", { HYPERODDS_MCP_URL: server })).code, 0, server);
  });

  test("refuses a server URL with a username or password, and never repeats a secret", async () => {
    const login = await run("", { HYPERODDS_MCP_URL: "https://user:s3cret@example.com/mcp" });
    assert.equal(login.code, 2);
    assert.equal(
      login.stderr,
      "hyperodds-mcp: HYPERODDS_MCP_URL must not contain a username or password. Run with --help for usage.\n",
    );
    const typo = await run("", { HYPERODDS_MCP_URL: "https//user:s3cret@example.com/mcp" });
    assert.equal(typo.code, 2);
    assert.doesNotMatch(typo.stderr, /s3cret/);

    // Nothing listens on port 1.
    const keyed = await ask(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { ...noProxy, HYPERODDS_MCP_URL: "http://127.0.0.1:1/mcp?key=s3cret" },
    );
    assert.match(keyed.answer.error.message, /^Could not reach http:\/\/127\.0\.0\.1:1\/mcp \(set by/);
    assert.doesNotMatch(JSON.stringify(keyed), /s3cret/);
  });

  test("names the proxy when the server cannot be reached, and says when a proxy goes unused", async () => {
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    const server = { ...noProxy, HYPERODDS_MCP_URL: "https://hyperodds.test/mcp" };
    // Nothing listens on port 1, so the proxy refuses at once.
    const proxied = await ask(ping, {
      ...server,
      NODE_USE_ENV_PROXY: "1",
      HTTPS_PROXY: "http://user:s3cret@127.0.0.1:1",
    });
    assert.match(
      proxied.answer.error.message,
      /\(ECONNREFUSED\)\. Requests go through the proxy http:\/\/127\.0\.0\.1:1 from HTTPS_PROXY\.$/,
    );
    assert.doesNotMatch(JSON.stringify(proxied), /s3cret/);

    const unused = await run("", { ...server, HTTPS_PROXY: "http://user:s3cret@127.0.0.1:1" });
    assert.equal(
      unused.stderr,
      "hyperodds-mcp: HTTPS_PROXY is set, but Node.js ignores it unless NODE_USE_ENV_PROXY=1 is set as well.\n",
    );
    assert.match((await run("", {}, ["--help"])).lines.join("\n"), /HTTPS_PROXY[\s\S]*NODE_USE_ENV_PROXY/);
  });
});

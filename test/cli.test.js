import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

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
  });
});

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getMcpConfigForManifest, unpackExtension } from "@anthropic-ai/mcpb";
import { v0_3 } from "@anthropic-ai/mcpb/schemas";
import { standIn } from "./stand-in.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");
const pkg = JSON.parse(read("package.json"));
const manifest = JSON.parse(read("mcpb/manifest.json"));

describe("Claude Desktop extension", () => {
  let work;
  let server;
  let url;
  const forecasts = standIn();
  before(async () => {
    work = mkdtempSync(join(tmpdir(), "hyperodds-mcpb-test-"));
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => {
        raw += d;
      });
      req.on("end", () => {
        const body = JSON.parse(raw);
        if (body.id === undefined) return res.writeHead(202).end();
        const result =
          body.method === "tools/list" ? { tools: manifest.tools } : { ua: req.headers["user-agent"] };
        const answer =
          body.method === "tools/call" ? forecasts.answer(body) : { jsonrpc: "2.0", id: body.id, result };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(answer));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${server.address().port}/mcp`;
  });
  after(() => {
    server.close();
    rmSync(work, { recursive: true, force: true });
  });

  test("the manifest follows the 0.3 spec and carries the package's version", () => {
    assert.equal(manifest.manifest_version, "0.3");
    v0_3.McpbManifestSchema.parse(manifest);
    assert.equal(manifest.version, pkg.version);
    assert.equal(manifest.compatibility.runtimes.node, pkg.engines.node);
  });

  test("the manifest lists the tools the README documents", () => {
    const section = read("README.md").split("\n## Tools\n")[1].split("\n## ")[0];
    const documented = [...section.matchAll(/^\| `(\w+)` /gm)].map((m) => m[1]);
    assert.deepEqual(
      manifest.tools.map((t) => t.name),
      documented,
    );
  });

  test("the forecaster key setting is optional and empty unless the person fills it in", async () => {
    const config = (userConfig) =>
      getMcpConfigForManifest({
        manifest,
        extensionPath: work,
        systemDirs: {},
        userConfig,
        pathSeparator: sep,
      });
    assert.deepEqual((await config({})).env, {
      NODE_USE_ENV_PROXY: "1",
      HYPERODDS_FORECAST_KEY: "",
      HYPERODDS_FORECAST_SIGNING: "true",
    });
    assert.deepEqual((await config({ forecaster_key: "0xabc", forecast_signing: false })).env, {
      NODE_USE_ENV_PROXY: "1",
      HYPERODDS_FORECAST_KEY: "0xabc",
      HYPERODDS_FORECAST_SIGNING: "false",
    });
    assert.equal(manifest.user_config.forecaster_key.sensitive, true);
  });

  test("the packed extension unpacks and runs the way Claude Desktop runs it", {
    timeout: 30_000,
  }, async (t) => {
    const file = join(work, "hyperodds.mcpb");
    await promisify(execFile)(process.execPath, [join(root, "scripts", "mcpb.mjs"), file]);
    const dir = join(work, "installed");
    assert.equal(await unpackExtension({ mcpbPath: file, outputDir: dir, silent: true }), true);
    const shipped = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) =>
        join(e.parentPath, e.name)
          .slice(dir.length + 1)
          .split(sep)
          .join("/"),
      )
      .sort();
    assert.deepEqual(
      shipped.filter((f) => !f.startsWith("node_modules/")),
      [
        "LICENSE",
        "dist/bridge.js",
        "dist/cli.js",
        "dist/forecast.js",
        "dist/key.js",
        "dist/proxy.js",
        "icon-dark.png",
        "icon-light.png",
        "icon.png",
        "manifest.json",
        "package.json",
      ],
    );
    // Only the signing libraries, each with its license, and only the files the bridge loads.
    const libraries = shipped.filter((f) => f.startsWith("node_modules/"));
    for (const lib of ["@noble/curves", "@noble/hashes"])
      for (const f of ["LICENSE", "package.json", lib.endsWith("curves") ? "secp256k1.js" : "sha3.js"])
        assert.ok(libraries.includes(`node_modules/${lib}/${f}`), `${lib}/${f}`);
    assert.deepEqual(
      libraries.filter(
        (f) => !/^node_modules\/@noble\/(curves|hashes)\/[\w/-]+\.js$|\/(LICENSE|package\.json)$/.test(f),
      ),
      [],
    );
    assert.ok(!libraries.some((f) => /\/(ed25519|bls12-381|src\/)/.test(f)));
    const installed = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    // mcpb validate checks "icon" only.
    for (const { src } of installed.icons) assert.ok(existsSync(join(dir, src)), src);
    const config = await getMcpConfigForManifest({
      manifest: installed,
      extensionPath: dir,
      systemDirs: {},
      userConfig: {},
      pathSeparator: sep,
    });
    assert.equal(config.command, "node");
    assert.deepEqual(config.args, [join(dir, "dist", "cli.js")]);
    // Hosts pass their proxy settings as HTTPS_PROXY and friends; Node.js uses them only with this.
    assert.equal(config.env.NODE_USE_ENV_PROXY, "1");

    // Claude Desktop runs "node" with the Node.js it ships; this test's Node stands in for it.
    const home = join(work, "config");
    const env = { ...process.env, ...config.env, HYPERODDS_MCP_URL: url, XDG_CONFIG_HOME: home };
    for (const name of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"]) delete env[name];
    const proc = spawn(process.execPath, config.args, { env });
    t.after(() => proc.kill());
    const exited = new Promise((r) => proc.on("close", r));
    let stdout = "";
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d;
    });
    const answered = new Promise((done, fail) => {
      const timer = setTimeout(() => quit("The extension did not answer within 10 seconds"), 10_000);
      const quit = (why) => {
        clearTimeout(timer);
        fail(new Error(`${why}. Its stderr:\n${stderr || "(empty)"}`));
      };
      proc.on("error", (e) => quit(`The extension did not start (${e.message})`));
      proc.on("close", (code) => quit(`The extension exited with code ${code} before it answered`));
      proc.stdin.on("error", (e) => quit(`The extension stopped reading (${e.message})`));
      proc.stdout.on("data", (d) => {
        stdout += d;
        if (stdout.split("\n").filter(Boolean).length < 3) return;
        clearTimeout(timer);
        done();
      });
    });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    const forecast = { forecasts: [{ outcome: 42400, probabilityBps: 6200 }] };
    proc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "odds_forecast", arguments: forecast } })}\n`,
    );
    await answered;
    proc.stdin.end();
    assert.equal(await exited, 0);
    const answers = new Map(
      stdout
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
        .map((a) => [a.id, a.result]),
    );
    assert.match(answers.get(1).ua, new RegExp(`^hyperodds-mcp/${pkg.version} node/`));
    assert.deepEqual(
      answers.get(2).tools.map((t) => t.name),
      manifest.tools.map((t) => t.name),
    );
    // Signing loads every file it needs from the bundle, and the key lands in the config directory.
    assert.equal(answers.get(3).structuredContent.status, "recorded");
    assert.equal(forecasts.recorded.length, 1);
    assert.ok(existsSync(join(home, "hyperodds", "forecaster.key")));
  });
});

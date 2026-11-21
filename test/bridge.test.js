import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Bridge } from "../dist/bridge.js";
import { openKey } from "../dist/key.js";
import { recover, standIn, TOOLS } from "./stand-in.js";
import { TEST_ADDRESS as CHECKSUMMED, TEST_KEY } from "./vectors.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stream(text, chunks = 1) {
  const bytes = new TextEncoder().encode(text);
  const size = Math.ceil(bytes.length / chunks);
  const body = new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size));
      c.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** A bridge whose server is `handle`; it records what the bridge wrote, logged and sent. */
function harness(handle, timeoutMs, label = "Hyperodds", more = {}) {
  const out = [];
  const logs = [];
  const sent = [];
  const bridge = new Bridge({
    url: "https://mcp.test/mcp",
    label,
    write: (m) => out.push(m),
    log: (l) => logs.push(l),
    userAgent: "test",
    timeoutMs,
    ...more,
    // Like fetch, it gives up as soon as the signal aborts, whatever the server is doing.
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      sent.push({ url, headers: init.headers, body });
      return new Promise((done, fail) => {
        if (init.signal.aborted) return fail(init.signal.reason);
        init.signal.addEventListener("abort", () => fail(init.signal.reason), { once: true });
        Promise.resolve()
          .then(() => handle(body))
          .then(done, fail);
      });
    },
  });
  const send = async (...lines) => {
    for (const l of lines) bridge.receive(typeof l === "string" ? l : JSON.stringify(l));
    await bridge.idle();
  };
  return { bridge, out, logs, sent, send };
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};
const accepted = () => new Response(null, { status: 202 });

describe("bridge", () => {
  test("relays answers, sends the negotiated protocol version after initialize, and writes nothing back for a notification", async () => {
    const h = harness((body) => {
      if (body.id === undefined) return accepted();
      if (body.method === "initialize")
        return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } });
      return json({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
    });
    await h.send(initialize);
    await h.send(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    );
    assert.deepEqual(h.out, [
      { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", id: 2, result: { tools: [] } },
    ]);
    assert.equal(h.sent[0].url, "https://mcp.test/mcp");
    assert.equal(h.sent[0].headers["mcp-protocol-version"], undefined);
    assert.equal(h.sent[2].headers["mcp-protocol-version"], "2025-06-18");
    assert.equal(h.sent[2].headers.accept, "application/json, text/event-stream");
  });

  test("a refusal the server sent before reading the message answers the request that caused it", async () => {
    const limited = () =>
      json({ jsonrpc: "2.0", id: null, error: { code: -32028, message: "Too many requests" } }, 429);
    const h = harness(limited);
    await h.send({ jsonrpc: "2.0", id: 7, method: "tools/list" });
    assert.deepEqual(h.out, [
      { jsonrpc: "2.0", id: 7, error: { code: -32028, message: "Too many requests" } },
    ]);

    // A notification gets no reply, so its refusal goes to the log instead.
    const n = harness(limited);
    await n.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    assert.deepEqual(n.out, []);
    assert.equal(n.logs.length, 1);
    assert.match(n.logs[0], /refused a message/);
  });

  test("a notification the server turns away without a JSON-RPC answer goes to the log", async () => {
    const answers = {
      edge: () => new Response("<html>502</html>", { status: 502, headers: { "content-type": "text/html" } }),
      notRpc: () => json({ error: "method not allowed" }, 405),
    };
    for (const [name, answer] of Object.entries(answers)) {
      const h = harness(answer);
      await h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      assert.deepEqual(h.out, [], name);
      assert.equal(h.logs.length, 1, name);
      assert.match(h.logs[0], /^Hyperodds replied HTTP \d+ to a message the client sent\.$/, name);
    }

    const h = harness(accepted);
    await h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    assert.deepEqual(h.logs, []);
  });

  test("every request gets one answer, whatever comes back", async () => {
    const answers = {
      edge: () => new Response("<html>502</html>", { status: 502, headers: { "content-type": "text/html" } }),
      notRpc: () => json({ error: "not found" }, 404),
      broken: () => new Response("{", { headers: { "content-type": "application/json" } }),
      empty: accepted,
    };
    for (const [name, answer] of Object.entries(answers)) {
      const h = harness(answer);
      await h.send({ jsonrpc: "2.0", id: name, method: "tools/list" });
      assert.equal(h.out.length, 1, name);
      assert.equal(h.out[0].id, name);
      assert.equal(h.out[0].error.code, -32603);
    }
  });

  test("a server that does not answer in time, or cannot be reached, is reported on the request", async () => {
    const slow = harness(() => new Promise(() => {}), 50);
    await slow.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.equal(slow.out[0].error.message, "Hyperodds did not answer within 0.05 seconds.");

    const down = harness(() => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    });
    await down.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.equal(down.out[0].error.message, "Could not reach Hyperodds (ECONNREFUSED).");
    await down.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(down.out.length, 1);
    assert.deepEqual(down.logs, [
      "Could not reach Hyperodds (ECONNREFUSED).",
      "Could not reach Hyperodds (ECONNREFUSED).",
    ]);

    // A server set by hand is named, so a wrong URL is easy to spot.
    const typo = harness(
      () => json({ error: "not found" }, 404),
      undefined,
      "http://localhost:3110/mcp/ (set by HYPERODDS_MCP_URL)",
    );
    await typo.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    assert.equal(
      typo.out[0].error.message,
      "http://localhost:3110/mcp/ (set by HYPERODDS_MCP_URL) replied HTTP 404 with no JSON-RPC response.",
    );
  });

  test("the network note goes on errors where nothing answered, and only there", async () => {
    const note = "Requests go through the proxy http://proxy.corp:8080 from HTTPS_PROXY.";
    const answers = {
      down: () => {
        throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      },
      slow: () => new Promise(() => {}),
      edge: () => new Response("<html>502</html>", { status: 502, headers: { "content-type": "text/html" } }),
    };
    const messages = {};
    for (const [name, answer] of Object.entries(answers)) {
      const h = harness(answer, 50, "Hyperodds", { networkNote: note });
      await h.send({ jsonrpc: "2.0", id: name, method: "tools/list" });
      messages[name] = h.out[0].error.message;
    }
    assert.deepEqual(messages, {
      down: `Could not reach Hyperodds (ECONNREFUSED). ${note}`,
      slow: `Hyperodds did not answer within 0.05 seconds. ${note}`,
      edge: "Hyperodds replied HTTP 502 with no JSON-RPC response.",
    });
  });

  test("closing drops what is still out, without an answer", async () => {
    const h = harness(() => new Promise(() => {}));
    h.bridge.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    h.bridge.close();
    await h.bridge.idle();
    assert.deepEqual(h.out, []);
    assert.deepEqual(h.logs, []);
  });

  test("a cancelled request is dropped without an answer", async () => {
    const h = harness((body) => (body.id === undefined ? accepted() : new Promise(() => {})));
    await h.send(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "odds_new" } },
      { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 5 } },
    );
    assert.deepEqual(h.out, []);
  });

  test("an event stream is read event by event, up to the answer", async () => {
    const h = harness((body) =>
      stream(
        'event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\r\n\r\n' +
          `data: {"jsonrpc":"2.0","id":${body.id},"method":"elicitation/create","params":{}}\r\n\r\n` +
          `data: {"jsonrpc":"2.0","id":${body.id},\r\ndata: "result":{}}\r\n\r\n` +
          "data: not json\r\n\r\n",
        23,
      ),
    );
    await h.send({ jsonrpc: "2.0", id: 9, method: "tools/list" });
    assert.deepEqual(h.out, [
      { jsonrpc: "2.0", method: "notifications/message", params: {} },
      { jsonrpc: "2.0", id: 9, method: "elicitation/create", params: {} },
      { jsonrpc: "2.0", id: 9, result: {} },
    ]);
  });

  test("a batch goes out message by message, and each request is answered", async () => {
    const h = harness((body) => json({ jsonrpc: "2.0", id: body.id, result: {} }));
    await h.send([{ jsonrpc: "2.0", id: 10, method: "ping" }, { jsonrpc: "2.0", id: 11, method: "ping" }, 3]);
    assert.deepEqual(
      h.sent.map((s) => s.body.id),
      [10, 11],
    );
    assert.deepEqual(h.out.map((m) => m.id).sort(), [10, 11, null]);
    assert.equal(h.out.find((m) => m.id === null).error.code, -32600);
  });

  test("a line that is not JSON is a parse error, and JSON that is not a message is an invalid request", async () => {
    const h = harness(() => json({}));
    await h.send(
      "not json",
      "42",
      "[]",
      "  ",
      { jsonrpc: "2.0", id: 63 },
      { jsonrpc: "2.0", id: 66, method: 42 },
      { jsonrpc: "1.0", id: 64, method: "ping" },
      {},
    );
    assert.deepEqual(
      h.out.map((m) => [m.id, m.error.code]),
      [
        [null, -32700],
        [null, -32600],
        [null, -32600],
        [63, -32600],
        [66, -32600],
        [64, -32600],
        [null, -32600],
      ],
    );
    assert.equal(h.sent.length, 0);
  });
});

describe("forecasts signed on this computer", () => {
  const work = mkdtempSync(join(tmpdir(), "hyperodds-mcp-bridge-test-"));
  after(() => rmSync(work, { recursive: true, force: true }));
  let homes = 0;
  const TEST_ADDRESS = CHECKSUMMED.toLowerCase();
  const ten = Array.from({ length: 10 }, (_, i) => ({ outcome: 42400 + i, probabilityBps: 1000 + 800 * i }));

  /** A bridge on the stand-in server, with its own config directory unless `keys` is given. */
  function signing(options = {}, keys = {}) {
    const server = standIn(options);
    const dir = join(work, String(++homes));
    const path = join(dir, "hyperodds", "forecaster.key");
    const h = harness((body) => json(server.answer(body)), undefined, "Hyperodds", {
      keys: { path, log: (l) => h.logs.push(l), ...keys },
    });
    const call = (id, name, args) =>
      h.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    return { ...h, server, path, dir, call };
  }

  test("one call drafts for this computer's forecaster, signs the draft and records it", async () => {
    const h = signing();
    await h.call(1, "odds_forecast", { forecasts: ten });
    const key = readFileSync(h.path, "utf8").trim();
    const [{ result }] = h.out;
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.status, "recorded");
    const { forecaster } = result.structuredContent;
    assert.deepEqual(
      result.structuredContent.forecasts.map(({ outcome, probabilityBps }) => ({ outcome, probabilityBps })),
      ten,
    );
    assert.equal(result.content.length, 2);
    assert.equal(
      result.content[1].text,
      `Signed on this computer by forecaster ${forecaster}. Its public record is https://usehyperodds.com/forecasts/${forecaster}, where each forecast appears after its market's cutoff.`,
    );

    const [draft, submission] = h.sent.map((s) => s.body);
    assert.equal(h.sent.length, 2);
    assert.deepEqual(draft.params.arguments, { forecasts: ten, forecaster });
    assert.equal(draft.id, 1);
    const { signed } = submission.params.arguments;
    assert.deepEqual(Object.keys(submission.params.arguments), ["signed"]);
    assert.equal(signed.type, "ForecastBatch");
    assert.equal(recover(signed.type, signed.message, signed.signature), forecaster);
    assert.equal(h.server.recorded.length, 10);
    assert.equal(typeof signed.draft, "string");

    // The key stays in its file: not in the answer, the log or anything sent.
    const seen = JSON.stringify([h.out, h.logs, h.sent]).toLowerCase();
    assert.ok(!seen.includes(key.slice(2)));
    assert.equal(h.logs.length, 1);
    assert.match(h.logs[0], new RegExp(`^Made forecaster ${forecaster} and saved its key to `));

    // A second forecast signs with the same key; one entry goes as a Forecast.
    await h.call(2, "odds_forecast", { forecasts: [ten[0]] });
    assert.equal(h.out[1].result.structuredContent.forecaster, forecaster);
    assert.equal(h.sent[3].body.params.arguments.signed.type, "Forecast");
    assert.equal(h.logs.length, 1);
  });

  test("uses HYPERODDS_FORECAST_KEY when it is set, and keeps it out of everything", async () => {
    const key = randomBytes(32).toString("hex");
    const h = signing({}, { env: key });
    await h.call(1, "odds_forecast", { forecasts: ten.slice(0, 2) });
    const { forecaster } = h.out[0].result.structuredContent;
    assert.equal(forecaster, openKey({ env: key, path: h.path, log: assert.fail }, false).address);
    assert.equal(h.server.recorded.length, 2);
    assert.throws(() => readdirSync(h.dir), { code: "ENOENT" });
    assert.ok(!JSON.stringify([h.out, h.logs, h.sent]).toLowerCase().includes(key));
    assert.deepEqual(h.logs, []);
  });

  test("names the record on the site that made the sign link", async () => {
    const h = signing({ web: "http://localhost:3291" });
    await h.call(1, "odds_forecast", { forecasts: ten.slice(0, 1) });
    assert.match(
      h.out[0].result.content[1].text,
      /record is http:\/\/localhost:3291\/forecasts\/0x[0-9a-f]{40},/,
    );
  });

  test("signs nothing when the draft is not what was asked for", async () => {
    const tampered = {
      "a changed domain": (td) => ({ ...td, domain: { ...td.domain, chainId: 1 } }),
      "extra types": (td) => ({
        ...td,
        types: { ...td.types, Permit: [{ name: "value", type: "uint256" }] },
      }),
      "another forecaster": (td) => ({
        ...td,
        message: { ...td.message, forecaster: "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf" },
      }),
      "other entries": (td) => ({
        ...td,
        message: {
          ...td.message,
          forecasts: td.message.forecasts.map((e) => ({ ...e, probabilityBps: 9999 })),
        },
      }),
      "no typed data": () => null,
    };
    for (const [name, tamper] of Object.entries(tampered)) {
      const h = signing({ tamper });
      await h.call(1, "odds_forecast", { forecasts: ten.slice(0, 3) });
      assert.equal(h.sent.length, 1, name);
      assert.equal(h.server.recorded.length, 0, name);
      const { result } = h.out[0];
      assert.equal(result.isError, true, name);
      assert.match(
        result.content[0].text,
        /^Hyperodds sent a draft that differs from the forecasts asked for, so nothing was signed: /,
        name,
      );
      assert.equal(h.logs.at(-1), result.content[0].text, name);
    }
  });

  test("passes the server's refusals through, at the draft or at the submission", async () => {
    const closed = {
      content: [{ type: "text", text: "Forecasts on this market closed an hour before its cutoff." }],
      structuredContent: {
        code: "entries_refused",
        entries: [{ index: 0, outcome: 42400, code: "past_close" }],
      },
      isError: true,
    };
    const atDraft = signing();
    const draftRefused = harness(
      (body) => json({ jsonrpc: "2.0", id: body.id, result: closed }),
      undefined,
      "Hyperodds",
      { keys: { path: atDraft.path, log: () => {} } },
    );
    await draftRefused.send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "odds_forecast", arguments: { forecasts: ten } },
    });
    assert.deepEqual(draftRefused.out, [{ jsonrpc: "2.0", id: 4, result: closed }]);
    assert.equal(draftRefused.sent.length, 1);

    // A nonce already used: the stand-in refuses the second submission of the same signed message.
    const h = signing();
    await h.call(1, "odds_forecast", { forecasts: ten });
    const again = { ...h.sent[1].body, id: 2 };
    await h.send(again);
    assert.equal(h.out[1].result.isError, true);
    assert.equal(h.out[1].result.structuredContent.code, "replayed");
  });

  test("leaves calls alone that it does not sign", async () => {
    const h = signing({}, { env: TEST_KEY });
    const other = "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf";
    const signed = { type: "Forecast", message: {}, signature: "0x" };
    await h.call(1, "odds_forecast", { forecasts: ten, forecaster: other });
    await h.call(2, "odds_forecast", { signed });
    await h.call(3, "odds_forecast_record", { address: other });
    await h.call(4, "odds_markets", { limit: 1 });
    assert.deepEqual(
      h.sent.map((s) => s.body.params.arguments),
      [{ forecasts: ten, forecaster: other }, { signed }, { address: other }, { limit: 1 }],
    );
    assert.equal(h.out[0].result.structuredContent.status, "draft");
    assert.equal(
      h.out[0].result.structuredContent.url.startsWith("https://usehyperodds.com/forecasts/sign/"),
      true,
    );

    // This computer's own address, named, still signs here.
    await h.call(5, "odds_forecast", {
      forecasts: ten.slice(0, 1),
      forecaster: TEST_ADDRESS.toUpperCase().replace("0X", "0x"),
    });
    assert.equal(h.out.at(-1).result.structuredContent.status, "recorded");
  });

  test("reads this computer's record when odds_forecast_record has no address", async () => {
    const none = signing();
    await none.call(1, "odds_forecast_record", {});
    assert.equal(none.sent.length, 0);
    assert.equal(none.out[0].result.isError, true);
    assert.match(none.out[0].result.content[0].text, /^No forecast has been signed on this computer yet/);
    assert.throws(() => readdirSync(none.dir), { code: "ENOENT" });

    const h = signing({}, { env: TEST_KEY });
    await h.call(1, "odds_forecast", { forecasts: ten });
    await h.call(2, "odds_forecast_record", { limit: 5 });
    assert.deepEqual(h.sent.at(-1).body.params.arguments, { limit: 5, address: TEST_ADDRESS });
    assert.equal(h.out[1].result.structuredContent.pending, 10);
    await h.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "odds_forecast_record" } });
    assert.deepEqual(h.sent.at(-1).body.params.arguments, { address: TEST_ADDRESS });
  });

  test("tells the client's model that forecasts are signed here", async () => {
    const h = signing();
    await h.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = Object.fromEntries(h.out[0].result.tools.map((t) => [t.name, t]));
    assert.match(tools.odds_forecast.description, /This bridge signs on this computer/);
    assert.match(tools.odds_forecast_record.description, /Leave out address/);
    assert.deepEqual(tools.odds_forecast_record.inputSchema.required, []);
    assert.deepEqual(tools.odds_leaderboard, TOOLS[2]);
  });

  test("a key it cannot use is a tool error that names the variable, not the value", async () => {
    const h = signing({}, { env: "not a key" });
    await h.call(1, "odds_forecast", { forecasts: ten });
    assert.equal(h.sent.length, 0);
    assert.equal(h.out[0].result.isError, true);
    assert.match(h.out[0].result.content[0].text, /^HYPERODDS_FORECAST_KEY is not a private key/);
    assert.ok(!JSON.stringify([h.out, h.logs]).includes("not a key"));
  });

  test("with signing off, forecast calls and the tool list pass through untouched", async () => {
    const server = standIn();
    const h = harness((body) => json(server.answer(body)));
    await h.send(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "odds_forecast", arguments: { forecasts: ten } },
      },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "odds_forecast_record", arguments: {} },
      },
    );
    assert.deepEqual(h.sent[0].body.params.arguments, { forecasts: ten });
    const byId = Object.fromEntries(h.out.map((m) => [m.id, m]));
    assert.equal(byId[1].result.structuredContent.status, "draft");
    assert.equal(byId[1].result.structuredContent.typedData, null);
    assert.deepEqual(byId[2].result.tools, TOOLS);
    assert.equal(byId[3].error.code, -32602);
  });
});

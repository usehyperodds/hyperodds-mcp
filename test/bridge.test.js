import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Bridge } from "../dist/bridge.js";

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
function harness(handle, timeoutMs, label = "Hyperodds") {
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
    assert.match(n.logs[0], /refused a message/);
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

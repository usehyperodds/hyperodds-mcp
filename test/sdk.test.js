import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { digest, forecastMessage } from "../dist/forecast.js";
import { openKey } from "../dist/key.js";
import { serve, standIn } from "./stand-in.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "hyperodds-mcp-sdk-test-"));
after(() => rmSync(work, { recursive: true, force: true }));
let homes = 0;

const two = [
  { outcome: 42400, probabilityBps: 6200 },
  { outcome: 42501, probabilityBps: 3100 },
];

/**
 * The official MCP client running the bridge over stdio, as an agent's runtime does. It reads the
 * tool list first, so it checks every answer against its tool's output schema and throws on a
 * mismatch.
 */
async function connect(t, server, env = {}, answer) {
  const { url, close } = await serve(server);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli],
    env: { HYPERODDS_MCP_URL: url, XDG_CONFIG_HOME: join(work, String(++homes)), ...env },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "hyperodds-sdk-test", version: "1.0.0" },
    { capabilities: answer ? { elicitation: {} } : {} },
  );
  if (answer) client.setRequestHandler(ElicitRequestSchema, answer);
  t.after(async () => {
    await client.close();
    close();
  });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.ok(tools.find((tool) => tool.name === "odds_forecast").outputSchema);
  return (name, args) => client.callTool({ name, arguments: args });
}

describe("the official MCP SDK client", () => {
  test("takes a recorded forecast, and each refusal the bridge makes", async (t) => {
    const call = await connect(t, standIn());
    const recorded = await call("odds_forecast", { forecasts: two });
    assert.equal(recorded.isError, undefined);
    assert.equal(recorded.structuredContent.status, "recorded");
    assert.match(recorded.content[1].text, /^Signed on this computer by forecaster 0x[0-9a-f]{40}\./);

    const refusals = [
      [Array.from({ length: 51 }, (_, i) => ({ outcome: i, probabilityBps: 5000 })), "batch_size"],
      [[], "batch_size"],
      [[{ outcome: 42400, probabilityBps: 0 }], "invalid_request"],
      [[{ outcome: "42400", probabilityBps: 6200 }], "invalid_request"],
    ];
    for (const [forecasts, code] of refusals) {
      const refused = await call("odds_forecast", { forecasts });
      assert.equal(refused.isError, true, code);
      assert.deepEqual(refused.structuredContent, { status: "refused", code, entries: [] });
    }

    const record = await call("odds_forecast_record", {});
    assert.equal(record.structuredContent.pending, 2);
  });

  test("takes the server's refusals the bridge explains: a clock that is off, a forecast out of order", async (t) => {
    const late = await connect(t, standIn({ now: () => Date.now() - 14 * 60_000 }));
    const stale = await late("odds_forecast", { forecasts: two });
    assert.equal(stale.isError, true);
    assert.deepEqual(stale.structuredContent, { status: "refused", code: "stale_time", entries: [] });
    assert.match(stale.content[0].text, /clock is about 14 minutes ahead/);

    // Another app with the same key signed a forecast on 42400 a minute ahead of this clock.
    const server = standIn();
    const key = randomBytes(32).toString("hex");
    const other = openKey({ env: key, path: join(work, "unused"), log: () => {} }, false);
    const ahead = forecastMessage(other.address, [two[0]], Math.floor(Date.now() / 1000) + 60);
    const signed = { ...ahead, signature: other.sign(digest(ahead)) };
    server.answer({
      jsonrpc: "2.0",
      id: 0,
      method: "tools/call",
      params: { name: "odds_forecast", arguments: { signed } },
    });

    const call = await connect(t, server, { HYPERODDS_FORECAST_KEY: key });
    const refused = await call("odds_forecast", { forecasts: two });
    assert.equal(refused.isError, true);
    assert.equal(refused.structuredContent.status, "refused");
    assert.equal(refused.structuredContent.entries[0].code, "out_of_order");
    assert.match(refused.content.at(-1).text, /^Nothing was entered\. .* on outcome 42400, signed later/);
  });

  test("takes the bridge's errors that carry no refusal code", async (t) => {
    const badKey = await connect(t, standIn(), { HYPERODDS_FORECAST_KEY: "not a key" });
    const keyError = await badKey("odds_forecast", { forecasts: two });
    assert.equal(keyError.isError, true);
    assert.equal(keyError.structuredContent, undefined);
    assert.match(keyError.content[0].text, /^HYPERODDS_FORECAST_KEY is not a private key/);

    const fresh = await connect(t, standIn());
    const empty = await fresh("odds_forecast_record", {});
    assert.equal(empty.isError, true);
    assert.match(empty.content[0].text, /^No forecast has been signed on this computer yet/);
  });

  test("asks a client that takes elicitation forms to confirm, and enters only what it accepts", async (t) => {
    const server = standIn();
    const asked = [];
    let action = "accept";
    const call = await connect(t, server, {}, (request) => {
      asked.push(request.params);
      return { action };
    });
    const recorded = await call("odds_forecast", { forecasts: two });
    assert.equal(recorded.structuredContent.status, "recorded");
    assert.match(asked[0].message, /^Sign and enter these 2 forecasts in Hyperodds' public record/);
    assert.deepEqual(asked[0].requestedSchema, { type: "object", properties: {} });

    action = "decline";
    const declined = await call("odds_forecast", { forecasts: two });
    assert.equal(declined.isError, true);
    assert.equal(
      declined.content[0].text,
      "Nothing was entered: the person did not confirm these forecasts.",
    );
    assert.equal(server.recorded.length, 2);
  });

  test("throws on a refusal without its status, the shape refusals had before", async (t) => {
    const call = await connect(t, standIn({ bareRefusals: true, now: () => Date.now() - 14 * 60_000 }));
    await assert.rejects(call("odds_forecast", { forecasts: two }), { code: -32602 });
  });
});

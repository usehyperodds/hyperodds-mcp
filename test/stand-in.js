// The hosted server's forecast tools as the forecast record's spec fixes them: drafts, with typed
// data when a forecaster is named; signed submissions (message version 2), checked for a valid
// low-s signature, each market's title and first side, the time window, nonce reuse and signed-time
// order; and each forecaster's pending count. odds_fair names any outcome but the unlisted ones.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { DOMAIN, digest, TYPES } from "../dist/forecast.js";

// The spec's refusal codes, whole-request and per entry, which the server's output schema lists.
const REFUSAL_CODES = [
  "invalid_request",
  "batch_size",
  "duplicate_outcome",
  "stale_time",
  "bad_signature",
  "not_found",
  "replayed",
  "draft_mismatch",
  "draft_expired",
  "too_large",
  "entries_refused",
  "mixed_days",
  "rate_limited",
  "daily_cap",
  "ip_daily_cap",
  "ip_day_cap",
  "day_full",
  "internal",
  "loading",
];
const ENTRY_CODES = [
  "not_listed",
  "fallback",
  "no_event_time",
  "touch_market",
  "past_close",
  "past_cutoff",
  "out_of_order",
  "market_mismatch",
];

export const TOOLS = [
  {
    name: "odds_forecast",
    // The hosted server's own description, whose sentences on sign links the bridge replaces.
    description:
      "Records a probability for one or more HIP-4 markets in Hyperodds' public forecast record, scored against " +
      "Hyperliquid's settlement. Give signed (an EIP-712 Forecast or ForecastBatch signed by the forecaster's own key) " +
      "to record it. Without a key, give forecasts and get a sign link to show the person, whose wallet signs it in the " +
      "browser; with forecaster as well, the answer also carries typed data a local key can sign. Up to 50 markets whose " +
      "cutoffs fall on one UTC day; entries close an hour before each market's cutoff. Forecasts stay private until " +
      "the cutoff. Hyperodds never holds a key.",
    inputSchema: {
      type: "object",
      properties: {
        signed: { type: "object" },
        forecasts: { type: "array" },
        forecaster: { type: "string" },
      },
    },
    // Strict, like the server's, so an MCP client refuses an answer of any other shape.
    outputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["recorded", "draft", "refused"] },
        code: { type: "string", enum: REFUSAL_CODES },
        entries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              index: { type: "integer" },
              outcome: { type: "integer" },
              code: { type: "string", enum: ENTRY_CODES },
              error: { type: "string" },
            },
            required: ["index", "outcome", "code", "error"],
          },
        },
        day: { type: "string" },
        forecaster: { type: ["string", "null"] },
        forecasts: { type: "array" },
        batch: { type: "integer" },
        draft: { type: "string" },
        url: { type: "string" },
        expiresAt: { type: "string" },
        typedData: { type: ["object", "null"] },
      },
      required: ["status"],
      additionalProperties: false,
    },
  },
  {
    name: "odds_forecast_record",
    description: "Gives one forecaster's public record.",
    inputSchema: {
      type: "object",
      properties: { address: { type: "string" }, limit: { type: "integer" } },
      required: ["address"],
    },
    outputSchema: {
      type: "object",
      properties: {
        forecaster: { type: "string" },
        summary: { type: ["object", "null"] },
        pending: { type: "integer" },
        total: { type: "integer" },
        forecasts: { type: "array" },
      },
      required: ["forecaster", "summary", "pending", "total", "forecasts"],
      additionalProperties: false,
    },
  },
  { name: "odds_leaderboard", description: "Ranks forecasters.", inputSchema: { type: "object" } },
  {
    name: "odds_fair",
    description: "Gives one market's fair line.",
    inputSchema: { type: "object", properties: { outcome: { type: "integer" } }, required: ["outcome"] },
  },
];

/** A listed market's title and sides, as odds_fair gives them. */
export const marketOf = (outcome) => ({
  title: `BTC above ${outcome} on Nov 22 at 06:00 UTC`,
  sides: ["Yes", "No"],
});

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });

const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/** The `s` of a 65-byte r ‖ s ‖ v signature. */
export const sOf = (signature) => BigInt(`0x${signature.slice(66, 130)}`);
export const lowS = (signature) => sOf(signature) <= HALF_N;

export function recover(type, message, signature) {
  const bytes = hexToBytes(signature.slice(2));
  const sig = Uint8Array.of(bytes[64] - 27, ...bytes.subarray(0, 64));
  const point = secp256k1.Signature.fromBytes(sig, "recovered").recoverPublicKey(digest({ type, message }));
  const publicKey = point.toBytes(false);
  return `0x${bytesToHex(keccak_256(publicKey.subarray(1)).subarray(12))}`;
}

/**
 * `now` is the stand-in's clock in milliseconds. `bareRefusals` answers refusals without their
 * status, as the server did before refusals had a shape its output schema accepts.
 */
export function standIn({
  web = "https://usehyperodds.com",
  now = Date.now,
  bareRefusals = false,
  unlisted = [],
} = {}) {
  const refusal = (code, error, entries = []) => ({
    content: [{ type: "text", text: error }],
    structuredContent: bareRefusals ? { code, entries } : { status: "refused", code, entries },
    isError: true,
  });
  const used = new Set();
  const latest = new Map();
  const pending = new Map();
  const recorded = [];
  const drafts = [];
  let batch = 0;

  function draft({ forecasts, forecaster }) {
    const time = Math.floor(now() / 1000);
    const nonce = (randomBytes(8).readBigUInt64BE() >> 1n).toString();
    const id = randomBytes(16).toString("base64url");
    drafts.push(id);
    let typedData = null;
    if (forecaster) {
      const named = forecasts.map(({ outcome, probabilityBps }) => {
        const { title, sides } = marketOf(outcome);
        return { outcome, market: title, side: sides[0], probabilityBps };
      });
      const domain = { ...DOMAIN, salt: `0x${bytesToHex(DOMAIN.salt)}` };
      typedData =
        named.length === 1
          ? {
              domain,
              types: TYPES.Forecast,
              primaryType: "Forecast",
              message: { forecaster, ...named[0], time, nonce },
            }
          : {
              domain,
              types: TYPES.ForecastBatch,
              primaryType: "ForecastBatch",
              message: { forecaster, forecasts: named, time, nonce },
            };
    }
    return ok({
      status: "draft",
      draft: id,
      url: `${web}/forecasts/sign/${id}`,
      expiresAt: new Date(now() + 30 * 60_000).toISOString(),
      forecaster: forecaster ?? null,
      day: "2026-11-22",
      forecasts,
      typedData,
    });
  }

  function submit({ type, message, signature }) {
    const forecaster = message.forecaster.toLowerCase();
    if (!lowS(signature) || recover(type, message, signature) !== forecaster)
      return refusal("bad_signature", "The signature does not match the forecaster.");
    if (Math.abs(message.time - now() / 1000) > 600) return refusal("stale_time", "The time is stale.");
    if (used.has(`${forecaster}:${message.nonce}`))
      return refusal("replayed", "This nonce was already used by this forecaster.");
    const entries = type === "Forecast" ? [message] : message.forecasts;
    const named = (e) => e.market === marketOf(e.outcome).title && e.side === marketOf(e.outcome).sides[0];
    const mismatched = entries
      .map(({ outcome }, index) => ({ index, outcome }))
      .filter((_, i) => !named(entries[i]));
    if (mismatched.length > 0)
      return refusal(
        "entries_refused",
        "The signed market or side isn't this market's.",
        mismatched.map((e) => ({
          ...e,
          code: "market_mismatch",
          error: "The signed market or side isn't this market's.",
        })),
      );
    const late = entries
      .map(({ outcome }, index) => ({ index, outcome }))
      .filter(({ outcome }) => message.time <= (latest.get(`${forecaster}:${outcome}`) ?? -1));
    if (late.length > 0)
      return refusal(
        "entries_refused",
        "One or more forecasts were refused.",
        late.map((e) => ({ ...e, code: "out_of_order", error: "A later forecast is recorded." })),
      );
    used.add(`${forecaster}:${message.nonce}`);
    for (const { outcome } of entries) latest.set(`${forecaster}:${outcome}`, message.time);
    batch++;
    const forecasts = entries.map(({ outcome, probabilityBps }) => {
      recorded.push({ forecaster, outcome, probabilityBps, batch, signature });
      return { id: recorded.length, outcome, probabilityBps, cutoff: "2026-11-22T06:00:00.000Z" };
    });
    pending.set(forecaster, (pending.get(forecaster) ?? 0) + forecasts.length);
    return ok({ status: "recorded", batch, forecaster, day: "2026-11-22", forecasts });
  }

  function fair({ outcome }) {
    if (unlisted.includes(outcome))
      return { content: [{ type: "text", text: `No market with outcome id ${outcome}.` }], isError: true };
    return ok({
      untrusted: { note: "", fields: [] },
      asOf: new Date(now()).toISOString(),
      outcome,
      ...marketOf(outcome),
      fair: null,
    });
  }

  function call(name, args) {
    if (name === "odds_forecast") return args.signed ? submit(args.signed) : draft(args);
    if (name === "odds_fair") return fair(args);
    if (name === "odds_forecast_record") {
      const forecaster = args.address.toLowerCase();
      return ok({
        forecaster,
        summary: null,
        pending: pending.get(forecaster) ?? 0,
        total: 0,
        forecasts: [],
      });
    }
    return ok({ asOf: new Date(now()).toISOString(), rows: [] });
  }

  /** A JSON-RPC message in, the JSON-RPC answer out, as the hosted server's /mcp gives it. */
  function answer(body) {
    if (body.id === undefined) return null;
    const reply = (result) => ({ jsonrpc: "2.0", id: body.id, result });
    if (body.method === "initialize")
      return reply({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "hyperodds-stand-in", version: "1.0.0" },
      });
    if (body.method === "tools/list") return reply({ tools: structuredClone(TOOLS) });
    const { name, arguments: args = {} } = body.params ?? {};
    if (name === "odds_forecast_record" && typeof args.address !== "string")
      return { jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "address: Required" } };
    return reply(call(name, args));
  }

  return { recorded, drafts, answer, now };
}

/** Serves a stand-in at /mcp over HTTP; resolves to its URL and a way to stop it. */
export async function serve(server) {
  const http = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => {
      raw += d;
    });
    req.on("end", () => {
      const answer = server.answer(JSON.parse(raw));
      if (!answer) return res.writeHead(202).end();
      // The Date header shows the stand-in's own clock, as a real server's shows its own.
      const date = new Date(server.now()).toUTCString();
      res.writeHead(200, { "content-type": "application/json", date }).end(JSON.stringify(answer));
    });
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${http.address().port}/mcp`, close: () => http.close() };
}

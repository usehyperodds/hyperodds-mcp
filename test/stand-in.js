// A stand-in for the hosted server's forecast tools, as docs/feature/forecasts.md in the Hyperodds
// repository fixes them: drafts with typed data when a forecaster is named, signed submissions
// checked by signature and nonce, and each forecaster's pending count.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { DOMAIN, digest, TYPES } from "../dist/forecast.js";

export const TOOLS = [
  {
    name: "odds_forecast",
    description: "Records a probability for one or more HIP-4 markets in Hyperodds' public forecast record.",
    inputSchema: {
      type: "object",
      properties: {
        signed: { type: "object" },
        forecasts: { type: "array" },
        forecaster: { type: "string" },
      },
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
  },
  { name: "odds_leaderboard", description: "Ranks forecasters.", inputSchema: { type: "object" } },
];

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
const refusal = (code, error) => ({
  content: [{ type: "text", text: error }],
  structuredContent: { code, entries: [] },
  isError: true,
});

export function recover(type, message, signature) {
  const bytes = hexToBytes(signature.slice(2));
  const sig = Uint8Array.of(bytes[64] - 27, ...bytes.subarray(0, 64));
  const point = secp256k1.Signature.fromBytes(sig, "recovered").recoverPublicKey(digest({ type, message }));
  const publicKey = point.toBytes(false);
  return `0x${bytesToHex(keccak_256(publicKey.subarray(1)).subarray(12))}`;
}

/**
 * `tamper` may change a draft's typed data before it goes out, as a server that is not to be
 * trusted would. `now` is the stand-in's clock in milliseconds.
 */
export function standIn({ web = "https://usehyperodds.com", tamper = (td) => td, now = Date.now } = {}) {
  const used = new Set();
  const pending = new Map();
  const recorded = [];
  let batch = 0;

  function draft({ forecasts, forecaster }) {
    const time = Math.floor(now() / 1000);
    const nonce = (randomBytes(8).readBigUInt64BE() >> 1n).toString();
    const id = randomBytes(16).toString("base64url");
    let typedData = null;
    if (forecaster) {
      typedData =
        forecasts.length === 1
          ? {
              domain: DOMAIN,
              types: TYPES.Forecast,
              primaryType: "Forecast",
              message: { forecaster, ...forecasts[0], time, nonce },
            }
          : {
              domain: DOMAIN,
              types: TYPES.ForecastBatch,
              primaryType: "ForecastBatch",
              message: { forecaster, forecasts, time, nonce },
            };
      typedData = tamper(structuredClone(typedData));
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
    if (recover(type, message, signature) !== forecaster)
      return refusal("bad_signature", "The signature does not match the forecaster.");
    if (Math.abs(message.time - now() / 1000) > 600) return refusal("stale_time", "The time is stale.");
    if (used.has(`${forecaster}:${message.nonce}`))
      return refusal("replayed", "This nonce was already used by this forecaster.");
    used.add(`${forecaster}:${message.nonce}`);
    const entries = type === "Forecast" ? [message] : message.forecasts;
    batch++;
    const forecasts = entries.map(({ outcome, probabilityBps }) => {
      recorded.push({ forecaster, outcome, probabilityBps, batch, signature });
      return { id: recorded.length, outcome, probabilityBps, cutoff: "2026-11-22T06:00:00.000Z" };
    });
    pending.set(forecaster, (pending.get(forecaster) ?? 0) + forecasts.length);
    return ok({ status: "recorded", batch, forecaster, day: "2026-11-22", forecasts });
  }

  function call(name, args) {
    if (name === "odds_forecast") return args.signed ? submit(args.signed) : draft(args);
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
      return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} } });
    if (body.method === "tools/list") return reply({ tools: structuredClone(TOOLS) });
    const { name, arguments: args = {} } = body.params ?? {};
    if (name === "odds_forecast_record" && typeof args.address !== "string")
      return { jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "address: Required" } };
    return reply(call(name, args));
  }

  return { recorded, answer };
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
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
    });
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${http.address().port}/mcp`, close: () => http.close() };
}

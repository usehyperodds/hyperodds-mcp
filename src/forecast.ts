/**
 * The forecast record's EIP-712 messages, as the contract fixes them: one domain, a Forecast and a
 * ForecastBatch. The bridge builds them itself from the forecasts asked for, so it never signs typed
 * data that came from a server.
 */
import { randomBytes } from "node:crypto";
import { numberToBytesBE } from "@noble/curves/utils.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";

export interface Entry {
  outcome: number;
  probabilityBps: number;
}

export type Signable =
  | {
      type: "Forecast";
      message: { forecaster: string; outcome: number; probabilityBps: number; time: number; nonce: string };
    }
  | {
      type: "ForecastBatch";
      message: { forecaster: string; forecasts: Entry[]; time: number; nonce: string };
    };

type Field = { name: string; type: string };

export const DOMAIN = { name: "Hyperodds Forecasts", version: "1" };

const DOMAIN_TYPE: Field[] = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
];

const ENTRY: Field[] = [
  { name: "outcome", type: "uint32" },
  { name: "probabilityBps", type: "uint16" },
];

export const TYPES = {
  Forecast: {
    Forecast: [
      { name: "forecaster", type: "address" },
      { name: "outcome", type: "uint32" },
      { name: "probabilityBps", type: "uint16" },
      { name: "time", type: "uint64" },
      { name: "nonce", type: "uint64" },
    ],
  },
  ForecastBatch: {
    ForecastBatch: [
      { name: "forecaster", type: "address" },
      { name: "forecasts", type: "ForecastEntry[]" },
      { name: "time", type: "uint64" },
      { name: "nonce", type: "uint64" },
    ],
    ForecastEntry: ENTRY,
  },
} satisfies Record<Signable["type"], Record<string, Field[]>>;

export const MAX_BATCH = 50;

const encodeType = (name: string, fields: Field[]) =>
  `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
const hash = (...parts: Uint8Array[]) => keccak_256(concatBytes(...parts));
const word = (n: number | bigint | string) => numberToBytesBE(BigInt(n), 32);

export const DOMAIN_SEPARATOR = hash(
  keccak_256(utf8ToBytes(encodeType("EIP712Domain", DOMAIN_TYPE))),
  keccak_256(utf8ToBytes(DOMAIN.name)),
  keccak_256(utf8ToBytes(DOMAIN.version)),
);
export const TYPE_HASHES = {
  Forecast: keccak_256(utf8ToBytes(encodeType("Forecast", TYPES.Forecast.Forecast))),
  ForecastBatch: keccak_256(
    utf8ToBytes(
      encodeType("ForecastBatch", TYPES.ForecastBatch.ForecastBatch) + encodeType("ForecastEntry", ENTRY),
    ),
  ),
  ForecastEntry: keccak_256(utf8ToBytes(encodeType("ForecastEntry", ENTRY))),
};

function structHash(s: Signable): Uint8Array {
  const { forecaster, time, nonce } = s.message;
  if (s.type === "Forecast") {
    const { outcome, probabilityBps } = s.message;
    return hash(
      TYPE_HASHES.Forecast,
      word(forecaster),
      word(outcome),
      word(probabilityBps),
      word(time),
      word(nonce),
    );
  }
  const entries = s.message.forecasts.map((e) =>
    hash(TYPE_HASHES.ForecastEntry, word(e.outcome), word(e.probabilityBps)),
  );
  return hash(TYPE_HASHES.ForecastBatch, word(forecaster), hash(...entries), word(time), word(nonce));
}

/** The 32 bytes `eth_signTypedData_v4` signs for this message. */
export function digest(s: Signable): Uint8Array {
  return hash(Uint8Array.of(0x19, 0x01), DOMAIN_SEPARATOR, structHash(s));
}

const isEntry = (e: unknown): e is Entry => {
  const { outcome, probabilityBps } = (e ?? {}) as Partial<Entry>;
  return (
    Number.isInteger(outcome) &&
    outcome! >= 0 &&
    outcome! <= 0xffff_ffff &&
    Number.isInteger(probabilityBps) &&
    probabilityBps! >= 1 &&
    probabilityBps! <= 9999
  );
};

/**
 * The message for these forecasts, one as a Forecast and more as a ForecastBatch, timed by this
 * computer's clock with a random 63-bit nonce (JSON-safe as a string, and never reused in practice).
 */
export function forecastMessage(forecaster: string, entries: unknown, nowMs: number): Signable {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_BATCH || !entries.every(isEntry))
    throw new Error(
      "Each forecast takes an outcome id and a probabilityBps from 1 to 9999, and one call takes 1 to 50 of them.",
    );
  const time = Math.floor(nowMs / 1000);
  const nonce = (randomBytes(8).readBigUInt64BE() >> 1n).toString();
  const forecasts = entries.map(({ outcome, probabilityBps }) => ({ outcome, probabilityBps }));
  return forecasts.length === 1
    ? { type: "Forecast", message: { forecaster, ...forecasts[0]!, time, nonce } }
    : { type: "ForecastBatch", message: { forecaster, forecasts, time, nonce } };
}

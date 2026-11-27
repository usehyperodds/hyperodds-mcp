/**
 * The forecast record's EIP-712 messages, exactly as its spec fixes them (message version 2). The
 * bridge builds them itself from the forecasts asked for, so it never signs typed data that came
 * from a server; only each market's title and first side, read from the server as data, go in.
 */
import { randomBytes } from "node:crypto";
import { numberToBytesBE } from "@noble/curves/utils.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";

export interface Entry {
  outcome: number;
  probabilityBps: number;
}

/** What a forecast names: the market's title and side 0's label, as Hyperodds shows them. */
export interface Names {
  market: string;
  side: string;
}

export type Named = Entry & Names;

export type Signable =
  | {
      type: "Forecast";
      message: {
        forecaster: string;
        outcome: number;
        market: string;
        side: string;
        probabilityBps: number;
        time: number;
        nonce: string;
      };
    }
  | {
      type: "ForecastBatch";
      message: { forecaster: string; forecasts: Named[]; time: number; nonce: string };
    };

type Field = { name: string; type: string };

/** Salted for Hyperodds' mainnet record, so a signature made here holds on no other deployment. */
export const DOMAIN = {
  name: "Hyperodds Forecasts",
  version: "2",
  salt: keccak_256(utf8ToBytes("hyperodds:mainnet")),
};

const DOMAIN_TYPE: Field[] = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "salt", type: "bytes32" },
];

const ENTRY: Field[] = [
  { name: "outcome", type: "uint32" },
  { name: "market", type: "string" },
  { name: "side", type: "string" },
  { name: "probabilityBps", type: "uint16" },
];

export const TYPES = {
  Forecast: {
    Forecast: [
      { name: "forecaster", type: "address" },
      { name: "outcome", type: "uint32" },
      { name: "market", type: "string" },
      { name: "side", type: "string" },
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
const text = (s: string) => keccak_256(utf8ToBytes(s));

export const DOMAIN_SEPARATOR = hash(
  text(encodeType("EIP712Domain", DOMAIN_TYPE)),
  text(DOMAIN.name),
  text(DOMAIN.version),
  DOMAIN.salt,
);
export const TYPE_HASHES = {
  Forecast: text(encodeType("Forecast", TYPES.Forecast.Forecast)),
  ForecastBatch: text(
    encodeType("ForecastBatch", TYPES.ForecastBatch.ForecastBatch) + encodeType("ForecastEntry", ENTRY),
  ),
  ForecastEntry: text(encodeType("ForecastEntry", ENTRY)),
};

function structHash(s: Signable): Uint8Array {
  const { forecaster, time, nonce } = s.message;
  if (s.type === "Forecast") {
    const { outcome, market, side, probabilityBps } = s.message;
    return hash(
      TYPE_HASHES.Forecast,
      word(forecaster),
      word(outcome),
      text(market),
      text(side),
      word(probabilityBps),
      word(time),
      word(nonce),
    );
  }
  const entries = s.message.forecasts.map((e) =>
    hash(TYPE_HASHES.ForecastEntry, word(e.outcome), text(e.market), text(e.side), word(e.probabilityBps)),
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

/** Forecasts the bridge can't sign, with the code the server gives the same refusal. */
export class EntryError extends Error {
  constructor(
    readonly code: "batch_size" | "invalid_request",
    message: string,
  ) {
    super(message);
  }
}

const ENTRY_KEYS: ReadonlySet<string> = new Set(["outcome", "probabilityBps"]);

/**
 * The forecasts asked for, if they can be signed: 1 to 50, each an outcome id and a probabilityBps
 * and nothing else. A key the message has no place for is refused, as the server refuses it: an
 * agent that sent side: 1 would otherwise sign a probability for the other side than it meant.
 */
export function checkEntries(entries: unknown): Entry[] {
  if (!Array.isArray(entries) || !entries.every(isEntry))
    throw new EntryError(
      "invalid_request",
      "Each forecast takes an outcome id and a probabilityBps, a whole number from 1 to 9999.",
    );
  const extra = [...new Set(entries.flatMap((e) => Object.keys(e).filter((k) => !ENTRY_KEYS.has(k))))];
  if (extra.length > 0)
    throw new EntryError(
      "invalid_request",
      `Each forecast takes only an outcome id and a probabilityBps, not ${extra.join(", ")}.`,
    );
  if (entries.length < 1 || entries.length > MAX_BATCH)
    throw new EntryError("batch_size", "Send from 1 to 50 forecasts at a time.");
  return entries.map(({ outcome, probabilityBps }) => ({ outcome, probabilityBps }));
}

/** What odds_forecast takes. */
const FORECAST_ARGS: ReadonlySet<string> = new Set(["signed", "forecasts", "forecaster"]);

/**
 * Arguments odds_forecast doesn't take, refused as the server refuses them, before any key is read
 * or made: a misspelt forecaster would otherwise sign here what was meant for another wallet.
 */
export function checkArguments(args: Record<string, unknown>): void {
  const unknown = Object.keys(args).filter((k) => !FORECAST_ARGS.has(k));
  if (unknown.length > 0)
    throw new EntryError(
      "invalid_request",
      `odds_forecast takes signed, or forecasts with an optional forecaster, not ${unknown.join(", ")}.`,
    );
}

/**
 * The message for these forecasts: one as a Forecast, more as a ForecastBatch, signed at `time`
 * (Unix seconds). The nonce is 63 random bits, too many to repeat in practice, and goes as a string
 * because a JSON number can't hold it exactly.
 */
export function forecastMessage(forecaster: string, forecasts: Named[], time: number): Signable {
  const nonce = (randomBytes(8).readBigUInt64BE() >> 1n).toString();
  return forecasts.length === 1
    ? { type: "Forecast", message: { forecaster, ...forecasts[0]!, time, nonce } }
    : { type: "ForecastBatch", message: { forecaster, forecasts, time, nonce } };
}

/** The most of a title or side label the server takes in a signed forecast. */
const MAX_NAME = 400;

/**
 * A market's names from the server's odds_fair answer for `outcome`: its title and side 0's label,
 * as the server shows them and checks them. Null when the answer doesn't name that market.
 */
export function namesFrom(answer: unknown, outcome: number): Names | null {
  const a = (answer ?? {}) as { outcome?: unknown; title?: unknown; sides?: unknown };
  const side = Array.isArray(a.sides) ? a.sides[0] : undefined;
  const name = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= MAX_NAME;
  if (a.outcome !== outcome || !name(a.title) || !name(side)) return null;
  return { market: a.title, side };
}

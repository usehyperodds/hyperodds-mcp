/**
 * The forecast record's EIP-712 messages, as the contract fixes them: one domain, a Forecast and a
 * ForecastBatch. The bridge signs a draft's typed data only after `checkDraft` has matched it to
 * these types and to the forecasts the client asked for.
 */
import { isDeepStrictEqual } from "node:util";
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
/** How far a draft's `time` may sit from this computer's clock, either way. */
const TIME_SLACK_S = 600;
const UINT64_MAX = 2n ** 64n - 1n;

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
 * The draft's typed data as a message to sign, if it is exactly what was asked for: the contract's
 * domain and types, this forecaster, and the requested entries in their order, with a fresh time
 * and a uint64 nonce. Throws, naming the first difference, for anything else.
 */
export function checkDraft(
  typedData: unknown,
  want: { forecaster: string; entries: unknown; nowMs: number },
): Signable {
  const entries = want.entries;
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_BATCH || !entries.every(isEntry))
    throw new Error("the forecasts asked for are not 1 to 50 entries of an outcome and a probability");
  if (typeof typedData !== "object" || typedData === null) throw new Error("it carries no typed data");
  const td = typedData as Record<string, unknown>;
  if (!isDeepStrictEqual(Object.keys(td).sort(), ["domain", "message", "primaryType", "types"]))
    throw new Error("its typed data has other fields than domain, types, primaryType and message");
  if (!isDeepStrictEqual(td.domain, DOMAIN))
    throw new Error("its domain is not Hyperodds Forecasts version 1");
  const type = td.primaryType;
  if (type !== "ForecastBatch" && !(type === "Forecast" && entries.length === 1))
    throw new Error(
      `its primary type does not fit ${entries.length === 1 ? "one forecast" : `${entries.length} forecasts`}`,
    );
  const types = { ...(td.types as object) } as Record<string, unknown>;
  if (isDeepStrictEqual(types.EIP712Domain, DOMAIN_TYPE)) delete types.EIP712Domain;
  if (!isDeepStrictEqual(types, TYPES[type]))
    throw new Error(`its types are not the contract's ${type} types`);

  const m = (td.message ?? {}) as Record<string, unknown>;
  const { forecaster, time, nonce } = m;
  if (typeof forecaster !== "string" || forecaster.toLowerCase() !== want.forecaster.toLowerCase())
    throw new Error("it names another forecaster");
  if (
    typeof time !== "number" ||
    !Number.isSafeInteger(time) ||
    Math.abs(time - want.nowMs / 1000) > TIME_SLACK_S
  )
    throw new Error("its time is not within 10 minutes of this computer's clock");
  if (typeof nonce !== "string" || !/^(0|[1-9]\d{0,19})$/.test(nonce) || BigInt(nonce) > UINT64_MAX)
    throw new Error("its nonce is not a uint64 written as a decimal string");

  const forecasts = entries.map(({ outcome, probabilityBps }) => ({ outcome, probabilityBps }));
  const signable: Signable =
    type === "Forecast"
      ? { type, message: { forecaster, ...forecasts[0]!, time, nonce } }
      : { type, message: { forecaster, forecasts, time, nonce } };
  if (!isDeepStrictEqual(m, signable.message))
    throw new Error("its forecasts differ from the ones asked for");
  return signable;
}

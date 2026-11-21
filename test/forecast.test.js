import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { checkEntries, DOMAIN_SEPARATOR, digest, forecastMessage, TYPE_HASHES } from "../dist/forecast.js";
import { TEST_ADDRESS, vectors } from "./vectors.js";

describe("forecast messages", () => {
  test("hash the spec's test vectors exactly", () => {
    assert.equal(
      bytesToHex(DOMAIN_SEPARATOR),
      "8c35fadb67824908e8f620e61384ee244830a28d798764768569090f3d929e37",
    );
    assert.equal(
      bytesToHex(TYPE_HASHES.Forecast),
      "a8d516c0479c1166e3591b894d95ba27b4c73b848308820d52435e923bd368e6",
    );
    assert.equal(
      bytesToHex(TYPE_HASHES.ForecastBatch),
      "ff5ca7ea63ac690bc636955ac4763383f2c84c4803111d26b74195eba18aa6f9",
    );
    assert.equal(
      bytesToHex(TYPE_HASHES.ForecastEntry),
      "36e1078a25cea9e34eff3e4b746daee80ce54e7d5b97256dbf173dade80130bc",
    );
    for (const v of vectors) assert.equal(bytesToHex(digest(v)), v.digest, v.type);
  });
});

describe("the message built for this computer's key", () => {
  const forecaster = TEST_ADDRESS.toLowerCase();

  test("is the spec's message for the forecasts asked for, at the time given, with a fresh nonce", () => {
    const batch = forecastMessage(forecaster, checkEntries(vectors[1].message.forecasts), 1763719200);
    const { nonce, ...rest } = batch.message;
    assert.equal(batch.type, "ForecastBatch");
    assert.deepEqual(rest, { forecaster, forecasts: vectors[1].message.forecasts, time: 1763719200 });
    assert.match(nonce, /^\d+$/);
    assert.ok(BigInt(nonce) < 2n ** 63n);
    // With the vector's nonce, it hashes to the vector's digest.
    const fixed = {
      ...batch,
      message: { ...batch.message, forecaster: TEST_ADDRESS, nonce: vectors[1].message.nonce },
    };
    assert.equal(bytesToHex(digest(fixed)), vectors[1].digest);

    const one = forecastMessage(
      forecaster,
      checkEntries([{ outcome: 42400, probabilityBps: 6200, note: "dropped" }]),
      1763719200,
    );
    assert.equal(one.type, "Forecast");
    assert.deepEqual(Object.keys(one.message).sort(), [
      "forecaster",
      "nonce",
      "outcome",
      "probabilityBps",
      "time",
    ]);

    const nonces = new Set(
      Array.from(
        { length: 200 },
        () => forecastMessage(forecaster, checkEntries([vectors[0].message]), 1763719200).message.nonce,
      ),
    );
    assert.equal(nonces.size, 200);
  });

  test("is never built for forecasts it cannot sign", () => {
    const entry = { outcome: 42400, probabilityBps: 6200 };
    const bad = {
      none: [],
      "more than 50": Array.from({ length: 51 }, (_, i) => ({ ...entry, outcome: i })),
      "a probability of 0": [{ ...entry, probabilityBps: 0 }],
      "a probability of 10000": [{ ...entry, probabilityBps: 10_000 }],
      "a fractional probability": [{ ...entry, probabilityBps: 62.5 }],
      "an outcome as a string": [{ ...entry, outcome: "42400" }],
      "a negative outcome": [{ ...entry, outcome: -1 }],
      "an outcome past uint32": [{ ...entry, outcome: 2 ** 32 }],
      "not a list": entry,
    };
    for (const [name, entries] of Object.entries(bad)) {
      const code = name === "none" || name === "more than 50" ? "batch_size" : "invalid_request";
      assert.throws(() => checkEntries(entries), { name: "Error", code }, name);
    }
  });
});

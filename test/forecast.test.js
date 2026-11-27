import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  checkArguments,
  checkEntries,
  DOMAIN,
  DOMAIN_SEPARATOR,
  digest,
  forecastMessage,
  namesFrom,
  TYPE_HASHES,
} from "../dist/forecast.js";
import { BTC, TEST_ADDRESS, vectors } from "./vectors.js";

describe("forecast messages", () => {
  test("hash the spec's test vectors exactly", () => {
    assert.equal(bytesToHex(DOMAIN.salt), "c39792a05cff7539d2e0315b8f48f8ba52d0d5633867ed004c25a66c4160eeb4");
    assert.equal(
      bytesToHex(DOMAIN_SEPARATOR),
      "12e0f52833f9791dcb35db09d561aacc84ec21766e497c7618c159a931379d43",
    );
    assert.equal(
      bytesToHex(TYPE_HASHES.Forecast),
      "f17e0807d1ad95830c7ed23f72a0c650744e9d7f4f2b66c28de313920555c836",
    );
    assert.equal(
      bytesToHex(TYPE_HASHES.ForecastBatch),
      "5445b9122c3debdb9e5817cea50eac968ca3861f9ad1195f83830640f7579970",
    );
    assert.equal(
      bytesToHex(TYPE_HASHES.ForecastEntry),
      "b7b2fc97c148a7c38b4d821a7c4fabf1c9d2e7ff7d356597adab119bef4af363",
    );
    for (const v of vectors) assert.equal(bytesToHex(digest(v)), v.digest, v.type);
  });

  test("another market's title or side is another message", () => {
    const [v] = vectors;
    for (const change of [{ market: `${BTC.market} ` }, { side: "No" }])
      assert.notEqual(bytesToHex(digest({ ...v, message: { ...v.message, ...change } })), v.digest);
  });
});

describe("a market's names", () => {
  const answer = { outcome: 42400, title: BTC.market, sides: ["Yes", "No"], fair: null };

  test("are the title and the first side the server gives for that outcome", () => {
    assert.deepEqual(namesFrom(answer, 42400), { market: BTC.market, side: "Yes" });
  });

  test("are none when the answer is for another outcome, or its names aren't text", () => {
    const bad = {
      "another outcome": [answer, 42401],
      "no title": [{ ...answer, title: undefined }, 42400],
      "an empty title": [{ ...answer, title: "" }, 42400],
      "a title past 400 characters": [{ ...answer, title: "x".repeat(401) }, 42400],
      "no sides": [{ ...answer, sides: [] }, 42400],
      "a side that isn't text": [{ ...answer, sides: [1, "No"] }, 42400],
      "no answer": [undefined, 42400],
    };
    for (const [name, [a, outcome]] of Object.entries(bad)) assert.equal(namesFrom(a, outcome), null, name);
  });
});

describe("the message built for this computer's key", () => {
  const forecaster = TEST_ADDRESS.toLowerCase();

  test("is the spec's message for the forecasts asked for, at the time given, with a fresh nonce", () => {
    const batch = forecastMessage(forecaster, vectors[1].message.forecasts, 1763719200);
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

    const one = forecastMessage(forecaster, [{ ...BTC, probabilityBps: 6200 }], 1763719200);
    assert.equal(one.type, "Forecast");
    assert.deepEqual(Object.keys(one.message).sort(), [
      "forecaster",
      "market",
      "nonce",
      "outcome",
      "probabilityBps",
      "side",
      "time",
    ]);

    const nonces = new Set(
      Array.from(
        { length: 200 },
        () => forecastMessage(forecaster, [{ ...BTC, probabilityBps: 6200 }], 1763719200).message.nonce,
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
      "a key a forecast doesn't take": [entry, { ...entry, outcome: 42401, side: 1 }],
    };
    for (const [name, entries] of Object.entries(bad)) {
      const code = name === "none" || name === "more than 50" ? "batch_size" : "invalid_request";
      assert.throws(() => checkEntries(entries), { name: "Error", code }, name);
    }
    assert.throws(() => checkEntries([{ ...entry, side: 1, note: "x" }]), {
      code: "invalid_request",
      message: "Each forecast takes only an outcome id and a probabilityBps, not side, note.",
    });
  });

  test("odds_forecast's arguments are signed, forecasts and forecaster, and no other", () => {
    assert.doesNotThrow(() => checkArguments({ forecasts: [], forecaster: "0x" }));
    assert.throws(() => checkArguments({ forecasts: [], forecastr: "0x" }), {
      code: "invalid_request",
      message: "odds_forecast takes signed, or forecasts with an optional forecaster, not forecastr.",
    });
  });
});

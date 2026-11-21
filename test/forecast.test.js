import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { checkDraft, DOMAIN, DOMAIN_SEPARATOR, digest, TYPE_HASHES, TYPES } from "../dist/forecast.js";
import { TEST_ADDRESS, vectors } from "./vectors.js";

describe("forecast messages", () => {
  test("hash the contract's test vectors exactly", () => {
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

describe("a draft's typed data", () => {
  const forecaster = TEST_ADDRESS.toLowerCase();
  const entries = vectors[1].message.forecasts;
  const nowMs = 1763719200_000;
  const draft = (change = () => {}) => {
    const td = {
      domain: { ...DOMAIN },
      types: structuredClone(TYPES.ForecastBatch),
      primaryType: "ForecastBatch",
      message: { ...structuredClone(vectors[1].message), forecaster },
    };
    change(td);
    return td;
  };
  const check = (td, want = {}) => checkDraft(td, { forecaster, entries, nowMs, ...want });

  test("is signed as is when it is the contract's message for the forecasts asked for", () => {
    assert.deepEqual(check(draft()), { type: "ForecastBatch", message: draft().message });
    // A checksummed forecaster, the domain type spelled out, and one entry as a Forecast.
    const spelled = draft((td) => {
      td.message.forecaster = TEST_ADDRESS;
      td.types = {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
        ],
        ...td.types,
      };
    });
    assert.equal(check(spelled).message.forecaster, TEST_ADDRESS);
    const single = {
      domain: DOMAIN,
      types: TYPES.Forecast,
      primaryType: "Forecast",
      message: vectors[0].message,
    };
    assert.equal(check(single, { entries: [entries[0]] }).type, "Forecast");
    assert.equal(
      check(draft(), { entries: entries.map((e) => ({ ...e, note: "ignored" })) }).type,
      "ForecastBatch",
    );
  });

  const refusals = {
    "another domain name": [(td) => (td.domain.name = "Hyperodds"), /domain/],
    "another domain version": [(td) => (td.domain.version = "2"), /domain/],
    "a chain id in the domain": [(td) => (td.domain.chainId = 1), /domain/],
    "a verifying contract": [(td) => (td.domain.verifyingContract = TEST_ADDRESS), /domain/],
    "an extra type": [(td) => (td.types.Transfer = [{ name: "to", type: "address" }]), /types/],
    "an extra field": [(td) => td.types.ForecastBatch.push({ name: "amount", type: "uint256" }), /types/],
    "a field of another type": [(td) => (td.types.ForecastEntry[1].type = "uint32"), /types/],
    "fields in another order": [(td) => td.types.ForecastBatch.reverse(), /types/],
    "a domain type with a chain id": [
      (td) =>
        (td.types.EIP712Domain = [
          { name: "name", type: "string" },
          { name: "chainId", type: "uint256" },
        ]),
      /types/,
    ],
    "another primary type": [(td) => (td.primaryType = "ForecastEntry"), /primary type/],
    "a single forecast for two entries": [
      (td) => {
        td.primaryType = "Forecast";
        td.types = TYPES.Forecast;
      },
      /primary type/,
    ],
    "another forecaster": [
      (td) => (td.message.forecaster = "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf"),
      /forecaster/,
    ],
    "another probability": [(td) => (td.message.forecasts[1].probabilityBps = 3101), /differ/],
    "another outcome": [(td) => (td.message.forecasts[0].outcome = 42401), /differ/],
    "the entries in another order": [(td) => td.message.forecasts.reverse(), /differ/],
    "an entry left out": [(td) => td.message.forecasts.pop(), /differ/],
    "an entry added": [(td) => td.message.forecasts.push({ outcome: 7, probabilityBps: 5000 }), /differ/],
    "an extra field in an entry": [(td) => (td.message.forecasts[0].weight = 2), /differ/],
    "an extra field in the message": [(td) => (td.message.expires = 0), /differ/],
    "a time an hour off": [(td) => (td.message.time += 3600), /time/],
    "a time that is not an integer": [(td) => (td.message.time = "1763719200"), /time/],
    "a nonce past uint64": [(td) => (td.message.nonce = (2n ** 64n).toString()), /nonce/],
    "a nonce as a number": [(td) => (td.message.nonce = 5), /nonce/],
    "an extra top-level field": [(td) => (td.extra = {}), /other fields/],
  };
  for (const [name, [change, why]] of Object.entries(refusals)) {
    test(`is refused with ${name}`, () => assert.throws(() => check(draft(change)), why));
  }

  test("is refused when there is none, or the request was not forecasts", () => {
    assert.throws(() => check(null), /no typed data/);
    assert.throws(() => check(draft(), { entries: [] }), /1 to 50/);
    assert.throws(() => check(draft(), { entries: [{ outcome: 1, probabilityBps: 10_000 }] }), /1 to 50/);
    assert.throws(() => check(draft(), { entries: [{ outcome: "1", probabilityBps: 5000 }] }), /1 to 50/);
  });
});

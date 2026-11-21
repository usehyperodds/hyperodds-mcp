import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { digest } from "../dist/forecast.js";
import { keyPath, openKey } from "../dist/key.js";
import { TEST_KEY, vectors } from "./vectors.js";

const TEST_ADDRESS = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const work = mkdtempSync(join(tmpdir(), "hyperodds-mcp-key-test-"));
after(() => rmSync(work, { recursive: true, force: true }));
let dirs = 0;
const freshPath = () => join(work, String(++dirs), "hyperodds", "forecaster.key");

describe("forecaster key", () => {
  const quiet = { log: () => {} };

  test("signs the contract's test vectors exactly", () => {
    const signer = openKey({ env: TEST_KEY, path: freshPath(), log: assert.fail }, true);
    assert.equal(signer.address, TEST_ADDRESS);
    for (const v of vectors) assert.equal(signer.sign(digest(v)), v.signature, v.type);
  });

  test("is made on first use in a file only its owner can read, then read back", () => {
    const path = freshPath();
    assert.equal(openKey({ path, ...quiet }, false), null);
    const logs = [];
    const made = openKey({ path, log: (l) => logs.push(l) }, true);
    assert.match(made.address, /^0x[0-9a-f]{40}$/);
    const text = readFileSync(path, "utf8");
    assert.match(text, /^0x[0-9a-f]{64}\n$/);
    if (process.platform !== "win32") {
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(statSync(join(path, "..")).mode & 0o777, 0o700);
    }
    assert.equal(openKey({ path, ...quiet }, true).address, made.address);
    assert.equal(logs.length, 1);
    assert.match(logs[0], new RegExp(`^Made forecaster ${made.address} and saved its key to `));
    assert.ok(!logs[0].includes(text.trim().slice(2)));
  });

  test("comes from HYPERODDS_FORECAST_KEY when it is set, and then no file is made", () => {
    const path = freshPath();
    for (const env of [TEST_KEY, TEST_KEY.slice(2), ` ${TEST_KEY.toUpperCase().replace("0X", "0x")}\n`])
      assert.equal(openKey({ env, path, log: assert.fail }, true).address, TEST_ADDRESS);
    assert.throws(() => statSync(path), { code: "ENOENT" });
  });

  test("that is not a key is refused without repeating what was found", () => {
    const secret = "correct horse battery staple";
    for (const env of [secret, "0x00", `0x${"0".repeat(64)}`, `0x${"f".repeat(64)}`]) {
      assert.throws(
        () => openKey({ env, path: freshPath(), ...quiet }, true),
        (e) => /^HYPERODDS_FORECAST_KEY is not a private key/.test(e.message) && !e.message.includes(env),
      );
    }
    const path = freshPath();
    openKey({ path, ...quiet }, true);
    writeFileSync(path, secret);
    assert.throws(
      () => openKey({ path, ...quiet }, true),
      (e) => e.message.includes("does not hold a forecaster key") && !e.message.includes(secret),
    );
    assert.equal(readFileSync(path, "utf8"), secret);
  });

  test("warns when other users of the computer can read its file", {
    skip: process.platform === "win32",
  }, () => {
    const path = freshPath();
    openKey({ path, ...quiet }, true);
    const text = readFileSync(path, "utf8");
    rmSync(path);
    writeFileSync(path, text, { mode: 0o644 });
    const logs = [];
    openKey({ path, log: (l) => logs.push(l) }, false);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /can be read by other users/);
  });

  test("lives in the user's config directory", () => {
    const home = homedir();
    assert.equal(
      keyPath({ XDG_CONFIG_HOME: "/x/config" }, "linux"),
      join("/x/config", "hyperodds", "forecaster.key"),
    );
    assert.equal(keyPath({ XDG_CONFIG_HOME: "relative" }, "darwin").startsWith(join(home, ".config")), true);
    assert.equal(keyPath({}, "darwin"), join(home, ".config", "hyperodds", "forecaster.key"));
    assert.equal(
      keyPath({ APPDATA: "/x/AppData/Roaming" }, "win32"),
      join("/x/AppData/Roaming", "hyperodds", "forecaster.key"),
    );
  });
});

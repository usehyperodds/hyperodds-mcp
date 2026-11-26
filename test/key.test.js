import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { digest } from "../dist/forecast.js";
import { keyPath, openKey, takeKey } from "../dist/key.js";
import { TEST_KEY, vectors } from "./vectors.js";

const TEST_ADDRESS = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const work = mkdtempSync(join(tmpdir(), "hyperodds-mcp-key-test-"));
after(() => rmSync(work, { recursive: true, force: true }));
let dirs = 0;
const freshPath = () => join(work, String(++dirs), "hyperodds", "forecaster.key");

describe("forecaster key", () => {
  const quiet = { log: () => {} };

  test("signs the spec's test vectors exactly", () => {
    const signer = openKey({ env: TEST_KEY, path: freshPath(), log: assert.fail }, true);
    assert.equal(signer.address, TEST_ADDRESS);
    for (const v of vectors) assert.equal(signer.sign(digest(v)), v.signature, v.type);
  });

  test("signs with a low s and v of 27 or 28, as the server requires", () => {
    // n / 2 for secp256k1: the server refuses an s above it, so no forecast has two valid signatures.
    const half = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
    const signer = openKey({ path: freshPath(), ...quiet }, true);
    for (let i = 0; i < 300; i++) {
      const signature = signer.sign(randomBytes(32));
      assert.match(signature, /^0x[0-9a-f]{128}(1b|1c)$/);
      assert.ok(BigInt(`0x${signature.slice(66, 130)}`) <= half);
    }
    for (const v of vectors) assert.ok(BigInt(`0x${v.signature.slice(66, 130)}`) <= half);
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

  test("is made once when 16 bridges make their first forecast at the same moment", async () => {
    const path = freshPath();
    const module = new URL("../dist/key.js", import.meta.url).href;
    // Each process waits for the same instant, then opens the key, so the 16 race for the file.
    const code = `import { openKey } from ${JSON.stringify(module)};
const [path, at] = process.argv.slice(1);
while (Date.now() < Number(at));
console.log(openKey({ path, log: () => {} }, true).address);`;
    const at = String(Date.now() + 1500);
    const addresses = await Promise.all(
      Array.from(
        { length: 16 },
        () =>
          new Promise((done, fail) =>
            execFile(process.execPath, ["--input-type=module", "-e", code, path, at], (error, out) =>
              error ? fail(error) : done(out.trim()),
            ),
          ),
      ),
    );
    assert.equal(new Set(addresses).size, 1);
    assert.match(addresses[0], /^0x[0-9a-f]{40}$/);
    assert.equal(openKey({ path, ...quiet }, false).address, addresses[0]);
    assert.deepEqual(readdirSync(dirname(path)), ["forecaster.key"]);
  });

  const posixUser = process.platform !== "win32" && process.getuid?.() !== 0;

  test("that another user owns is refused", { skip: !posixUser }, () => {
    // A file root owns stands in for another user's key.
    assert.throws(
      () => openKey({ path: "/etc/hosts", log: assert.fail }, true),
      (e) => /belongs to another user of this computer/.test(e.message) && !/localhost/.test(e.message),
    );
  });

  test("in a folder other users can write to is refused, and none is made there", {
    skip: !posixUser,
  }, () => {
    const path = freshPath();
    openKey({ path, ...quiet }, true);
    const dir = dirname(path);
    chmodSync(dir, 0o777);
    try {
      const swappable =
        /^Other users of this computer can write to .+, the folder that holds the forecaster key, so the bridge won't use it\. Run: chmod go-w /;
      assert.throws(() => openKey({ path, log: assert.fail }, false), { message: swappable });
      rmSync(path);
      assert.throws(() => openKey({ path, log: assert.fail }, true), { message: swappable });
      assert.deepEqual(readdirSync(dir), []);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test("in a folder another user owns is refused, and none is made there", { skip: !posixUser }, () => {
    // A folder root owns stands in for another user's.
    const path = "/usr/forecaster.key";
    assert.throws(() => openKey({ path, log: assert.fail }, true), {
      message:
        /^\/usr, the folder that holds the forecaster key, belongs to another user of this computer, so the bridge won't use it\. Set XDG_CONFIG_HOME/,
    });
    assert.equal(existsSync(path), false);
  });

  test("that is a link is refused, a dangling one too, and no key is made in its place", {
    skip: process.platform === "win32",
  }, () => {
    const link = /^.+forecaster\.key is a link, not the forecaster key itself, so the bridge won't use it\./;
    const path = freshPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const elsewhere = join(work, `wallet-${dirs}.txt`);
    writeFileSync(elsewhere, `${TEST_KEY}\n`, { mode: 0o600 });
    symlinkSync(elsewhere, path);
    for (const create of [false, true])
      assert.throws(
        () => openKey({ path, log: assert.fail }, create),
        (e) => {
          assert.match(e.message, link);
          assert.ok(!e.message.includes(TEST_KEY.slice(2)));
          return true;
        },
      );
    rmSync(path);
    const nowhere = join(work, `nowhere-${dirs}`);
    symlinkSync(nowhere, path);
    for (const create of [false, true])
      assert.throws(() => openKey({ path, log: assert.fail }, create), { message: link });
    assert.equal(existsSync(nowhere), false);
    assert.deepEqual(readdirSync(dirname(path)), ["forecaster.key"]);
  });

  test("from HYPERODDS_FORECAST_KEY is read once and leaves the environment", () => {
    const env = { HYPERODDS_FORECAST_KEY: TEST_KEY, PATH: "/bin" };
    assert.equal(takeKey(env), TEST_KEY);
    assert.deepEqual(env, { PATH: "/bin" });
    assert.equal(takeKey(env), undefined);
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

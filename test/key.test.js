import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
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

  test("that other users of the computer can read or change is refused, before it is read", {
    skip: process.platform === "win32",
  }, () => {
    const path = freshPath();
    const made = openKey({ path, ...quiet }, true);
    const text = readFileSync(path, "utf8");
    const open =
      /^Other users of this computer can read or change .+forecaster\.key, the forecaster key, so the bridge won't sign with it\. Run: chmod 600 ".+forecaster\.key"$/;
    for (const mode of [0o644, 0o660, 0o604, 0o620]) {
      chmodSync(path, mode);
      for (const create of [false, true])
        assert.throws(
          () => openKey({ path, log: assert.fail }, create),
          (e) => open.test(e.message) && !e.message.includes(text.trim().slice(2)),
        );
    }
    assert.equal(readFileSync(path, "utf8"), text);
    // Refused on its permissions alone, whatever the file holds.
    writeFileSync(path, "not a key");
    assert.throws(() => openKey({ path, log: assert.fail }, false), { message: open });
    writeFileSync(path, text);
    chmodSync(path, 0o600);
    assert.equal(openKey({ path, log: assert.fail }, false).address, made.address);
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

  test("in a folder that is a link is refused, and nothing is made through it", {
    skip: process.platform === "win32",
  }, () => {
    const link =
      /^.+hyperodds, the folder that holds the forecaster key, is a link, so the bridge won't use it\. Move the folder it points to into its place/;
    const path = freshPath();
    const dir = dirname(path);
    mkdirSync(dirname(dir), { mode: 0o700 });
    const elsewhere = join(work, `folder-${dirs}`);
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, dir);
    for (const create of [false, true])
      assert.throws(() => openKey({ path, log: assert.fail }, create), { message: link });
    assert.deepEqual(readdirSync(elsewhere), []);

    writeFileSync(join(elsewhere, "forecaster.key"), `${TEST_KEY}\n`, { mode: 0o600 });
    for (const create of [false, true])
      assert.throws(
        () => openKey({ path, log: assert.fail }, create),
        (e) => link.test(e.message) && !e.message.includes(TEST_KEY.slice(2)),
      );
    assert.deepEqual(readdirSync(elsewhere), ["forecaster.key"]);

    rmSync(dir);
    const nowhere = join(work, `nowhere-${dirs}`);
    symlinkSync(nowhere, dir);
    for (const create of [false, true])
      assert.throws(() => openKey({ path, log: assert.fail }, create), { message: link });
    assert.equal(existsSync(nowhere), false);
  });

  test("under a config folder that is a link is refused, and nothing is made through it", {
    skip: process.platform === "win32",
  }, () => {
    // freshPath's numbered folder stands in for ~/.config or $XDG_CONFIG_HOME.
    const link =
      /^.+, which holds the forecaster key's folder, is a link, so the bridge won't use it\. Set XDG_CONFIG_HOME to a folder of your own that is not a link\.$/;
    const path = freshPath();
    const base = dirname(dirname(path));
    const elsewhere = join(work, `config-${dirs}`);
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, base);
    for (const create of [false, true])
      assert.throws(() => openKey({ path, log: assert.fail }, create), { message: link });
    assert.deepEqual(readdirSync(elsewhere), []);

    mkdirSync(join(elsewhere, "hyperodds"), { mode: 0o700 });
    writeFileSync(join(elsewhere, "hyperodds", "forecaster.key"), `${TEST_KEY}\n`, { mode: 0o600 });
    for (const create of [false, true])
      assert.throws(
        () => openKey({ path, log: assert.fail }, create),
        (e) => link.test(e.message) && !e.message.includes(TEST_KEY.slice(2)),
      );

    rmSync(base);
    const nowhere = join(work, `nowhere-${dirs}`);
    symlinkSync(nowhere, base);
    for (const create of [false, true])
      assert.throws(() => openKey({ path, log: assert.fail }, create), { message: link });
    assert.equal(existsSync(nowhere), false);
  });

  test("that is a hard link is refused, and taken once it has a file of its own", {
    skip: process.platform === "win32",
  }, () => {
    const hard =
      /^.+forecaster\.key is a hard link: the forecaster key in it also lives under another name on this computer, so the bridge won't sign with it\. Replace it with a copy of its own/;
    const path = freshPath();
    const made = openKey({ path, ...quiet }, true);
    const text = readFileSync(path, "utf8");
    const other = join(work, `other-name-${dirs}.key`);
    linkSync(path, other);
    for (const create of [false, true])
      assert.throws(
        () => openKey({ path, log: assert.fail }, create),
        (e) => hard.test(e.message) && !e.message.includes(text.trim().slice(2)),
      );
    assert.equal(readFileSync(path, "utf8"), text);
    rmSync(other);
    assert.equal(openKey({ path, log: assert.fail }, false).address, made.address);
  });

  test("being saved by another bridge is read once it is in place, and a temp name left behind is refused", {
    skip: process.platform === "win32",
  }, async () => {
    const path = freshPath();
    const made = openKey({ path, ...quiet }, true);
    // The name a key is saved under before it is linked into place, as another bridge leaves it
    // for a moment.
    const temp = join(dirname(path), ".forecaster.key.saving");
    linkSync(path, temp);
    const module = new URL("../dist/key.js", import.meta.url).href;
    const code = `import { openKey } from ${JSON.stringify(module)};
console.log(openKey({ path: process.argv[1], log: () => {} }, false).address);`;
    const reading = new Promise((done, fail) =>
      execFile(process.execPath, ["--input-type=module", "-e", code, path], (error, out) =>
        error ? fail(error) : done(out.trim()),
      ),
    );
    setTimeout(() => rmSync(temp), 300);
    assert.equal(await reading, made.address);

    linkSync(path, temp);
    const started = Date.now();
    assert.throws(() => openKey({ path, log: assert.fail }, false), { message: / is a hard link: / });
    assert.ok(Date.now() - started >= 900);
  });

  test("under ~/.config is made in a real folder, and refused through a link", {
    skip: process.platform === "win32",
  }, async () => {
    const module = new URL("../dist/key.js", import.meta.url).href;
    // keyPath() in a child with HOME set to a test folder and no XDG_CONFIG_HOME, so the key is
    // looked for in its ~/.config; it refuses to start anywhere else.
    const code = `import { keyPath, openKey } from ${JSON.stringify(module)};
const path = keyPath();
if (!path.startsWith(process.env.HOME + "/")) throw new Error("not under the test HOME");
try {
  console.log(openKey({ path, log: () => {} }, true).address);
} catch (error) {
  console.log(error.message);
}`;
    const inHome = (home) => {
      const env = { ...process.env, HOME: home };
      delete env.XDG_CONFIG_HOME;
      return new Promise((done, fail) =>
        execFile(process.execPath, ["--input-type=module", "-e", code], { env }, (error, out) =>
          error ? fail(error) : done(out.trim()),
        ),
      );
    };

    const home = join(work, `home-${++dirs}`);
    mkdirSync(home, { mode: 0o700 });
    const made = await inHome(home);
    assert.match(made, /^0x[0-9a-f]{40}$/);
    const path = join(home, ".config", "hyperodds", "forecaster.key");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
    assert.equal(await inHome(home), made);

    const linked = join(work, `home-${++dirs}`);
    mkdirSync(linked, { mode: 0o700 });
    const elsewhere = join(work, `config-${dirs}`);
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, join(linked, ".config"));
    assert.equal(
      await inHome(linked),
      `${join(linked, ".config")}, which holds the forecaster key's folder, is a link, so the bridge won't use it. Set XDG_CONFIG_HOME to a folder of your own that is not a link.`,
    );
    assert.deepEqual(readdirSync(elsewhere), []);
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

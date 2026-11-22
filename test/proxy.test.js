import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { proxyNote } from "../dist/proxy.js";

const server = new URL("https://api.usehyperodds.com/mcp");
const on = { NODE_USE_ENV_PROXY: "1" };
const note = (env, { target = server, version = "24.22.0", flags = [] } = {}) =>
  proxyNote(target, env, version, flags);

describe("proxy notes", () => {
  test("say nothing without a proxy", () => {
    assert.equal(note({}), undefined);
    assert.equal(note({ ...on, HTTPS_PROXY: "" }), undefined);
  });

  test("name the proxy in use, without its login", () => {
    assert.deepEqual(note({ ...on, HTTPS_PROXY: "http://user:s3cret@proxy.corp:8080/" }), {
      text: "Requests go through the proxy http://proxy.corp:8080 from HTTPS_PROXY.",
      ignored: false,
    });
    assert.match(
      note({ HTTPS_PROXY: "http://proxy.corp:8080" }, { flags: ["--use-env-proxy"] }).text,
      /^Requests/,
    );
  });

  test("follow Node.js: lowercase wins, and the server's scheme picks the variable", () => {
    const env = {
      ...on,
      https_proxy: "http://lower:1",
      HTTPS_PROXY: "http://upper:2",
      HTTP_PROXY: "http://plain:3",
    };
    assert.match(note(env).text, /http:\/\/lower:1 from https_proxy/);
    assert.match(
      note(env, { target: new URL("http://localhost:8787/mcp") }).text,
      /http:\/\/plain:3 from HTTP_PROXY/,
    );
    assert.equal(note({ ...env, https_proxy: "" }), undefined);
  });

  test("explain a proxy that Node.js does not use", () => {
    assert.deepEqual(note({ HTTPS_PROXY: "http://proxy.corp:8080" }), {
      text: "HTTPS_PROXY is set, but Node.js ignores it unless NODE_USE_ENV_PROXY=1 is set as well.",
      ignored: true,
    });
    for (const version of ["22.20.0", "23.11.0", "24.4.1"]) {
      const old = note({ ...on, HTTPS_PROXY: "http://proxy.corp:8080" }, { version });
      assert.equal(old.ignored, true, version);
      assert.match(old.text, new RegExp(`Node.js ${version} cannot use it`), version);
    }
    for (const version of ["22.21.0", "24.5.0", "25.1.0"])
      assert.equal(
        note({ ...on, HTTPS_PROXY: "http://proxy.corp:8080" }, { version }).ignored,
        false,
        version,
      );
  });

  test("say nothing when NO_PROXY exempts the server", () => {
    const env = { ...on, HTTPS_PROXY: "http://proxy.corp:8080" };
    const exempt = [
      "*",
      "api.usehyperodds.com",
      "API.usehyperodds.com:443",
      ".usehyperodds.com",
      "*.usehyperodds.com",
      "*usehyperodds.com",
    ];
    for (const NO_PROXY of exempt)
      assert.equal(note({ ...env, NO_PROXY: `localhost, ${NO_PROXY} 127.0.0.1` }), undefined, NO_PROXY);
    assert.equal(note({ ...env, NO_PROXY: "usehyperodds.com,api.usehyperodds.com:8443" }).ignored, false);
    assert.equal(note({ ...env, NO_PROXY: "*", no_proxy: "localhost" }).ignored, false);
  });
});

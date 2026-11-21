// Packs the Claude Desktop extension: the built bridge with its manifest and icon, as one .mcpb file.
// Usage: node scripts/mcpb.mjs [output], after npm run build. Default output: build/hyperodds.mcpb.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { packExtension } from "@anthropic-ai/mcpb";

const root = resolve(import.meta.dirname, "..");
const out = resolve(process.argv[2] ?? join(root, "build", "hyperodds.mcpb"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "mcpb", "manifest.json"), "utf8"));

// Bundle path to source path. Listed by hand because tsc never empties dist: a file left there by a
// deleted source would otherwise ship.
const files = {
  "manifest.json": "mcpb/manifest.json",
  "icon.png": "mcpb/icon.png",
  LICENSE: "LICENSE",
  "dist/cli.js": "dist/cli.js",
  "dist/bridge.js": "dist/bridge.js",
};

if (manifest.version !== pkg.version) {
  console.error(
    `mcpb/manifest.json says ${manifest.version} and package.json ${pkg.version}; make them match.`,
  );
  process.exit(1);
}

const stage = mkdtempSync(join(tmpdir(), "hyperodds-mcpb-"));
let packed = false;
try {
  mkdirSync(join(stage, "dist"));
  for (const [to, from] of Object.entries(files)) copyFileSync(join(root, from), join(stage, to));
  // dist/cli.js reads its version from ../package.json, and "type" makes dist/*.js ES modules.
  const { name, version, description, license, author, homepage } = pkg;
  const bundlePkg = { name, version, description, license, author, homepage, type: "module" };
  writeFileSync(join(stage, "package.json"), `${JSON.stringify(bundlePkg, null, 2)}\n`);
  packed = await packExtension({ extensionPath: stage, outputPath: out, silent: true });
} finally {
  rmSync(stage, { recursive: true, force: true });
}
if (!packed) {
  console.error(`Could not pack ${relative(process.cwd(), out)}.`);
  process.exit(1);
}

const bytes = readFileSync(out);
const sha256 = createHash("sha256").update(bytes).digest("hex");
console.log(`${relative(process.cwd(), out)}  ${bytes.length} bytes  sha256 ${sha256}`);

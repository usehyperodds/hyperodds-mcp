// Packs the Claude Desktop extension: the built bridge with its manifest and icon, as one .mcpb file.
// Usage: node scripts/mcpb.mjs [output], after npm run build. Default output: build/hyperodds.mcpb.
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { packExtension } from "@anthropic-ai/mcpb";

const root = resolve(import.meta.dirname, "..");
const out = resolve(process.argv[2] ?? join(root, "build", "hyperodds.mcpb"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "mcpb", "manifest.json"), "utf8"));

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
  for (const file of ["manifest.json", "icon.png"]) copyFileSync(join(root, "mcpb", file), join(stage, file));
  for (const file of readdirSync(join(root, "dist")).filter((f) => f.endsWith(".js")))
    copyFileSync(join(root, "dist", file), join(stage, "dist", file));
  copyFileSync(join(root, "LICENSE"), join(stage, "LICENSE"));
  // dist/cli.js reads its version from ../package.json, and "type" makes dist/*.js ES modules.
  const { name, version, description, license, author, homepage } = pkg;
  const bundlePkg = { name, version, description, license, author, homepage, type: "module" };
  writeFileSync(join(stage, "package.json"), `${JSON.stringify(bundlePkg, null, 2)}\n`);
  packed = await packExtension({ extensionPath: stage, outputPath: out });
} finally {
  rmSync(stage, { recursive: true, force: true });
}
if (!packed) process.exit(1);

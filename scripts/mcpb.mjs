// Packs the Claude Desktop extension: the built bridge and the files it loads from its dependencies,
// with its manifest and icons, as one .mcpb file.
// Usage: node scripts/mcpb.mjs [output], after npm run build. Default output: build/hyperodds.mcpb.
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { packExtension } from "@anthropic-ai/mcpb";

const root = resolve(import.meta.dirname, "..");
const out = resolve(process.argv[2] ?? join(root, "build", "hyperodds.mcpb"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "mcpb", "manifest.json"), "utf8"));

// Bundle path to source path.
const files = {
  "manifest.json": "mcpb/manifest.json",
  "icon.png": "mcpb/icon.png",
  "icon-dark.png": "mcpb/icon-dark.png",
  LICENSE: "LICENSE",
};

// The bridge's code and its dependencies' files are the ones it loads, found by following static
// imports from dist/cli.js. tsc never empties dist, so a file left there by a deleted source stays
// out, and so does whatever a dependency ships that the bridge never loads.
const seen = new Set();
const visit = (file) => {
  if (seen.has(file)) return;
  seen.add(file);
  const code = readFileSync(file, "utf8");
  for (const [, spec] of code.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm)) {
    if (spec.startsWith("node:")) continue;
    visit(spec.startsWith(".") ? resolve(dirname(file), spec) : createRequire(file).resolve(spec));
  }
};
visit(join(root, "dist", "cli.js"));
for (const file of seen) {
  const path = relative(root, file).split(sep).join("/");
  files[path] = path;
  // A dependency also needs its package.json, for its exports, and its license.
  const pkgRoot = path.match(/^(node_modules\/(?:@[^/]+\/)?[^/]+)\//)?.[1];
  if (!pkgRoot) continue;
  for (const name of ["package.json", "LICENSE"])
    if (existsSync(join(root, pkgRoot, name))) files[`${pkgRoot}/${name}`] = `${pkgRoot}/${name}`;
}

if (manifest.version !== pkg.version) {
  console.error(
    `mcpb/manifest.json says ${manifest.version} and package.json ${pkg.version}; make them match.`,
  );
  process.exit(1);
}

const stage = mkdtempSync(join(tmpdir(), "hyperodds-mcpb-"));
let packed = false;
try {
  for (const [to, from] of Object.entries(files)) {
    mkdirSync(dirname(join(stage, to)), { recursive: true });
    copyFileSync(join(root, from), join(stage, to));
  }
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

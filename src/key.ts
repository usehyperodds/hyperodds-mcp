/**
 * This computer's forecaster key: HYPERODDS_FORECAST_KEY when set, else a file in the user's config
 * directory, made on the first forecast. The key goes nowhere but that file and the signatures.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export interface Signer {
  /** Lowercase, as the record writes it. */
  readonly address: string;
  /** Signs a 32-byte digest: 65 bytes, r ‖ s ‖ v with v 27 or 28, as 0x hex. */
  sign(digest: Uint8Array): string;
}

export interface KeySource {
  /** HYPERODDS_FORECAST_KEY; empty counts as unset. */
  env?: string;
  path: string;
  log: (line: string) => void;
}

/** XDG_CONFIG_HOME, %APPDATA% on Windows, else ~/.config; then hyperodds/forecaster.key. */
export function keyPath(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  const xdg = env.XDG_CONFIG_HOME;
  let base = join(homedir(), ".config");
  if (xdg && isAbsolute(xdg)) base = xdg;
  else if (platform === "win32") base = env.APPDATA || join(homedir(), "AppData", "Roaming");
  return join(base, "hyperodds", "forecaster.key");
}

const errno = (error: unknown) => (error as NodeJS.ErrnoException)?.code ?? "unknown error";

function parse(text: string): Uint8Array | null {
  const hex = text.trim().replace(/^0x/i, "");
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  const key = hexToBytes(hex);
  return secp256k1.utils.isValidSecretKey(key) ? key : null;
}

function signer(key: Uint8Array): Signer {
  const publicKey = secp256k1.getPublicKey(key, false);
  return {
    address: `0x${bytesToHex(keccak_256(publicKey.subarray(1)).subarray(12))}`,
    sign(digest) {
      const sig = secp256k1.sign(digest, key, { prehash: false, format: "recovered" });
      return `0x${bytesToHex(sig.subarray(1))}${(27 + sig[0]!).toString(16)}`;
    },
  };
}

function read(source: KeySource): Signer | null {
  const { path } = source;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (errno(error) === "ENOENT") return null;
    throw new Error(`Could not read the forecaster key at ${path} (${errno(error)}).`);
  }
  const key = parse(text);
  if (!key)
    throw new Error(
      `${path} does not hold a forecaster key. Move it aside to make a new one on the next forecast.`,
    );
  if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0)
    source.log(`${path} can be read by other users of this computer. Run: chmod 600 "${path}"`);
  return signer(key);
}

/**
 * The key, read from the environment or the file; with `create`, made and saved first if there is
 * none. Null when there is none and `create` is off. Errors name the variable or the file, never
 * what is in them.
 */
export function openKey(source: KeySource, create: boolean): Signer | null {
  if (source.env) {
    const key = parse(source.env);
    if (!key)
      throw new Error(
        "HYPERODDS_FORECAST_KEY is not a private key: it takes 64 hex digits, with or without 0x.",
      );
    return signer(key);
  }
  const found = read(source);
  if (found || !create) return found;

  const { path } = source;
  const key = secp256k1.utils.randomSecretKey();
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // "wx": if another client's bridge saved a key a moment ago, keep that one.
    writeFileSync(path, `0x${bytesToHex(key)}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (errno(error) === "EEXIST") return read(source);
    throw new Error(`Could not save a forecaster key to ${path} (${errno(error)}).`);
  }
  const made = signer(key);
  source.log(`Made forecaster ${made.address} and saved its key to ${path}. Back up that file to keep it.`);
  return made;
}

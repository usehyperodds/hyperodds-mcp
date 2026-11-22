/**
 * This computer's forecaster key: HYPERODDS_FORECAST_KEY when set, else a file in the user's config
 * directory, made on the first forecast. The key goes nowhere but that file and the signatures.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
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

/** HYPERODDS_FORECAST_KEY, taken out of the environment so nothing later in the process finds it there. */
export function takeKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = env.HYPERODDS_FORECAST_KEY;
  delete env.HYPERODDS_FORECAST_KEY;
  return key;
}

const errno = (error: unknown) => (error as NodeJS.ErrnoException)?.code ?? "unknown error";
// Windows has no owner and mode bits to check; the key relies on the permissions of %APPDATA%.
const posix = process.platform !== "win32";

/** Anyone who can write to the key's folder could put a key of their own in its place. */
function checkFolder(dir: string): void {
  if (posix && (statSync(dir).mode & 0o022) !== 0)
    throw new Error(
      `Other users of this computer can write to ${dir}, the folder that holds the forecaster key, so the bridge won't use it. Run: chmod go-w "${dir}"`,
    );
}

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
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if (errno(error) === "ENOENT") return null;
    throw new Error(`Could not read the forecaster key at ${path} (${errno(error)}).`);
  }
  try {
    const stat = fstatSync(fd);
    if (posix && stat.uid !== process.getuid?.())
      throw new Error(
        `The forecaster key at ${path} belongs to another user of this computer, so the bridge won't sign with it. Move it aside, and the next forecast makes a key of your own.`,
      );
    checkFolder(dirname(path));
    const key = parse(readFileSync(fd, "utf8"));
    if (!key)
      throw new Error(
        `${path} does not hold a forecaster key. Move it aside to make a new one on the next forecast.`,
      );
    if (posix && (stat.mode & 0o077) !== 0)
      source.log(`${path} can be read by other users of this computer. Run: chmod 600 "${path}"`);
    return signer(key);
  } finally {
    closeSync(fd);
  }
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
  const dir = dirname(path);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new Error(`Could not save a forecaster key to ${path} (${errno(error)}).`);
  }
  checkFolder(dir);
  const key = secp256k1.utils.randomSecretKey();
  // Written whole and synced under a name of its own, then linked into place: no bridge ever reads
  // half a key, and the link fails rather than replace a key another bridge saved a moment ago.
  const temp = join(dir, `.forecaster.key.${randomUUID()}`);
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeSync(fd, `0x${bytesToHex(key)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    linkSync(temp, path);
  } catch (error) {
    if (errno(error) === "EEXIST") return read(source);
    throw new Error(`Could not save a forecaster key to ${path} (${errno(error)}).`);
  } finally {
    rmSync(temp, { force: true });
  }
  const made = signer(key);
  source.log(`Made forecaster ${made.address} and saved its key to ${path}. Back up that file to keep it.`);
  return made;
}

/**
 * This computer's forecaster key: HYPERODDS_FORECAST_KEY when set, else a file in the user's config
 * directory, made on the first forecast. The key goes nowhere but that file and the signatures.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
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

/** Whoever can change a link on the way to the key could choose the key the bridge signs with. */
function checkLinks(dir: string): void {
  if (!posix) return;
  // Nothing above the config folder: links there are often the system's, like /var on macOS.
  const base = dirname(dir);
  if (lstatSync(base, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new Error(
      `${base}, which holds the forecaster key's folder, is a link, so the bridge won't use it. Set XDG_CONFIG_HOME to a folder of your own that is not a link.`,
    );
  if (lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new Error(
      `${dir}, the folder that holds the forecaster key, is a link, so the bridge won't use it. Move the folder it points to into its place, or move the link aside to make a new key on the next forecast.`,
    );
}

/** Anyone who owns or can write to the key's folder could put a key of their own in its place. */
function checkFolder(dir: string): void {
  if (!posix) return;
  checkLinks(dir);
  const stat = statSync(dir);
  if (stat.uid !== process.getuid?.())
    throw new Error(
      `${dir}, the folder that holds the forecaster key, belongs to another user of this computer, so the bridge won't use it. Set XDG_CONFIG_HOME to a folder of your own.`,
    );
  if ((stat.mode & 0o022) !== 0)
    throw new Error(
      `Other users of this computer can write to ${dir}, the folder that holds the forecaster key, so the bridge won't use it. Run: chmod go-w "${dir}"`,
    );
}

// A link would let whoever can change it choose the key, and a dangling one would read as no key
// at all, so forecasts would leave unsigned.
const READ = posix ? constants.O_RDONLY | constants.O_NOFOLLOW : "r";
// A key is saved under a name starting with this, then linked into place.
const TEMP = ".forecaster.key.";
const nap = new Int32Array(new SharedArrayBuffer(4));

/** Another bridge is still saving this key: the temp name it wrote it under leads to the same file. */
function saving(dir: string, ino: number): boolean {
  return readdirSync(dir).some(
    (name) => name.startsWith(TEMP) && lstatSync(join(dir, name), { throwIfNoEntry: false })?.ino === ino,
  );
}

/** Checked on the open file, so the file checked is the file read. */
function checkFile(path: string, fd: number): void {
  if (!posix) return;
  const stat = fstatSync(fd);
  if (stat.uid !== process.getuid?.())
    throw new Error(
      `The forecaster key at ${path} belongs to another user of this computer, so the bridge won't sign with it. Move it aside, and the next forecast makes a key of your own.`,
    );
  if ((stat.mode & 0o066) !== 0)
    throw new Error(
      `Other users of this computer can read or change ${path}, the forecaster key, so the bridge won't sign with it. Run: chmod 600 "${path}"`,
    );
  if (stat.nlink === 1) return;
  // A bridge saving a new key links it into place, then removes its temp name, so a key read in
  // between has two links. Wait that out, a second at most, and nothing else.
  for (let tries = 0; tries < 200 && saving(dirname(path), stat.ino); tries++) Atomics.wait(nap, 0, 0, 5);
  if (fstatSync(fd).nlink > 1)
    throw new Error(
      `${path} is a hard link: the forecaster key in it also lives under another name on this computer, so the bridge won't sign with it. Replace it with a copy of its own, or move it aside to make a new key on the next forecast.`,
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

function read(path: string): Signer | null {
  let fd: number;
  try {
    fd = openSync(path, READ);
  } catch (error) {
    if (errno(error) === "ENOENT") return null;
    // FreeBSD answers a link with EMLINK.
    if (errno(error) === "ELOOP" || errno(error) === "EMLINK")
      throw new Error(
        `${path} is a link, not the forecaster key itself, so the bridge won't use it. Put the key file there, or move the link aside to make a new key on the next forecast.`,
      );
    throw new Error(`Could not read the forecaster key at ${path} (${errno(error)}).`);
  }
  try {
    checkFile(path, fd);
    checkFolder(dirname(path));
    const key = parse(readFileSync(fd, "utf8"));
    if (!key)
      throw new Error(
        `${path} does not hold a forecaster key. Move it aside to make a new one on the next forecast.`,
      );
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
  const { path } = source;
  const found = read(path);
  if (found) return found;

  const dir = dirname(path);
  // With create off too: a linked folder that leads nowhere would read as no key, so forecasts
  // would leave unsigned. And before mkdir, which follows links.
  checkLinks(dir);
  if (!create) return null;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new Error(`Could not save a forecaster key to ${path} (${errno(error)}).`);
  }
  // Again, for a link put in place while mkdir ran.
  checkFolder(dir);
  const key = secp256k1.utils.randomSecretKey();
  // Written whole and synced under a name of its own, then linked into place: no bridge ever reads
  // half a key, and the link fails rather than replace a key another bridge saved a moment ago.
  const temp = join(dir, `${TEMP}${randomUUID()}`);
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
    if (errno(error) === "EEXIST") return read(path);
    throw new Error(`Could not save a forecaster key to ${path} (${errno(error)}).`);
  } finally {
    rmSync(temp, { force: true });
  }
  const made = signer(key);
  source.log(`Made forecaster ${made.address} and saved its key to ${path}. Back up that file to keep it.`);
  return made;
}

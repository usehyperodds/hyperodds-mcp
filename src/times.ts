/**
 * The signed time of the last forecast this computer sent on each outcome, per forecaster, kept
 * beside the key. Hyperodds counts the forecast signed latest and refuses one signed no later than
 * the last it accepted on that outcome (out_of_order), so a revision within the same second, or
 * after the clock steps back, is signed a second past the last one instead.
 */
import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { errno, prepareFolder, READ } from "./key.js";

type Sent = Record<string, Record<string, number>>;

/** Times older than this can't be later than a fresh one, unless the clock stepped back a day. */
const KEEP_S = 86_400;
/** Hyperodds refuses a time further than this from its clock (stale_time). */
const AHEAD_S = 600;
/** A day of forecasts at the server's daily cap is about 20 KB. */
const MAX_BYTES = 1_000_000;

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export class SignedTimes {
  constructor(
    private readonly file: string,
    private readonly log: (line: string) => void,
  ) {}

  /**
   * Now, or a second past the latest time sent on any of these outcomes, but never more than
   * AHEAD_S past now. Throws, with the fix, when the folder fails the key folder's checks.
   */
  next(forecaster: string, outcomes: number[], nowMs: number): number {
    prepareFolder(dirname(this.file));
    const nowS = Math.floor(nowMs / 1000);
    const mine = this.read(nowS)[forecaster] ?? {};
    return Math.min(nowS + AHEAD_S, Math.max(nowS, ...outcomes.map((o) => (mine[o] ?? -1) + 1)));
  }

  record(forecaster: string, outcomes: number[], time: number, nowMs: number): void {
    const nowS = Math.floor(nowMs / 1000);
    const sent = this.read(nowS);
    const mine = sent[forecaster] ?? {};
    for (const o of outcomes) mine[o] = Math.max(mine[o] ?? 0, time);
    sent[forecaster] = mine;
    const oldest = nowS - KEEP_S;
    for (const [who, times] of Object.entries(sent)) {
      for (const [o, t] of Object.entries(times)) if (t < oldest) delete times[o];
      if (Object.keys(times).length === 0) delete sent[who];
    }
    const temp = `${this.file}.${randomUUID()}`;
    try {
      prepareFolder(dirname(this.file));
      writeFileSync(temp, JSON.stringify(sent), { mode: 0o600, flag: "wx" });
      // Replaces a link in its place too, rather than write where it leads.
      renameSync(temp, this.file);
    } catch (error) {
      rmSync(temp, { force: true });
      const why = (error as NodeJS.ErrnoException)?.code ?? (error as Error).message;
      this.log(
        `Could not save forecast times to ${this.file} (${why}). A revision within the same second may be refused.`,
      );
    }
  }

  /** The times in the file, none later than AHEAD_S past now. */
  private read(nowS: number): Sent {
    let text: string;
    try {
      const fd = openSync(this.file, READ);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile()) {
          this.log(`${this.file} is not a regular file, so the bridge ignores it.`);
          return {};
        }
        if (stat.size > MAX_BYTES) {
          this.log(`${this.file} is over 1 MB, far more than forecast times take, so the bridge ignores it.`);
          return {};
        }
        text = readFileSync(fd, "utf8");
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      const code = errno(error);
      // FreeBSD answers a link with EMLINK.
      if (code === "ELOOP" || code === "EMLINK")
        this.log(
          `${this.file} is a link, so the bridge ignores it and saves the forecast times in its place.`,
        );
      else if (code !== "ENOENT") this.log(`Could not read forecast times from ${this.file} (${code}).`);
      return {};
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Unreadable: no times to go past, and the next record writes a fresh file.
      return {};
    }
    const sent: Sent = {};
    if (!isPlain(parsed)) return sent;
    for (const [who, times] of Object.entries(parsed)) {
      if (!isPlain(times)) continue;
      const kept: Record<string, number> = {};
      for (const [o, t] of Object.entries(times))
        if (typeof t === "number" && Number.isSafeInteger(t)) kept[o] = Math.min(t, nowS + AHEAD_S);
      sent[who] = kept;
    }
    return sent;
  }
}

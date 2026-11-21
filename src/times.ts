/**
 * The signed time of the last forecast this computer sent on each outcome, per forecaster, kept
 * beside the key. Hyperodds counts the forecast signed latest and refuses one signed no later than
 * the last it accepted on that outcome (out_of_order), so a revision within the same second, or
 * after the clock steps back, is signed a second past the last one instead.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type Sent = Record<string, Record<string, number>>;

/** Times older than this can't be later than a fresh one, unless the clock stepped back a day. */
const KEEP_S = 86_400;

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export class SignedTimes {
  constructor(
    private readonly file: string,
    private readonly log: (line: string) => void,
  ) {}

  /** Now, or a second past the latest time sent on any of these outcomes. */
  next(forecaster: string, outcomes: number[], nowMs: number): number {
    const mine = this.read()[forecaster] ?? {};
    return Math.max(Math.floor(nowMs / 1000), ...outcomes.map((o) => (mine[o] ?? -1) + 1));
  }

  record(forecaster: string, outcomes: number[], time: number, nowMs: number): void {
    const sent = this.read();
    const mine = sent[forecaster] ?? {};
    for (const o of outcomes) mine[o] = Math.max(mine[o] ?? 0, time);
    sent[forecaster] = mine;
    const oldest = Math.floor(nowMs / 1000) - KEEP_S;
    for (const [who, times] of Object.entries(sent)) {
      for (const [o, t] of Object.entries(times)) if (t < oldest) delete times[o];
      if (Object.keys(times).length === 0) delete sent[who];
    }
    const temp = `${this.file}.${randomUUID()}`;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(temp, JSON.stringify(sent), { mode: 0o600 });
      renameSync(temp, this.file);
    } catch (error) {
      rmSync(temp, { force: true });
      const code = (error as NodeJS.ErrnoException)?.code ?? "unknown error";
      this.log(
        `Could not save forecast times to ${this.file} (${code}). A revision within the same second may be refused.`,
      );
    }
  }

  private read(): Sent {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      // Missing or unreadable: no times to go past, and the next record writes a fresh file.
      return {};
    }
    const sent: Sent = {};
    if (!isPlain(parsed)) return sent;
    for (const [who, times] of Object.entries(parsed)) {
      if (!isPlain(times)) continue;
      const kept: Record<string, number> = {};
      for (const [o, t] of Object.entries(times))
        if (typeof t === "number" && Number.isSafeInteger(t)) kept[o] = t;
      sent[who] = kept;
    }
    return sent;
  }
}

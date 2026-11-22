/**
 * The replay's id maps (`./engine.ts`): each recorded id the replay has
 * met and the id the current code minted for the same row, both ways, so
 * a model's recorded arguments reach the replay's rows and the host's
 * words read back in the recording's terms.
 */

import { type JsonRecord, normalizeWording } from "./recording.ts";

export class ReplayIds {
  readonly toReplay = new Map<string, string>();
  readonly toRecorded = new Map<string, string>();

  alias(recorded: string, replay: string): void {
    this.toReplay.set(recorded, replay);
    this.toRecorded.set(replay, recorded);
  }

  mapArgs(value: unknown): unknown {
    if (typeof value === "string") return this.toReplay.get(value) ?? value;
    if (Array.isArray(value)) return value.map((item) => this.mapArgs(item));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value as JsonRecord).map(([key, inner]) => [key, this.mapArgs(inner)]),
    );
  }

  normalize(text: string): string {
    let out = text;
    for (const [replay, recorded] of this.toRecorded) {
      if (replay === recorded || replay.length < 6) continue;
      out = out.split(replay).join(recorded);
    }
    return normalizeWording(out);
  }
}

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { HOME } from "@shared/deviceNames";
import { type InvokeRequest, invokeContract, type WorkInvokeChannel } from "@shared/ipc";
import { requestRepeatsSafely } from "@shared/work";
import { z } from "zod";
import { CHANGE_RECOVERY, changeRecoveryCheck } from "../session/workRecovery";

/**
 * What the home keeps of one task's conversation on a computer that runs
 * work, in `crewmates/<task>/placed/` (docs/helper.md, "Work requests"):
 *
 * - `calls.jsonl`, each callback's answer or refusal, kept before it is
 *   returned, so a callback asked again after a drop is answered from here;
 * - `begun.jsonl`, each non-repeatable change's call id, synced to disk
 *   before the change, so a cut answer never repeats its effect;
 * - `state.json`, the newest event kept for good and the newest turn's end,
 *   saved at every model turn's end.
 *
 * A line a quit cut short in either log was never answered or begun: it is
 * read as absent.
 */

/** One callback answered, as `calls.jsonl` keeps it. */
export type CallLine = {
  callId: string;
  channel: string;
  /** The newest event the home had taken in when it answered. */
  after: number;
  answer?: unknown;
  error?: string;
  /** A report's words, which a restart here gives its turn again. */
  report?: { text: string; summary?: string; declared?: unknown };
};

const keptStateSchema = z.object({
  kept: z.number().int().nonnegative(),
  ended: z.number().int().nonnegative(),
});

const callLineSchema = z.object({
  callId: z.string(),
  channel: z.string(),
  after: z.number().int().nonnegative(),
  answer: z.unknown().optional(),
  error: z.string().optional(),
  report: z
    .object({ text: z.string(), summary: z.string().optional(), declared: z.unknown().optional() })
    .optional(),
});

export class PlacedLedger {
  /** `calls.jsonl` by call id, read once at first use. */
  private calls: Map<string, CallLine> | undefined;
  /** Whether `calls.jsonl` ended in a line a quit cut short when it was read. */
  private cut = false;
  /** `begun.jsonl`, read once at the first change. */
  private begun: Set<string> | undefined;

  /** `dir` is the task's `crewmates/<task>/placed/` folder. */
  constructor(private readonly dir: string) {}

  /** Where the callbacks' answers are kept, which retention rewrites in place (`rewriteOutsideData`). */
  get callsFile(): string {
    return join(this.dir, "calls.jsonl");
  }

  /** The newest event kept for good and the newest turn's end kept; none before the first. */
  place(): z.infer<typeof keptStateSchema> {
    try {
      return keptStateSchema.parse(JSON.parse(readFileSync(join(this.dir, "state.json"), "utf8")));
    } catch {
      return { kept: 0, ended: 0 };
    }
  }

  /** Saves the place at a model turn's end, whole or not at all; throws when it cannot. */
  keepPlace(kept: number, ended: number): void {
    mkdirSync(this.dir, { recursive: true });
    const next = join(this.dir, "state.json.next");
    writeFileSync(next, `${JSON.stringify({ kept, ended })}\n`);
    renameSync(next, join(this.dir, "state.json"));
  }

  /**
   * Marks, or clears, that the conversation held there was refused words
   * here (`PlacedSessions.refuseHeld`): kept across this Mac's restarts, so
   * the next open there opens anew instead of reattaching to it.
   */
  keepRefused(refused: boolean): void {
    const file = join(this.dir, "refused");
    if (!refused) {
      rmSync(file, { force: true });
      return;
    }
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(file, "");
  }

  /** Whether the conversation held there was refused words here (`keepRefused`). */
  refused(): boolean {
    return existsSync(join(this.dir, "refused"));
  }

  answered(callId: string): CallLine | undefined {
    return this.read().get(callId);
  }

  /** Every answer kept, in the order they were first kept. */
  lines(): CallLine[] {
    return [...this.read().values()];
  }

  /** Kept before it is returned, so a callback asked again is answered from here. */
  keep(line: CallLine): void {
    const calls = this.read();
    mkdirSync(this.dir, { recursive: true });
    // Start on a fresh line after an answer a quit cut short, or this one is
    // glued onto it and read as cut at the next restart.
    appendFileSync(this.callsFile, `${this.cut ? "\n" : ""}${JSON.stringify(line)}\n`);
    this.cut = false;
    calls.set(line.callId, line);
  }

  /** `calls.jsonl` was rewritten in place: it is read again at its next use. */
  reread(): void {
    this.calls = undefined;
  }

  /** Synced before a non-repeatable change; a cut answer must never repeat its effect. */
  begin(channel: WorkInvokeChannel, request: Record<string, unknown>): void {
    if (invokeContract[channel].effect !== "change" || requestRepeatsSafely(channel)) return;
    const path = join(this.dir, "begun.jsonl");
    if (!this.begun) {
      const begun = new Set<string>();
      let text = "";
      try {
        text = readFileSync(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          begun.add(z.string().parse(JSON.parse(line)));
        } catch {
          // A final partial mark cannot have preceded an effect: sync had not returned.
        }
      }
      this.begun = begun;
    }
    const callId = request.callId as string;
    if (this.begun.has(callId)) {
      const [action, result] = CHANGE_RECOVERY[channel] ?? [
        "updating this task",
        "the change may already be recorded",
      ];
      throw new Error(
        `${HOME.The} stopped while ${action}, so ${result}. ${changeRecoveryCheck(channel)}`,
      );
    }
    mkdirSync(this.dir, { recursive: true });
    const fd = openSync(path, "a");
    try {
      // Start on a fresh line even if a crash left a partial final mark.
      writeFileSync(fd, `\n${JSON.stringify(callId)}\n`);
      fsyncSync(fd);
      this.begun.add(callId);
    } finally {
      closeSync(fd);
    }
  }

  private read(): Map<string, CallLine> {
    if (this.calls) return this.calls;
    const calls = new Map<string, CallLine>();
    let text = "";
    try {
      text = readFileSync(this.callsFile, "utf8");
    } catch {}
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const call = callLineSchema.parse(JSON.parse(line)) as CallLine;
        calls.set(call.callId, call);
      } catch {
        // A line a quit cut short was never answered: it is asked again.
      }
    }
    this.cut = text !== "" && !text.endsWith("\n");
    this.calls = calls;
    return calls;
  }
}

/** The words of a report, kept with its answer so a restart here gives its turn them again. */
export function reportOf(
  channel: WorkInvokeChannel,
  request: unknown,
): Pick<CallLine, "report"> | Record<string, never> {
  if (channel !== "inf:work:report") return {};
  const { text, summary, declared } = request as InvokeRequest<"inf:work:report">[0];
  return {
    report: {
      text,
      ...(summary !== undefined ? { summary } : {}),
      ...(declared !== undefined ? { declared } : {}),
    },
  };
}

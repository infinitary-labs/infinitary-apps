import type { LaunchResult } from "./recipient";
import { SECRET_REQUEST_LIFETIME_MS } from "./requests";

/**
 * How a program on a computer that runs work ended, as that computer tells
 * it (`placedSecretUseInputSchema`'s `ended`): its exit code or signal, a
 * bound file that changed before the start, values it never received, a
 * start that failed, or values it lost before starting.
 */
export type ElsewhereEnd =
  | { exitCode: number }
  | { signal: string }
  | { outcome: "changed" | "undeliverable" | "failed" | "lost" };

/** What a take answers: the values once, or why there are none to give. */
export type TakeAnswer =
  | { values: Record<string, string> }
  | { none: "taken" | "changed" | "wait" };

type Handoff = {
  /**
   * The values in transit encoding: until the one take, then for that take's
   * call alone until the use ends or its lifetime passes, so a call the work
   * route asks again after a cut-off receives them again.
   */
  values?: Record<string, string>;
  authorized?: () => boolean;
  launched?: () => void;
  taken: boolean;
  /** The work call that took the values. */
  takenBy?: string;
  /** Settles `hand`; `unknown` rejects it, which the backend records as an unknown outcome. */
  end?: (result: LaunchResult | "unknown") => void;
  deadline?: ReturnType<typeof setTimeout>;
};

/**
 * The values of approved uses whose programs run on a computer that runs work
 * (docs/secrets.md, "On a computer that runs work"), each handed to that
 * computer once. The backend calls `hand` after its last authorization check;
 * the computer's take receives the values and starts its program; its ended
 * report answers `hand`. Nothing here is written to disk, and a handoff no
 * take reaches within the use's own lifetime ends as undeliverable.
 */
export class SecretHandoffs {
  private readonly handoffs = new Map<string, Handoff>();
  private readonly waiters = new Map<string, Set<() => void>>();

  /** The backend's half: give the values for this request and await how the program ended. */
  hand(
    request: string,
    values: Record<string, Buffer>,
    authorized: () => boolean,
    launched?: () => void,
  ): Promise<LaunchResult> {
    const existing = this.handoffs.get(request);
    if (existing?.end || existing?.taken) return Promise.resolve("undeliverable");
    return new Promise<LaunchResult>((resolve, reject) => {
      const handoff: Handoff = {
        values: Object.fromEntries(
          Object.entries(values).map(([name, value]) => [name, value.toString("base64")]),
        ),
        authorized,
        ...(launched ? { launched } : {}),
        taken: false,
        end: (result) => {
          if (handoff.deadline) clearTimeout(handoff.deadline);
          delete handoff.values;
          delete handoff.end;
          this.handoffs.delete(request);
          if (result === "unknown") reject(new Error("The program's outcome is unknown."));
          else resolve(result);
          this.wake(request);
        },
      };
      // A computer that never takes the values gets nothing: the use ends unsent.
      handoff.deadline = setTimeout(() => {
        if (!handoff.taken) handoff.end?.("undeliverable");
      }, SECRET_REQUEST_LIFETIME_MS);
      handoff.deadline.unref?.();
      this.handoffs.set(request, handoff);
      this.wake(request);
    });
  }

  /**
   * The computer's take by one work call: the values once, checked against
   * the saved decisions at this moment; the same values again for that same
   * call, asked again after a cut-off; `taken` for any other call; `wait`
   * while none are handed yet.
   */
  take(request: string, call: string): TakeAnswer {
    const handoff = this.handoffs.get(request);
    if (!handoff) return { none: "wait" };
    if (handoff.taken)
      return handoff.takenBy === call && handoff.values
        ? { values: handoff.values }
        : { none: "taken" };
    const values = handoff.values;
    if (!values || !handoff.authorized) return { none: "wait" };
    if (!handoff.authorized()) {
      handoff.end?.("changed");
      return { none: "changed" };
    }
    handoff.taken = true;
    handoff.takenBy = call;
    if (handoff.deadline) clearTimeout(handoff.deadline);
    // The program's run is not bounded, only how long its call may ask again.
    handoff.deadline = setTimeout(() => {
      delete handoff.values;
    }, SECRET_REQUEST_LIFETIME_MS);
    handoff.deadline.unref?.();
    handoff.launched?.();
    return { values };
  }

  /** Whether this request's values already left for its computer. */
  taken(request: string): boolean {
    return this.handoffs.get(request)?.taken ?? false;
  }

  /** The computer's ended report, for values it took. */
  ended(request: string, result: ElsewhereEnd): boolean {
    const handoff = this.handoffs.get(request);
    if (!handoff?.end || !handoff.taken) return false;
    if ("outcome" in result) {
      // Values the computer received may have reached a program: only a
      // changed file or values never received say nothing ran.
      if (result.outcome === "changed") handoff.end("changed");
      else if (result.outcome === "undeliverable") handoff.end("undeliverable");
      else handoff.end("unknown");
    } else handoff.end(result);
    return true;
  }

  /**
   * Its computer's conversation is gone: values it took may have reached a
   * program that tells nothing more, so that use ends unknown; values no take
   * reached go nowhere, so it ends unsent.
   */
  gone(request: string): void {
    const handoff = this.handoffs.get(request);
    handoff?.end?.(handoff.taken ? "unknown" : "undeliverable");
  }

  /** Wait until this request's handoff changes, or `wake` is called for it, or `until` passes. */
  wait(request: string, until: number, now: number): Promise<void> {
    return new Promise((resolve) => {
      const waiters = this.waiters.get(request) ?? new Set<() => void>();
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        if (waiters.size === 0) this.waiters.delete(request);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, until - now));
      timer.unref?.();
      waiters.add(done);
      this.waiters.set(request, waiters);
    });
  }

  /** Wake every take waiting on this request, such as when its receipt changed. */
  wake(request: string): void {
    for (const done of [...(this.waiters.get(request) ?? [])]) done();
  }
}

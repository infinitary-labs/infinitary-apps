import { COMPUTER, HERE } from "@shared/deviceNames";
import { noSignInsStartRefusal, updateStartRefusal } from "@shared/deviceSetup";
import { noNewWorkStartRefusal } from "@shared/deviceUpdateNudge";
import { forgeSignInCardId } from "@shared/forges";
import { LOCAL_MACHINE_ID } from "../session/session";
import type { TaskRecord } from "../storage/taskRecords";
import { ForgeAuthRequiredError } from "../workspace/forgeAuth";
import type { CrewCore } from "./crewCore";
import { lostStepWords, type StartStep } from "./lostStarts";
import { namedModelOf, namedModelWords } from "./namedModel";
import { placedCutOffStartRefusal } from "./taskPlacement";

/**
 * A crewmate start that failed. Its message reads as it always has for a
 * tool that waited on the start; `reason` is the cause alone, for a wake
 * about a task that is still there.
 */
export class StartFailure extends Error {
  constructor(readonly reason: string) {
    super(`Could not commission a crewmate: ${reason}`);
  }
}

/**
 * What a failed start says went wrong where you read it - the record's
 * Could not start, its Activity line and the reply - and in the wake about
 * a start the first mate asked for: the cause alone, in one line (the
 * captain's "Show only the cause"); the queue's own wake keeps the whole
 * message for the first mate to read. A command's failure keeps only the
 * program's own last error line, such as git's fatal line, never the
 * command, and names each folder it gives by its name alone; with no words
 * of its own it says only that the command failed. A sentence
 * Infinitary wrote itself keeps its first line whole, such as the missing
 * folder it names for repair.
 */
export function startFailureReason(caught: unknown): string {
  const message =
    caught instanceof StartFailure
      ? caught.reason
      : caught instanceof Error
        ? caught.message
        : String(caught);
  const lines = message
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!message.startsWith("Command failed:")) return lines[0] ?? "";
  // A program's own words after the command line: its last error line, its
  // folders by name, a path only where one starts (never a ref or address).
  const said = lines.slice(1);
  return (
    said.findLast((line) => /^(fatal|error):/.test(line)) ??
    said.at(-1) ??
    "the command failed"
  )
    .replace(/^(fatal|error):\s*/, "")
    .replace(/'(?:~|\/)[^']*\/([^'/]+)'/g, "'$1'")
    .replace(/(^|[\s'"([])(?:~|\/)[^\s'"]*\/([^\s'"/]+)/g, "$1$2");
}

function readStartNotice(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { reason?: unknown };
    return typeof parsed.reason === "string" && parsed.reason.length > 0
      ? parsed.reason
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * How a requested start ends (docs/task-graph.md): the settle of a start
 * that began no crewmate, the settle of an attempt the asker watched, and
 * what the start came to in words for whoever asked. `lostAt` is the start
 * owner's record of starts that lost a computer, which it reads and never
 * writes.
 */
export class StartSettle {
  constructor(
    private readonly core: CrewCore,
    private readonly lostAt: ReadonlyMap<string, { step?: StartStep; device?: string }>,
  ) {}

  /**
   * The one settle of a start that began no crewmate (INF-3307's audit,
   * row 4). A refusal for want of a sign-in waits behind that sign-in, here
   * or on the computer it runs on; any other failure is Could not start,
   * back in the backlog for the captain's Start or the first mate's
   * start_now. Either way the task is open and never started, so its record
   * offers Drop task.
   */
  settleFailedStart(taskId: string, caught: unknown, machine: string, swept: boolean): void {
    if (!(caught instanceof ForgeAuthRequiredError)) {
      this.core.options.tasks.starts.returnStart(taskId, {
        kind: "failed",
        reason: startFailureReason(caught),
        ...(swept ? { feed: true as const } : {}),
      });
    } else if (machine !== LOCAL_MACHINE_ID) {
      this.core.placement.holdForDeviceForge(taskId, machine, caught.host);
      const waiting = this.core.options.tasks.get(taskId);
      if (waiting)
        this.core.placement.sayPlacedWait(this.core.placement.waitSubject(waiting), machine, {
          kind: "forge",
          host: caught.host,
        });
    } else {
      this.core.options.tasks.starts.returnStart(taskId, {
        kind: "held",
        gate: {
          kind: "captain",
          ref: `forge-sign-in:${caught.host}`,
          reason: `waiting for ${caught.place} sign-in`,
        },
      });
      this.core.cards.hostCards.addForgeSignInCard(
        forgeSignInCardId(caught.host),
        caught.host,
        caught.place,
        0,
        { reauth: false },
      );
    }
    this.core.cards.scheduleBroadcast();
    this.core.facts.broadcastCrewCounts();
  }

  /**
   * A start that failed outside `startTask`'s own settle: after its claim
   * and before its working copy began or, for one the first mate asked for,
   * before its claim. A `StartFailure` was settled where it ran.
   */
  settleOutsideStart(taskId: string, caught: unknown, asked: boolean, swept: boolean): void {
    if (caught instanceof StartFailure || this.core.tasks.has(taskId)) return;
    const record = this.core.options.tasks.get(taskId);
    if (!record) return;
    const claimed = record.status === "active" && !record.worktreeDir && !record.sessionFile;
    const unclaimed = asked && record.status === "open" && !record.startNotice;
    if (claimed || unclaimed)
      this.settleFailedStart(taskId, caught, record.deviceId ?? LOCAL_MACHINE_ID, swept);
  }

  /**
   * The preview published before the slow start either becomes the claimed
   * row, a known hold, a lost-contact check, or a confirmed failure.
   * Holds keep their existing route. An unknown outcome is not a failure.
   */
  async settleStartAttempt(record: TaskRecord, audience: "tool" | "captain"): Promise<void> {
    if (!this.core.options.tasks.starts.startAttemptOf(record.id)) return;
    const now = this.core.options.tasks.get(record.id);
    if (!now) {
      this.core.options.tasks.starts.clearStartAttempt(record.id);
      return;
    }
    if (now.status === "active") {
      if (
        now.activity === "starting" &&
        !this.core.tasks.has(now.id) &&
        now.deviceId &&
        this.core.facts.outOfReach(now.id)
      ) {
        this.core.options.tasks.starts.markStartChecking(now.id);
        return;
      }
      this.core.options.tasks.starts.clearStartAttempt(now.id);
      return;
    }
    // Back in line after losing its computer: it starts by itself, so the
    // asker's start is not over, whatever that computer says now.
    if (now.shape?.placement_wait || this.lostAt.get(now.id)?.device) {
      this.core.options.tasks.starts.clearStartAttempt(now.id);
      return;
    }
    const signIn = now.deviceId ? this.core.options.machines?.signInWait(now.deviceId) : undefined;
    const setup = now.deviceId
      ? await this.core.placement.placedWaitFor(now.deviceId, now.repoId)
      : undefined;
    if (
      now.gate ||
      signIn ||
      setup ||
      (now.deviceId && this.core.placement.waitsForComputer(now.id, now.deviceId))
    ) {
      this.core.options.tasks.starts.clearStartAttempt(now.id);
      return;
    }
    if (audience === "captain" && record.startPolicy === "on-request" && !now.startNotice) {
      this.core.options.tasks.starts.returnStart(now.id, {
        kind: "failed",
        reason: "it did not start",
      });
      return;
    }
    this.core.options.tasks.starts.clearStartAttempt(now.id);
  }

  /**
   * What a requested start came to, in words for whoever asked: started,
   * still being checked, or the wait it holds on. `shown` says the task's
   * tile already tells it - a start, a check, or a placement wait in its own
   * words - so a start behind the first mate's answer tells it the rest.
   */
  async startOutcome(
    taskId: string,
    handle: string,
    audience: "tool" | "captain",
  ): Promise<{ text: string; shown: boolean }> {
    const told = (text: string) => ({ text, shown: false });
    const now = this.core.options.tasks.get(taskId);
    if (this.core.options.tasks.starts.startAttemptOf(taskId)?.phase === "checking") {
      return { text: `${handle} is still starting. Checking whether it started.`, shown: true };
    }
    // A start that lost its computer is back in line and starts by itself:
    // its record says so, and nobody needs to act (INF-5142 part 4).
    const lost = this.lostAt.get(taskId);
    if (now?.status === "open" && lost?.device && lost.step) {
      const who = this.core.options.machines?.nameOf(lost.device) ?? `its ${COMPUTER.one}`;
      return {
        text: `${handle} lost ${who} ${lostStepWords(lost.step)}. It is back in line and starts by itself once ${who} is back.`,
        shown: true,
      };
    }
    if (
      now?.status !== "active" &&
      now?.deviceId &&
      this.core.placement.waitsForComputer(taskId, now.deviceId)
    ) {
      const place = this.core.options.machines?.placeOf(now.deviceId);
      const who = place?.who ?? "the computer it runs on";
      if (this.core.options.takesNoWorkUntilUpdated?.(now.deviceId))
        return told(noNewWorkStartRefusal(handle, who, HERE.this));
      return told(
        `${handle} waits for ${who}, which is out of reach. It never runs on ${HERE.this} instead.`,
      );
    }
    const signIn =
      now?.status !== "active" && now?.deviceId
        ? this.core.options.machines?.signInWait(now.deviceId)
        : undefined;
    if (now?.deviceId && signIn) {
      const place = this.core.options.machines?.placeOf(now.deviceId);
      return told(
        placedCutOffStartRefusal(
          handle,
          place?.who ?? "the computer it runs on",
          signIn,
          this.core.now(),
        ),
      );
    }
    if (now?.status !== "active" && now?.deviceId && !now.gate) {
      const waitFor = await this.core.placement.placedWaitFor(now.deviceId, now.repoId);
      if (waitFor?.kind === "no-sign-ins") {
        const place = this.core.options.machines?.placeOf(now.deviceId);
        return told(noSignInsStartRefusal(handle, place?.who ?? "the computer it runs on"));
      }
      if (waitFor?.kind === "update") {
        const place = this.core.options.machines?.placeOf(now.deviceId);
        return told(updateStartRefusal(handle, place?.who ?? "the computer it runs on"));
      }
    }
    const automaticWait = now?.shape?.placement_wait?.words;
    if (now?.status !== "active" && automaticWait)
      return { text: `${handle}: ${automaticWait}`, shown: true };
    if (now?.status !== "active") {
      const notice = readStartNotice(now?.startNotice);
      const why = notice ?? now?.gate?.reason;
      const text = `${handle} could not start${why ? `: ${why}` : ""}${audience === "tool" ? "; see the feed" : ""}.`;
      // A gate is named on the tile (`queueWaitOf`), and a gate with a wake
      // of its own - a level's reset, a failed start - already sent it.
      return now?.gate ? { text, shown: true } : told(text);
    }
    // A model the captain named routes only when it can serve; the tool's
    // answer says which model took the task, so the Firstmate never reports
    // the named one when routing fell back.
    const named = namedModelOf(now);
    return {
      text:
        audience === "tool" && named
          ? `Started ${handle} ${namedModelWords(named)}.`
          : `Started ${handle}.`,
      shown: true,
    };
  }
}

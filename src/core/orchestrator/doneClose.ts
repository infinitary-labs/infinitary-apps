import type { DeliveryFact, DoneWhy } from "@shared/deliveryFacts";
import { type OverridableHold, overridePasses, softHoldWords } from "@shared/holds";
import { TASK_CARD_VIA } from "@shared/provenance";
import type { ForgePull } from "../forge/forge";
import type { TaskRecord } from "../storage/taskRecords";
import { type SettleRefusal, TaskGraphRefusal } from "../tasks/taskGraph";
import { carriedOnClose, TaskService } from "../tasks/taskService";
import { cardEmitter } from "./cardEmit";
import type { DeclaredCloses } from "./declaredCloses";
import type { SettleServiceHost } from "./settleHost";
import type { SettleLocks } from "./settleLocks";
import { describeStatus, type SettleService } from "./settleService";
import { changeName, mergedInLine } from "./settleWords";
import { type TaskClose, type TaskClosing, workspaceOf } from "./taskClose";
import { dropWaiting, waitingGuidance } from "./waitingGuidance";
import { waitingWords } from "./waitingWords";

/** What a done close is asked to record (`settle_task` mode done). */
export type DoneCloseInput = {
  why?: DoneWhy;
  /** For carried_on: the task, by key or id, carrying this task's work. */
  carriedBy?: string;
  /** For merged: a pull request number in the task's project, or a commit on the main branch. */
  deliveredIn?: string;
  /** The release or result the first mate names, recorded as stated. */
  evidence?: string;
  /**
   * The captain's own words asking this close, which the caller checked
   * are his: they pass every soft hold, and the close keeps them.
   */
  captainWords?: string;
  /**
   * The captain pressed Close as done on the task's record (INF-3169's
   * plan, piece 3): the close is the captain's, from the task card, and the press is
   * its words.
   */
  fromRecord?: true;
  /**
   * Messages still waiting for its crewmate that the first mate judged it no
   * longer needs, by the ids a refused close named (INF-4072, finding 4):
   * read as gone by the holds, and dropped from its lane, while it is idle,
   * only once the close goes through.
   */
  dropWaiting?: readonly number[];
};

/** The words a press of Close as done on the record carries as the captain's. */
export const CLOSE_AS_DONE_PRESS = "Close as done, pressed on the task's record.";

export type DoneCloseResult = { ok: boolean; text: string; refusal?: SettleRefusal };

/** Whether two tasks deliver through the same pull request or pushed branch. */
function sameChange(left: TaskRecord, right: TaskRecord): boolean {
  const a = left.delivery;
  const b = right.delivery;
  if (a?.prUrl && b?.prUrl) return a.prUrl === b.prUrl;
  return (
    left.repoId !== null &&
    left.repoId === right.repoId &&
    a?.prNumber !== undefined &&
    a.prNumber === b?.prNumber
  );
}

/** A named delivery: a pull request number or a commit, or why the words name neither. */
function namedDelivery(
  words: string | undefined,
): { pull: number } | { commit: string } | { invalid: string } | undefined {
  const named = words?.trim();
  if (!named) return undefined;
  const pull = /^#?(\d+)$/.exec(named);
  if (pull) return { pull: Number(pull[1]) };
  if (/^[0-9a-f]{7,64}$/i.test(named)) return { commit: named };
  return {
    invalid: `delivered_in "${named}" names neither a pull request number nor a commit; name one, such as 812 or a commit id.`,
  };
}

/** A count of things in words: `3 commits`. */
function count(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/**
 * One close as done (INF-3169's plan, piece 2; docs/task-record.md, "One
 * close as done"). The first mate names why the work is done - answered,
 * finished, released, carried on, or merged in a pull request or commit -
 * and the close records each delivery fact beside it, checked by the app,
 * as stated, or unread.
 *
 * It refuses outright only the real limits: a task already closed,
 * another settle of the same task still running, and a missing carrier or
 * evidence. A close on the captain's words stops a working crewmate, and
 * the commits and edits are saved as every close saves them; a copy that
 * cannot be saved stays on disk.
 *
 * Every other hold is soft, and the captain's words asking the close pass
 * them all: the open decisions (a card waiting on him, an answer he asked
 * for and has not read), the open parts, which stay planned, the waits,
 * and the delivery proof. The first mate closing on its own meets each,
 * unless his recorded override passes it. The delivery proof holds while
 * the crewmate has not reported, while the task's own pull request is
 * still open, or while its work is not merged and the close names nowhere
 * else it went.
 *
 * The task's own pull request is left open where the project lives and
 * the record says so; a close carried on by another task still closes its
 * own pull request, unless the carrier delivers through the same one.
 */
export class DoneClose {
  constructor(
    private readonly host: SettleServiceHost,
    private readonly locks: SettleLocks,
    private readonly closing: TaskClosing,
    private readonly settle: SettleService,
    private readonly declared: DeclaredCloses,
  ) {}

  async close(taskRef: string, input: DoneCloseInput): Promise<DoneCloseResult> {
    const record = this.host.resolveTaskRef(taskRef, "task_id");
    const handle = `${record.key || record.id} "${record.title}"`;
    const refuse = (why: string): DoneCloseResult => ({
      ok: false,
      text: `Cannot close ${handle} as done: ${why}`,
    });
    // The real limits.
    if (record.kind !== "work") return refuse("it is not crew work.");
    const pending = this.locks.holder(record.id);
    if (pending || record.pendingSettle)
      return refuse("another settle of it is already in progress. Wait for its outcome.");
    if (TaskService.isClosed(record)) return refuse(`it is already ${describeStatus(record)}.`);

    const words =
      input.captainWords?.trim() || (input.fromRecord ? CLOSE_AS_DONE_PRESS : undefined);
    const why = input.why;
    if (!why && !words)
      return refuse(
        "name why it is done with why, or pass the captain's words that ask this close.",
      );
    const carriedBy = input.carriedBy?.trim();
    if (why === "carried_on" && !carriedBy)
      return refuse("carried_on needs carried_by, the task carrying this task's work.");
    const carrier = carriedBy ? this.host.resolveTaskRef(carriedBy, "carried_by") : undefined;
    if (carrier) {
      const refusal = this.host.tasks.graph.carrierRefusal(record.id, carrier.id, {
        partsStayOpen: true,
      });
      if (refusal) return { ok: false, text: refusal };
    }
    const evidence = input.evidence?.trim() || undefined;
    if (why === "released" && !evidence)
      return refuse("released needs evidence: the release and what shows it delivered the work.");
    if (why === "finished" && !evidence)
      return refuse("finished needs evidence: the completed result and what verifies it.");
    const named = namedDelivery(input.deliveredIn);
    if (named && "invalid" in named) return refuse(named.invalid);
    const ownNumber = record.delivery?.prNumber;
    if (why === "merged" && !named && ownNumber === undefined)
      return refuse(
        "merged needs delivered_in, the pull request or the commit on the main branch that holds its work.",
      );

    // The waiting messages the first mate names to drop: the holds read as
    // if they were gone, and they are withdrawn only just before the close
    // goes through, so a close refused for anything else drops nothing.
    const drop = new Set(input.dropWaiting ?? []);
    const busy = (current: TaskRecord): DoneCloseResult | undefined =>
      drop.size > 0 && this.crewmateWorking(current)
        ? refuse(
            "its crewmate is working, and a waiting message is dropped only while it is idle; wait for its report.",
          )
        : undefined;
    const working = busy(record);
    if (working) return working;

    // The soft holds: the captain's words pass every one; the first mate
    // alone meets each its recorded override does not pass.
    const held = words ? undefined : this.heldOnRecord(record, input.why, carrier, drop);
    if (held) return held.refusal ? held : refuse(held.text);

    const lease = this.locks.claim(record.id, "a close as done");
    try {
      const read = await this.readFacts(record, named, carrier, why, evidence);
      if (!words) {
        // The reads yield: a turn may have started, a card gone up or a
        // wait begun meanwhile, so the holds are read again.
        const current = this.host.tasks.get(record.id);
        if (
          !current ||
          this.locks.working(record.id) ||
          current.status !== record.status ||
          current.activity !== record.activity
        )
          return refuse("its state changed while its delivery was read; try again.");
        const again = this.heldOnRecord(current, input.why, carrier, drop);
        if (again) return again.refusal ? again : refuse(again.text);
        const proof = overridePasses(current.delivery, "proof", current.delivery?.headSha)
          ? undefined
          : this.proofHeld(current, why, carrier, read);
        if (proof) return refuse(`${proof} ${softHoldWords("proof", "firstmate")}`);
      }
      const stillBusy = busy(this.host.tasks.get(record.id) ?? record);
      if (stillBusy) return stillBusy;
      const lead = this.dropNamed(record, drop);
      const closed = await this.closeWith(
        record,
        handle,
        { why, carrier, words, evidence, fromRecord: input.fromRecord === true },
        read,
      );
      return lead ? { ...closed, text: `${lead}${closed.text}` } : closed;
    } catch (caught) {
      if (caught instanceof TaskGraphRefusal) return refuse(caught.message);
      throw caught;
    } finally {
      lease.release();
    }
  }

  /**
   * The soft hold the record places on the first mate's own close, before
   * the delivery is read: an open decision, an open part, a wait, or a
   * crewmate that has not reported. Each passes on the captain's recorded
   * override that names it. A refusal with ways out carries them.
   */
  private heldOnRecord(
    record: TaskRecord,
    why: DoneWhy | undefined,
    carrier?: TaskRecord,
    dropping: ReadonlySet<number> = new Set(),
  ): DoneCloseResult | undefined {
    const passes = (kind: OverridableHold) =>
      overridePasses(record.delivery, kind, record.delivery?.headSha);
    const decision = passes("decisions")
      ? undefined
      : this.openDecision(record, why === "carried_on" ? carrier : undefined);
    if (decision)
      return { ok: false, text: `${decision} ${softHoldWords("decisions", "firstmate")}` };
    // A part of its own that carries the work on, at any depth, holds
    // nothing; its open siblings still hold the first mate's own close.
    const parts = passes("parts")
      ? undefined
      : this.host.tasks.graph.closeRefusal(record.id, {
          carrierId: why === "carried_on" ? carrier?.id : undefined,
        });
    if (parts) {
      const text = `${parts.text} ${softHoldWords("parts", "firstmate")}`;
      return { ok: false, text, refusal: { ...parts, text } };
    }
    const waits = passes("waits") ? undefined : this.host.tasks.graph.blockerRefusal(record.id);
    if (waits) {
      const text = `${waits.text} ${softHoldWords("waits", "firstmate")}`;
      return { ok: false, text, refusal: { ...waits, text } };
    }
    const unreported = passes("proof") ? undefined : this.unreported(record, why, dropping);
    if (unreported)
      return { ok: false, text: `${unreported} ${softHoldWords("proof", "firstmate")}` };
    return undefined;
  }

  /**
   * The open decision that holds the first mate's own close: a card on the
   * task that still asks the captain something, a wait on him, or an answer
   * he asked for and has not read - its crewmate's card is still up, or he
   * has neither chosen on it nor seen it finished nor had it handed on.
   * An answer carried on by the task the captain's own reply under its
   * crewmate's card started is read and answered: his reply chose what
   * follows (INF-4526).
   */
  private openDecision(record: TaskRecord, carrier?: TaskRecord): string | undefined {
    const cards = this.host.cards.snapshot().filter((card) => card.taskId === record.id);
    const asking = cards.find((card) => card.actions.length > 0);
    if (asking) return `its card "${asking.title}" still asks the captain.`;
    if (record.gate || record.delivery?.captainWait)
      return "it still waits on the captain's decision.";
    if (this.host.deliverableOf(record) !== "answer") return undefined;
    const startedFromItsCard =
      carrier !== undefined &&
      this.host.tasks.capture
        .startedFromCardsOf(carrier.id)
        .some((cardId) => cardEmitter(cardId, record.id) === "crewmate");
    if (startedFromItsCard) return undefined;
    const note = cards.find((card) => cardEmitter(card.id, record.id) === "crewmate");
    if (note) return `its answer "${note.title}" is still up for the captain to read.`;
    const read =
      record.shape?.internal_step ||
      record.delivery?.finishedAt !== undefined ||
      this.host.tasks.capture.resultHandoffOf(record.id);
    return read
      ? undefined
      : "the captain asked for its answer, and it closes on their choice on its card.";
  }

  /**
   * Withdraw the waiting messages the close named, just before it goes
   * through, and write their words on the timeline as the first mate's.
   * Answers the lead the close's answer opens with, or "" when none went.
   */
  private dropNamed(record: TaskRecord, drop: ReadonlySet<number>): string {
    if (drop.size === 0) return "";
    const dropped = dropWaiting(this.host.inbox, record.id, [...drop], this.host.now());
    if (dropped.length === 0) return "";
    this.host.tasks.note(
      record.id,
      `The first mate dropped guidance waiting for its crewmate: ${dropped.map((message) => `"${message.excerpt}"`).join("; ")}`,
      { news: false, actor: "firstmate" },
    );
    return `Dropped ${dropped.map((message) => `message ${message.id}`).join(", ")} from its crewmate's lane. `;
  }

  /** Its crewmate's turn is running, or about to. */
  private crewmateWorking(record: TaskRecord): boolean {
    return this.locks.working(record.id) || Boolean(record.activity && record.activity !== "idle");
  }

  /** Why the crewmate has not reported what the close would record, if it has not. */
  private unreported(
    record: TaskRecord,
    why: DoneWhy | undefined,
    dropping: ReadonlySet<number>,
  ): string | undefined {
    // Unstarted work has no crewmate to report: the proof is where the
    // close says its work went (`proofHeld`).
    if (record.status === "open") return undefined;
    if (
      this.crewmateWorking(record) ||
      this.host.hasRunningJobs?.(record.id) ||
      record.delivery?.checkBack
    )
      return "its crewmate is still working; wait for its report.";
    // Guidance still queued for the crewmate is work it has not done; work
    // another task carries on leaves that guidance to the carrier. Guidance
    // set aside after its refusals went to the first mate instead and is
    // never delivered, so it holds nothing (INF-3307 audit). The refusal
    // names each message, so the first mate can drop one the crewmate no
    // longer needs (INF-4072, finding 4).
    if (why !== "carried_on") {
      const waiting = waitingGuidance(this.host.inbox, record.id, this.host.now()).filter(
        (message) => !dropping.has(message.id),
      );
      if (waiting.length > 0)
        return `guidance is still queued for its crewmate; let it finish that first. ${waitingWords(waiting)}`;
    }
    if (!record.outcome?.trim()) return "its crewmate has not reported yet.";
    return undefined;
  }

  /** Every delivery fact the close can read, before it closes. */
  private async readFacts(
    record: TaskRecord,
    named: { pull: number } | { commit: string } | undefined,
    carrier: TaskRecord | undefined,
    why: DoneWhy | undefined,
    evidence: string | undefined,
  ): Promise<ReadFacts> {
    const facts: DeliveryFact[] = [];
    const read: ReadFacts = { facts, ownOpen: [], merged: undefined, work: undefined };
    // The pull request or commit the close names.
    const namedPull =
      named && "pull" in named
        ? named.pull
        : why === "merged" && !named
          ? record.delivery?.prNumber
          : undefined;
    if (namedPull !== undefined) {
      const pull = await this.readPull(record, namedPull);
      const name = changeName(record, namedPull);
      if (!pull)
        facts.push({
          kind: "pull-request",
          basis: "unread",
          text: `Pull request ${name} could not be read`,
        });
      else if (pull.merged) {
        read.merged = { pull };
        facts.push({ kind: "pull-request", basis: "checked", text: `Pull request ${name} merged` });
      } else
        facts.push({
          kind: "pull-request",
          basis: "checked",
          text: `Pull request ${name} is ${pull.state === "open" ? "open" : "closed"}, not merged`,
        });
    }
    if (named && "commit" in named) {
      const repoDir =
        record.repoDir || (record.repoId ? this.host.repos.get(record.repoId)?.path : "");
      const on = await this.host.workspace
        .commitOnMain(repoDir ?? "", named.commit)
        .catch(() => null);
      const short = named.commit.slice(0, 12);
      if (on === null)
        facts.push({ kind: "commit", basis: "unread", text: `Commit ${short} could not be found` });
      else {
        if (on) read.merged = { commit: named.commit };
        facts.push({
          kind: "commit",
          basis: "checked",
          text: on
            ? `Commit ${short} is on the main branch`
            : `Commit ${short} is not on the main branch`,
        });
      }
    }
    // The task's own pull requests: left open, and the record says so.
    for (const number of this.ownPullNumbers(record)) {
      if (number === namedPull) continue;
      const pull = await this.readPull(record, number);
      const name = changeName(record, number);
      if (!pull) {
        facts.push({
          kind: "pull-request",
          basis: "unread",
          text: `Its own pull request ${name} could not be read`,
        });
      } else if (pull.merged) {
        read.merged ??= { pull };
        facts.push({
          kind: "pull-request",
          basis: "checked",
          text: `Its own pull request ${name} merged`,
        });
      } else if (pull.state === "open") {
        read.ownOpen.push(number);
        facts.push({
          kind: "pull-request",
          basis: "checked",
          text:
            why === "carried_on"
              ? `Its own pull request ${name} was open`
              : `Its own pull request ${name} is still open`,
        });
      }
    }
    // The working copy: what it holds is saved by the close.
    if (record.worktreeDir || record.branch || record.deviceId) {
      const work = await (async () =>
        record.deviceId
          ? ((await this.host.placed?.workStatus(record.id)) ?? null)
          : await this.host.workspace.taskWorkStatus(workspaceOf(record), {
              strict: true,
            }))().catch(() => null);
      read.work = work;
      if (!work)
        facts.push({ kind: "work", basis: "unread", text: "Its working copy could not be read" });
      else if (work.dirty || work.unlandedCommits > 0) {
        const held = [
          work.unlandedCommits > 0
            ? `${count(work.unlandedCommits, "commit")} not on the main branch`
            : "",
          work.dirty ? "uncommitted edits" : "",
        ].filter(Boolean);
        facts.push({ kind: "work", basis: "checked", text: `${held.join(" and ")}, saved` });
      } else
        facts.push({ kind: "work", basis: "checked", text: "Its working copy holds no change" });
    }
    if (carrier)
      facts.push({
        kind: "carrier",
        basis: "checked",
        text: `Carried on by ${carrier.key || carrier.id}`,
      });
    if (why === "answered") {
      const on = this.answerCarrier(record);
      facts.push(
        on
          ? {
              kind: "answer",
              basis: "checked",
              text: `Its answer carries on in ${on.task.key || on.task.id} "${on.task.title}"`,
            }
          : record.outcome?.trim()
            ? { kind: "answer", basis: "checked", text: "Its crewmate reported the answer" }
            : { kind: "answer", basis: "checked", text: "Its crewmate reported no answer" },
      );
    }
    if (evidence)
      facts.push({
        kind: "evidence",
        basis: "stated",
        text:
          why === "released"
            ? `Release named by the first mate: ${evidence}`
            : `Result named by the first mate: ${evidence}`,
      });
    const parts = this.host.tasks.graph
      .openChildren(record.id)
      .filter((child) => !TaskService.isDeliveryChild(child));
    if (parts.length > 0)
      facts.push({
        kind: "parts",
        basis: "checked",
        text: `Open ${parts.length === 1 ? "part" : "parts"} ${parts.map((part) => part.key || part.id).join(", ")} stay${parts.length === 1 ? "s" : ""} planned`,
      });
    return read;
  }

  /**
   * The task's own pull requests: the one its record names, and each change
   * it keeps that has not merged. A pull request it only reviews to merge is
   * another's, and stays out.
   */
  private ownPullNumbers(record: TaskRecord): Set<number> {
    const numbers = new Set<number>();
    if (record.delivery?.prNumber !== undefined) numbers.add(record.delivery.prNumber);
    for (const change of this.host.tasks.changesFor(record.id))
      if (change.handle?.number !== undefined && change.receipt?.outcome !== "merged")
        numbers.add(change.handle.number);
    return numbers;
  }

  private async readPull(record: TaskRecord, number: number): Promise<ForgePull | undefined> {
    const pull = this.host.readPull
      ? await this.host.readPull(record.id, number).catch(() => undefined)
      : undefined;
    return pull?.number === number ? pull : undefined;
  }

  /** The live task an answer carries on in: one built on it, or one waiting on it. */
  private answerCarrier(
    record: TaskRecord,
  ): { task: TaskRecord; data: Record<string, string> } | undefined {
    const builtOn = this.host.tasks
      .listLive()
      .filter((task) => task.id !== record.id && task.shape?.basis)
      .find((task) => this.host.tasks.resolve(task.shape?.basis ?? "")?.id === record.id);
    if (builtOn) return { task: builtOn, data: { basisOf: builtOn.id } };
    const waiting = this.host.tasks.graph
      .blocking(record.id)
      .find((task) => !TaskService.isClosed(task));
    return waiting ? { task: waiting, data: { waitedOnBy: waiting.id } } : undefined;
  }

  /**
   * The delivery proof the first mate's own close needs, after the reads:
   * its own pull request closed or merged, and its work merged or named
   * elsewhere - a merged pull request or commit, a release, a carrier, or
   * for an answer the task that builds on it or waits on it.
   */
  private proofHeld(
    record: TaskRecord,
    why: DoneWhy | undefined,
    carrier: TaskRecord | undefined,
    read: ReadFacts,
  ): string | undefined {
    if (why === "merged" && !read.merged)
      return "the pull request or commit it names does not read merged on the main branch.";
    const open = read.ownOpen[0];
    if (open !== undefined && why !== "carried_on")
      return `its own pull request ${changeName(record, open)} is still open; merge it from its merge card, or close it where the project lives.`;
    const unmerged = read.work && (read.work.dirty || read.work.unlandedCommits > 0);
    const elsewhere = read.merged !== undefined || why === "released" || carrier !== undefined;
    if (record.status === "open" && !elsewhere)
      return "it has not started, and the close names nowhere else its work went; name the task carrying it on, or the pull request, commit or release that delivered it.";
    // A started answer task's copy, such as a reproduction's failing check,
    // went to the live task that builds on its answer or waits on it.
    const builtOn =
      why === "answered" &&
      this.host.deliverableOf(record) === "answer" &&
      this.answerCarrier(record) !== undefined;
    if (unmerged && !elsewhere && !builtOn)
      return "its working copy holds work that is not merged, and the close names nowhere else it went; name the pull request or commit that holds it, the release, or the task carrying it on.";
    return undefined;
  }

  private async closeWith(
    record: TaskRecord,
    handle: string,
    asked: {
      why: DoneWhy | undefined;
      carrier: TaskRecord | undefined;
      words: string | undefined;
      evidence: string | undefined;
      fromRecord: boolean;
    },
    read: ReadFacts,
  ): Promise<DoneCloseResult> {
    const { why, carrier, words, evidence, fromRecord } = asked;
    const { facts } = read;
    // A press on the record is the captain's own close, from the task card.
    const actor = fromRecord ? ("captain" as const) : ("firstmate" as const);
    const said = words ? { captainWords: words, onWord: true } : {};
    const recorded = {
      why: why ?? "word",
      deliveryFacts: facts,
      ...said,
      ...(fromRecord ? { via: TASK_CARD_VIA } : {}),
    };
    // The record keeps every fact; the answer leaves out the one its own words already say.
    const lineOf = (shown: DeliveryFact[]) =>
      shown.map((fact) => ` ${fact.text.replace(/\.$/, "")}.`).join("");
    const factLine = lineOf(facts);
    if (carrier) {
      // The replaced-by link first, so the waits on this task move to the
      // carrier (`TaskService.moveWaits`) before the close clears them.
      this.host.tasks.graph.link(record.id, carrier.id, "replaced-by", "firstmate");
      const end = this.host.tasks.graph.carrierOf(record.id);
      const shared = [carrier, end].some((next) => next && sameChange(record, next));
      const pullRequest = shared ? "" : (await this.closing.closeOpenPullRequest(record.id)).text;
      const close = carriedOnClose(carrier, actor);
      await this.closing.closeTask(record.id, { ...close, data: { ...close.data, ...recorded } });
      this.declared.placeHeldOutcome(record.id);
      return {
        ok: true,
        text: `Closed ${handle} as done: ${carrier.key || carrier.id} carries on its work.${pullRequest ? ` ${pullRequest}` : ""}${lineOf(facts.filter((fact) => fact.kind !== "carrier"))}`,
      };
    }
    if (why === "merged" && read.merged) {
      const pull = "pull" in read.merged ? read.merged.pull : undefined;
      const sha = "pull" in read.merged ? read.merged.pull.mergedSha : read.merged.commit;
      const name = pull
        ? `pull request ${changeName(record, pull.number)}`
        : `commit ${sha?.slice(0, 12)}`;
      const mergedIn = mergedInLine(
        pull ? { pull: changeName(record, pull.number) } : { commit: `${sha?.slice(0, 12)}` },
      );
      const merged = await this.settle.closeMerged(
        record,
        actor,
        {
          ok: true,
          text: `Merged in ${name}.`,
          ...mergedIn,
          ...(sha ? { receipt: { head: pull?.headSha ?? sha, sha, already: true } } : {}),
        },
        recorded,
      );
      return { ok: merged.ok, text: `Closed ${handle} as done. ${merged.text}${factLine}` };
    }
    const close = { ...this.reasonOf(record, why, evidence, read), actor };
    await this.closing.closeTask(
      record.id,
      { ...close, data: { ...close.data, ...recorded } },
      { recordBeforeStop: true },
    );
    return {
      ok: true,
      text: `Closed ${handle} as ${close.reason}${words ? " on the captain's word" : ""}.${factLine}`,
    };
  }

  /** The close reason and its text for a why that is not carried on or merged. */
  private reasonOf(
    record: TaskRecord,
    why: DoneWhy | undefined,
    evidence: string | undefined,
    read: ReadFacts,
  ): TaskClose & { data: Record<string, unknown> } {
    if (why === "answered") {
      const on = this.answerCarrier(record);
      const handedOn = this.host.tasks.capture.resultHandoffOf(record.id);
      const text = on
        ? `answered - its answer carries on in ${on.task.key || on.task.id} "${on.task.title}"`
        : handedOn
          ? "answered - its reported result was handed on"
          : record.outcome?.trim()
            ? "answered - its crewmate reported the answer"
            : "answered - its crewmate reported no answer";
      return {
        status: "done",
        reason: "answered",
        actor: "firstmate",
        text,
        data: on ? on.data : handedOn ? { handedOn: true } : { reported: !!record.outcome?.trim() },
      };
    }
    if (why === "released")
      return {
        status: "done",
        reason: "released",
        actor: "firstmate",
        text: `released outside this task: ${evidence}`,
        data: { releaseEvidence: evidence },
        delivery: {},
      };
    // Finished, or the captain's word alone: the personal workspace builds
    // in place, and a copy that held no change closed with nothing to deliver.
    const noChange =
      read.work !== undefined &&
      read.work !== null &&
      !read.work.dirty &&
      read.work.unlandedCommits === 0;
    const personal = this.host.isPersonalTask(record.id);
    const onWord = why === undefined || why === "merged";
    return {
      status: "done",
      reason: "finished",
      actor: "firstmate",
      text: onWord
        ? "finished on the captain's word"
        : evidence
          ? `finished: ${evidence}`
          : "finished",
      data: {
        ...(evidence ? { completionEvidence: evidence } : {}),
        ...(noChange ? { noChange: true } : {}),
      },
      ...(personal
        ? { delivery: { mode: "in-place" as const } }
        : noChange
          ? { delivery: {} }
          : {}),
    };
  }
}

type ReadFacts = {
  facts: DeliveryFact[];
  /** The task's own pull requests that read open. */
  ownOpen: number[];
  /** What reads merged: a pull request, or a commit on the main branch. */
  merged: { pull: ForgePull } | { commit: string } | undefined;
  /** Its working copy; null when it could not be read, undefined when it has none. */
  work: { dirty: boolean; unlandedCommits: number } | null | undefined;
};

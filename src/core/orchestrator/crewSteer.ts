import { createHash } from "node:crypto";
import type { AttachmentRef } from "@shared/attachments";
import type { TurnImage } from "@shared/cards";
import type { ResponsePolicy } from "@shared/crewResponses";
import type { CrewSendResult } from "@shared/crewTranscript";
import { CREWMATE_TAB_VIA, type TASK_CARD_VIA } from "@shared/provenance";
import type { ModelSession } from "../session/session";
import { TaskService } from "../tasks/taskService";
import type { CrewCore } from "./crewCore";
import type { SteerDelivery, SteerSource, TaskRuntime, UnreadSteer } from "./crewRuntime";
import { retiredResumeText } from "./crewSessions";
import { laneOrder } from "./crewTurns";
import { isCaptainGuidance } from "./mergeAuthorization";
import { describeStatus } from "./settleService";
import { toldInCrewmateTabLine } from "./threadWords";
import {
  renderWake,
  replyWordsSpan,
  type WakeBody,
  withAttachmentsDropped,
  withAttachmentsKept,
  withGuidanceMark,
} from "./wakes";

/**
 * Steering a crewmate (docs/inbox.md): words from the first mate, the
 * captain's Crewmate tab and the host itself, kept in the task's durable
 * lane and delivered into a running turn or as the next one, and the
 * reach line a task's own computer coming back announces. Shares the
 * crew's state through `CrewCore`.
 */
export class CrewSteer {
  constructor(private readonly core: CrewCore) {}

  /**
   * Something sent reached a crewmate (INF-759): words entered its turn,
   * its turn was stopped, its task closed under it or was edited. One push
   * says so, and the center draws its spark out to the crewmate then. Only
   * a crewmate on the ring has a place for it.
   */
  announceReach(taskId: string): void {
    const record = this.core.options.tasks.get(taskId);
    if (record?.kind !== "work" || record.status !== "active") return;
    this.core.options.broadcastEvent({
      type: "task_event",
      taskId,
      key: record.key,
      kind: "reached",
      text: "",
      at: this.core.now(),
      feed: false,
      reached: true,
    });
  }

  async steerCrewmate(
    taskId: string,
    message: WakeBody,
    actor: "firstmate" | "captain" = "firstmate",
    source: {
      via?: "tool" | "card" | "thread" | typeof TASK_CARD_VIA | typeof CREWMATE_TAB_VIA;
      decision?: string | null;
      cardId?: string | null;
      /** The panel the captain moved it from, by its title. */
      panel?: string;
      /** The Firstmate steers in a turn that carries the captain's own words. */
      captainWords?: boolean;
      images?: TurnImage[];
      /** The message's own copies of `images`, kept when it was accepted. */
      attachments?: AttachmentRef[];
      /** First mate tool messages expect answers; host/captain steers do not. */
      response?: ResponsePolicy;
    } = {},
  ): Promise<SteerDelivery> {
    const record = this.core.options.tasks.get(taskId);
    if (source.response && actor !== "firstmate")
      throw new Error("Only a first mate message creates or cancels its response expectations.");
    if (
      source.response?.mode === "expected" &&
      record?.deviceId &&
      !this.core.options.machines?.takesResponses?.(record.deviceId)
    )
      throw new Error(
        "Update Infinitary on the work computer before requesting a tracked response. Nothing was sent.",
      );
    for (const id of source.response?.cancel ?? []) {
      const request = this.core.options.inbox.responseRequest(id);
      if (request?.state === "answered")
        throw new Error("An answered request cannot be cancelled. Nothing was sent.");
      if (request?.targetTask !== taskId)
        throw new Error(`Response request ${id} does not belong to this task. Nothing was sent.`);
    }
    if (source.response?.card) this.core.reportIntake.checkResponseCard(source.response.card);
    const steer: SteerSource = {
      actor,
      via: source.via ?? "tool",
      decision: source.decision ?? null,
      cardId: source.cardId ?? null,
      ...(source.panel ? { panel: source.panel } : {}),
      ...(source.captainWords ? { captainWords: true } : {}),
    };
    return this.steerInternal(
      taskId,
      message,
      steer,
      source.images,
      source.attachments,
      source.response,
    );
  }

  /**
   * `body` is the guidance as its lane stores it: the words given, or a
   * typed wake (the ladder's nudge) that renders to the words the crewmate
   * is steered with and the timeline records.
   */
  async steerInternal(
    taskId: string,
    body: WakeBody,
    given: SteerSource,
    images?: TurnImage[],
    attachments?: readonly AttachmentRef[],
    response?: ResponsePolicy,
  ): Promise<SteerDelivery> {
    let message = renderWake(body);
    // A reply the captain typed under a card: the record reads the captain's words in the message.
    const words = replyWordsSpan(body);
    const source = words ? { ...given, words } : given;
    const reviewBuilder = this.core.reviewBuilderOf(this.core.options.tasks.get(taskId));
    const hasImages = Boolean(images?.length);
    const withPictures = (guidance: WakeBody): WakeBody =>
      attachments?.length
        ? withAttachmentsKept(guidance, attachments)
        : hasImages
          ? withAttachmentsDropped(guidance)
          : guidance;
    let durable = withPictures(body);
    const liveImages = hasImages ? images : undefined;
    // The captain's guidance while his kept merge approval stands takes its
    // mark as its row is recorded, and the mark rides the message, so the
    // crewmate can declare only guidance it read (FI3-662).
    const guidance = isCaptainGuidance(given, body);
    // The host's own steer - a timed wait's end, a closed dependency, a
    // check's result - waits on a started task's lane in the backlog.
    const sentByHost = given.actor === "supervisor";
    const enqueue = (): number => {
      if (this.core.restarts.observing(taskId)) {
        this.core.restarts.recordRestartOutcome(
          taskId,
          "stopped",
          "new guidance arrived before automatic recovery was confirmed",
        );
        this.core.restarts.forget(taskId);
      }
      const mark = guidance ? this.core.settling.approvals.holdForGuidance(taskId) : undefined;
      if (mark !== undefined) {
        const marked = withGuidanceMark(body, mark);
        message = renderWake(marked);
        durable = withPictures(marked);
      }
      return this.core.options.inbox.transaction(() => {
        for (const id of response?.cancel ?? []) this.core.options.inbox.cancelResponse(id);
        if (response?.cancel?.length) {
          durable = {
            facts: {
              kind: "responses-cancelled",
              requests: response.cancel,
              guidance: typeof durable === "string" ? durable : durable.facts,
            },
            ...(typeof durable !== "string" && durable.ways ? { ways: durable.ways } : {}),
          };
          message = renderWake(durable);
        }
        if (response?.mode !== "expected") return this.enqueueSteer(taskId, durable);
        const requested = this.core.options.inbox.requestResponse(
          taskId,
          renderWake(body),
          {
            session: response.sourceSession,
            message: given.decision,
            card: response.card,
            targetSession:
              this.core.tasks.get(taskId)?.session?.recordPath() ??
              this.core.options.tasks.get(taskId)?.sessionFile,
          },
          durable,
        );
        durable = requested.body;
        message = renderWake(durable);
        return requested.inboxId;
      });
    };
    const task = this.core.tasks.get(taskId);
    if (task?.session && !task.cancelled) {
      if (task.state === "streaming" || task.state === "starting") {
        // Its computer is out of reach, or this one is being updated: kept
        // on the lane, and steered into the turn once it is back and caught
        // up, or served by the turn that carries it on.
        if (this.core.facts.outOfReach(taskId) || this.core.updates.heldForUpdate(taskId)) {
          const held = enqueue();
          this.recordSteer(taskId, message, source, "recorded-held", held);
          return "recorded-held";
        }
        if (reviewBuilder || task.session.controlProfile.steer === "followup-queue") {
          const queued = enqueue();
          this.recordSteer(taskId, message, source, "queued-next-turn", queued);
          return "queued-next-turn";
        }
        const id = enqueue();
        this.core.options.inbox.markDelivered([id]);
        this.announceReach(taskId);
        try {
          // Handled when the turn it landed in ends: ack rides turnComplete.
          await this.steerIntoTurn(task, task.session, message, [id], liveImages);
          this.recordSteer(taskId, message, source, "mid-turn", id);
          return "mid-turn";
        } catch {
          this.core.options.inbox.release([id]);
          this.recordSteer(taskId, message, source, "recorded-retrying", id);
          return "recorded-retrying";
        }
      }
      const pending = enqueue();
      if (this.core.facts.laneHeld(taskId) || (sentByHost && this.core.facts.inBacklog(taskId))) {
        // Kept on the lane until the account serves again, or the task leaves the backlog.
        this.recordSteer(taskId, message, source, "recorded-held", pending);
        return "recorded-held";
      }
      this.recordSteer(taskId, message, source, "mid-turn", pending);
      this.core.turns.deliverPendingToTask(task, { sent: true });
      return "mid-turn";
    }
    const record = this.core.options.tasks.get(taskId);
    if (!record) {
      throw new Error(`Unknown task "${taskId}". Check crew_status for live task ids.`);
    }
    if (!TaskService.isResumable(record)) {
      throw new Error(
        `Task ${taskId} is ${describeStatus(record)} and no longer steerable. ${record.status === "dropped" ? "On the captain’s request, use update_task start_again to create a replacement." : "Spawn a follow-up crewmate instead."}`,
      );
    }
    if (!record.sessionFile) {
      throw new Error(`Task ${taskId} has no session to resume. Spawn a follow-up instead.`);
    }
    if (this.core.sessions.retiredProviderOf(taskId)) throw new Error(retiredResumeText(taskId));
    const resumeId = enqueue();
    if (this.core.facts.laneHeld(taskId) || (sentByHost && this.core.facts.inBacklog(taskId))) {
      this.recordSteer(taskId, message, source, "recorded-held", resumeId);
      return "recorded-held";
    }
    try {
      const resumed = await this.core.sessions.resumeTask(record.id);
      this.recordSteer(taskId, message, source, "mid-turn", resumeId);
      this.core.turns.deliverPendingToTask(resumed, { sent: true });
      return "mid-turn";
    } catch {
      // The row is durable; the tick sweep retries the resume.
      this.recordSteer(taskId, message, source, "recorded-retrying", resumeId);
      return "recorded-retrying";
    }
  }

  /**
   * A steer's durable row. A host steer that goes out once per fact (the
   * check watch's) records its name with the row (`enqueueSteerOnce`).
   */
  private enqueueSteer(taskId: string, body: WakeBody): number {
    return typeof body !== "string" && body.once !== undefined
      ? this.core.options.inbox.enqueueSteerOnce(taskId, { ...body, once: body.once })
      : this.core.options.inbox.enqueue(taskId, body);
  }

  /**
   * Steer the running turn with lane rows already marked in flight. The
   * rows are the turn's before the session is asked, so a steer that lands
   * in the turn's own tail is known to the turn's end, which takes it back
   * (`undeliveredSteerRows`); a steer the session refuses takes its rows
   * back out and throws.
   */
  async steerIntoTurn(
    task: TaskRuntime,
    session: ModelSession,
    text: string,
    ids: number[],
    images?: TurnImage[],
  ): Promise<void> {
    task.inFlightInboxIds.push(...ids);
    task.steeredInboxIds.push(ids);
    const handed: UnreadSteer = {
      sha: createHash("sha256").update(text).digest("hex"),
      since: this.core.now(),
    };
    task.unreadSteers.push(handed);
    const order = laneOrder(ids);
    try {
      if (images) await session.steer(text, images, order);
      else if (order) await session.steer(text, undefined, order);
      else await session.steer(text);
    } catch (caught) {
      task.inFlightInboxIds = task.inFlightInboxIds.filter((id) => !ids.includes(id));
      task.steeredInboxIds = task.steeredInboxIds.filter((steered) => steered !== ids);
      task.unreadSteers = task.unreadSteers.filter((steer) => steer !== handed);
      throw caught;
    }
  }

  /**
   * The steer's timeline event (R2 forward capture), written once the
   * control plane has decided what happened to it. Bookkeeping never takes
   * a steer down with it.
   */
  private recordSteer(
    taskId: string,
    message: string,
    source: SteerSource,
    outcome: SteerDelivery,
    inboxId: number,
  ): void {
    try {
      this.core.options.tasks.turns.recordSteer(taskId, {
        text: message,
        actor: source.actor,
        outcome,
        via: source.via,
        decision: source.decision,
        cardId: source.cardId,
        inboxId,
        ...(source.panel ? { panel: source.panel } : {}),
        ...(source.words ? { words: source.words } : {}),
      });
    } catch (caught) {
      console.warn("[crew] steer capture failed:", caught);
    }
  }

  /**
   * A line the captain typed in the task card's Crewmate tab
   * (docs/task-card-tabs.md, "Typing"): his steer on the crewmate's own
   * lane, as a reply under its card is, with his words verbatim, and one
   * feed line. Firstmate is not in the loop; it reads the steer on the
   * task's timeline. A task no crewmate can be told anything about refuses
   * in words and writes nothing.
   */
  async steerFromCrewmateTab(taskId: string, words: string): Promise<CrewSendResult> {
    const text = words.trim();
    if (!text) return { ok: false, text: "There is nothing to send." };
    const record = this.core.options.tasks.get(taskId);
    if (!record) return { ok: false, text: "This task is not on the record." };
    if (TaskService.isClosed(record)) {
      return { ok: false, text: "This task is closed, so its crewmate cannot be told anything." };
    }
    if (!this.core.tasks.has(taskId) && !record.sessionFile) {
      return { ok: false, text: "This task's crewmate has not started yet." };
    }
    try {
      await this.steerCrewmate(
        taskId,
        { facts: { kind: "crewmate-tab-line", words: text } },
        "captain",
        {
          via: CREWMATE_TAB_VIA,
        },
      );
    } catch (caught) {
      return { ok: false, text: caught instanceof Error ? caught.message : String(caught) };
    }
    const crewmate = this.core.tasks.get(taskId)?.crewmate ?? record.assignee ?? "the crewmate";
    this.core.options.broadcastEvent({
      type: "firstmate_note",
      text: toldInCrewmateTabLine(crewmate, record.title),
    });
    return { ok: true };
  }

  /**
   * ⌃C or Stop in the task card's Crewmate tab: the captain's interrupt of
   * the crewmate's running turn, on the path Firstmate's interrupt takes;
   * the task stays steerable. With no turn running it refuses in words.
   */
  async interruptFromCrewmateTab(taskId: string): Promise<CrewSendResult> {
    const task = this.core.tasks.get(taskId);
    if (!task || (task.state !== "streaming" && task.state !== "starting")) {
      return { ok: false, text: "Its turn is not running." };
    }
    try {
      await this.core.sessions.interruptCrewmate(taskId, "interrupt", {
        actor: "captain",
        via: CREWMATE_TAB_VIA,
        decision: null,
      });
      return { ok: true };
    } catch (caught) {
      return { ok: false, text: caught instanceof Error ? caught.message : String(caught) };
    }
  }
}

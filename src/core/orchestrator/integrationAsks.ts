import type { IntegrationApprovalChoice } from "@shared/integrations";
import {
  DROPPED_ASK_WHY,
  type ForgeWriteAsk,
  type IntegrationAsk,
  type WriteAsk,
} from "@shared/writeAsk";
import type { IntegrationAskTaken } from "../integrations";
import { TaskService } from "../tasks/taskService";
import type { CardService } from "./cardService";
import type { CrewSupervisorOptions, FirstmateHooks } from "./crewSupervisorOptions";
import type { WriteAnswered } from "./deliveryWakes";
import { forgeApprovalCard } from "./forgeApprovalCard";
import type { WriteAskSent } from "./githubGateway";
import { integrationApprovalCard } from "./integrationApprovalCard";
import type { TypedWake } from "./wakes";

/** What the integration asks reach of the supervisor beyond its options. */
export type IntegrationAsksHost = {
  /** The card stack, where each held call's approval card goes up. */
  readonly cards: CardService;
  /** Queue an operational message for the first mate (`FirstmateHooks.notifyOp`). */
  notifyOp: FirstmateHooks["notifyOp"];
  /** Steer a task's crewmate with the host's own notice (`SUPERVISOR_STEER`). */
  steer: (taskId: string, wake: TypedWake) => Promise<unknown>;
};

/**
 * Integration calls held for the captain (docs/integrations.md): the
 * approval card of a task's call, the first mate's and a panel's, and what
 * came of the first mate's or a panel's call once the captain chose. The
 * crew supervisor composes it and its callers reach it as
 * `CrewSupervisor.integrationAsks`.
 */
export class IntegrationAsks {
  constructor(
    private readonly options: CrewSupervisorOptions,
    private readonly host: IntegrationAsksHost,
  ) {}

  /**
   * The held integration call is presented immediately by its owner, not
   * the agent. A crewmate's ask joins the card of its task already waiting
   * for the same connection, revised in place to list it, or raises its own
   * (INF-2993 piece 2); it answers whether it joined one. The waiting asks
   * the cap dropped to keep it are refused first.
   */
  askIntegration(taskId: string, ask: IntegrationAsk, dropped: readonly WriteAsk[] = []): boolean {
    const task = this.options.tasks.get(taskId);
    if (!task || TaskService.isClosed(task)) return false;
    this.refuseDropped(taskId, dropped);
    const open = waitingIntegrationAsks(task.delivery?.writeAsks).find(
      (kept) =>
        kept.id !== ask.id &&
        kept.connection === ask.connection &&
        kept.card !== undefined &&
        this.host.cards.get(kept.card) !== undefined,
    )?.card;
    const card = open ?? `integration-ask-${ask.id}`;
    this.options.tasks.delivery.listWriteAsk(taskId, ask.id, card);
    this.showAsks(taskId, card, open ? new Set([ask.id]) : undefined);
    return open !== undefined;
  }

  /**
   * An unsafe data reader's kept write where its project lives
   * (docs/agents-reach.md, "An unsafe data reader"): it joins its task's card of
   * waiting writes, revised in place to list it, or raises its own, the way
   * a crewmate's integration ask does. The waiting asks the cap dropped to
   * keep it are refused first.
   */
  askForge(taskId: string, ask: ForgeWriteAsk, dropped: readonly WriteAsk[] = []): boolean {
    const task = this.options.tasks.get(taskId);
    if (!task || TaskService.isClosed(task)) return false;
    this.refuseDropped(taskId, dropped);
    const open = waitingForgeCardAsks(task.delivery?.writeAsks).find(
      (kept) => kept.id !== ask.id && this.host.cards.get(kept.card) !== undefined,
    )?.card;
    const card = open ?? `write-ask-${ask.id}`;
    this.options.tasks.delivery.listWriteAsk(taskId, ask.id, card);
    this.showAsks(taskId, card, open ? new Set([ask.id]) : undefined);
    return open !== undefined;
  }

  /**
   * Draw a crewmate's approval card from the asks of its task still waiting
   * on it: revised in place while one is left, taken down once none is.
   * `joined` names the asks that joined in this revision.
   */
  showAsks(taskId: string, cardId: string, joined?: ReadonlySet<string>): void {
    const task = this.options.tasks.get(taskId);
    const listed = task ? listedOn(task.delivery?.writeAsks, cardId) : [];
    if (!task || TaskService.isClosed(task) || listed.length === 0) {
      this.host.cards.takeDown(cardId, "no-asks-left");
      return;
    }
    const revise = this.host.cards.get(cardId) !== undefined;
    const owner = { id: taskId, title: task.title };
    const options = { id: cardId, ...(joined ? { joined } : {}) };
    // A card lists asks of one kind: each kind joins only its own cards.
    const integration = listed.filter((ask): ask is IntegrationAsk => ask.kind === "integration");
    const forge = listed.filter((ask): ask is ForgeWriteAsk => ask.kind !== "integration");
    this.host.cards.put(
      integration.length > 0
        ? integrationApprovalCard(integration, owner, options)
        : forgeApprovalCard(forge, owner, options),
      revise ? { revise: true } : {},
    );
  }

  /**
   * A waiting ask the cap dropped leaves its card and is refused at once
   * (INF-2993 piece 2): its crewmate hears it never ran.
   */
  private refuseDropped(taskId: string, dropped: readonly WriteAsk[]): void {
    const cards = new Set<string>();
    for (const ask of dropped) {
      const card =
        ask.kind === "integration"
          ? ask.by === undefined
            ? (ask.card ?? `integration-ask-${ask.id}`)
            : undefined
          : ask.card;
      if (card === undefined) continue;
      cards.add(card);
      void this.host
        .steer(taskId, {
          facts: writeAnsweredFacts(ask.id, {
            ok: false,
            ask,
            call: askCall(ask),
            place: ask.place,
            outcome: { kind: "refused", why: DROPPED_ASK_WHY },
          }),
          once: `write-answered:${ask.id}`,
        })
        .catch((caught: unknown) => {
          console.warn("[crew] dropped ask's refusal not delivered:", caught);
        });
    }
    for (const card of cards) this.showAsks(taskId, card);
  }

  /**
   * The first mate's held integration call (INF-1108): it has no task, so
   * its card is a host card with no task, whose own row the host files
   * (`TaskService.capture.fileHostCardTask`, through the card's placement) and keeps
   * the exact call on, the way a crewmate's task keeps its own.
   */
  askIntegrationForFirstmate(ask: IntegrationAsk): string {
    const card = integrationApprovalCard(ask);
    this.host.cards.put(card);
    const row = this.options.tasks.capture.openCardTaskFor(card.id);
    if (!row) {
      this.host.cards.takeDown(card.id, "no-row");
      throw new Error("its approval card has no task row to keep the call on.");
    }
    this.options.tasks.delivery.keepWriteAsk(row.id, ask);
    return card.id;
  }

  /**
   * A panel's held integration call (docs/integrations.md, "Panels"): like
   * the first mate's, a host card with no task whose own row keeps the call.
   * Its card names the panel, and its answer goes back to the panel.
   */
  askIntegrationForPanel(ask: IntegrationAsk): string {
    return this.askIntegrationForFirstmate(ask);
  }

  /**
   * What came of the first mate's held call reaches the first mate once
   * (INF-1108): the row keeps the outcome and a line, and the wake names the
   * ask, so an explicit button choice and a restart still notify it once. A
   * run that threw after the click took the ask is unknown, never retried.
   */
  answerFirstmateAsk(
    rowId: string,
    askId: string,
    taken: IntegrationAskTaken,
    choice: IntegrationApprovalChoice,
  ): void {
    const send = this.options.sendTakenIntegrationAsk;
    if (!send) return;
    const kept = "ask" in taken ? taken.ask : undefined;
    // A panel's call: the panel hears the choice, the first mate nothing.
    const panel = kept?.kind === "integration" && kept.by === "panel";
    if (panel) this.options.panelAskAnswered?.(askId, choice);
    const tell = (sent: WriteAskSent) => {
      if (sent.ask)
        this.options.tasks.note(rowId, writeSentLine(sent), {
          news: false,
          feed: true,
          actor: "host",
        });
      if (panel) return;
      this.host.notifyOp(
        {
          facts: {
            kind: "write-answered",
            to: "firstmate",
            ask: askId,
            call: sent.call,
            place: sent.place,
            outcome: sent.outcome.kind,
            ...(sent.outcome.kind === "unknown" || sent.outcome.kind === "refused"
              ? { why: sent.outcome.why }
              : {}),
            ...(sent.answer !== undefined ? { answer: sent.answer } : {}),
          },
          once: `write-answered:${askId}`,
        },
        "agent",
        rowId,
      );
    };
    void send(rowId, taken, choice)
      .then(tell, (caught: unknown) => {
        const why = caught instanceof Error ? caught.message : String(caught);
        const ask = "ask" in taken ? taken.ask : undefined;
        if (ask)
          this.options.tasks.delivery.recordWriteAskOutcome(rowId, askId, { kind: "unknown", why });
        tell({
          ok: false,
          ...(ask ? { ask } : {}),
          call: ask?.kind === "integration" ? ask.action : "",
          place: ask?.place ?? "",
          outcome: ask ? { kind: "unknown", why } : { kind: "refused", why },
        });
      })
      .catch((caught: unknown) => {
        console.warn("[crew] first mate's integration outcome not delivered:", caught);
      });
  }
}

/** The task's timeline line for a kept write the captain's click took. */
export function writeSentLine(sent: WriteAskSent): string {
  switch (sent.outcome.kind) {
    case "answered":
      return `Sent ${sent.call} to ${sent.place} once, on the captain's click: it answered ${sent.outcome.status}.`;
    case "ran":
      return `Ran ${sent.call} on ${sent.place} once, on the captain's click.`;
    case "unknown":
      return `Sent ${sent.call} to ${sent.place} once, on the captain's click; what came of it is unknown (${sent.outcome.why}). It is never sent again.`;
    default:
      return `The captain's click on ${sent.call} sent nothing: ${sent.outcome.why}`;
  }
}

/** A crewmate's integration asks of a task the captain has not answered, oldest first. */
export function waitingIntegrationAsks(asks: readonly WriteAsk[] | undefined): IntegrationAsk[] {
  return (asks ?? [])
    .filter(
      (ask): ask is IntegrationAsk =>
        ask.kind === "integration" && ask.by === undefined && ask.sentAt === undefined,
    )
    .sort((a, b) => a.at - b.at);
}

/** An unsafe data reader's writes still waiting on the host's approval card, oldest first. */
export function waitingForgeCardAsks(
  asks: readonly WriteAsk[] | undefined,
): (ForgeWriteAsk & { card: string })[] {
  return (asks ?? [])
    .filter(
      (ask): ask is ForgeWriteAsk & { card: string } =>
        ask.kind !== "integration" && ask.card !== undefined && ask.sentAt === undefined,
    )
    .sort((a, b) => a.at - b.at);
}

/**
 * The waiting asks a crewmate's approval card lists, oldest first: those
 * naming it, or, on a card raised before cards listed several, its one ask.
 */
export function listedOn(asks: readonly WriteAsk[] | undefined, cardId: string): WriteAsk[] {
  return [
    ...waitingIntegrationAsks(asks).filter(
      (ask) => (ask.card ?? `integration-ask-${ask.id}`) === cardId,
    ),
    ...waitingForgeCardAsks(asks).filter((ask) => ask.card === cardId),
  ].sort((a, b) => a.at - b.at);
}

/** How a kept ask's call is named on the task's timeline and to its crewmate. */
export function askCall(ask: WriteAsk): string {
  return ask.kind === "integration" ? ask.action : `${ask.method} ${ask.path}`;
}

/** The facts of one `write-answered` steer for a click's outcome on one ask. */
export function writeAnsweredFacts(askId: string, sent: WriteAskSent): WriteAnswered {
  return {
    kind: "write-answered",
    ask: askId,
    call: sent.call,
    place: sent.place,
    outcome: sent.outcome.kind,
    ...(sent.outcome.kind === "answered" ? { status: sent.outcome.status } : {}),
    ...(sent.outcome.kind === "unknown" || sent.outcome.kind === "refused"
      ? { why: sent.outcome.why }
      : {}),
    ...(sent.answer !== undefined ? { answer: sent.answer } : {}),
    ...(sent.allowance ? { allowed: sent.allowance.words } : {}),
  };
}

import type { IntegrationApprovalChoice } from "@shared/integrations";
import type { IntegrationAsk } from "@shared/writeAsk";
import type { IntegrationAskTaken } from "../integrations";
import { TaskService } from "../tasks/taskService";
import type { CardService } from "./cardService";
import type { CrewSupervisorOptions, FirstmateHooks } from "./crewSupervisorOptions";
import type { WriteAskSent } from "./githubGateway";
import { integrationApprovalCard } from "./integrationApprovalCard";

/** What the integration asks reach of the supervisor beyond its options. */
export type IntegrationAsksHost = {
  /** The card stack, where each held call's approval card goes up. */
  readonly cards: CardService;
  /** Queue an operational message for the first mate (`FirstmateHooks.notifyOp`). */
  notifyOp: FirstmateHooks["notifyOp"];
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

  /** The held integration call is presented immediately by its owner, not the agent. */
  askIntegration(taskId: string, ask: IntegrationAsk): void {
    const task = this.options.tasks.get(taskId);
    if (!task || TaskService.isClosed(task)) return;
    this.host.cards.put(integrationApprovalCard(ask, { id: taskId, title: task.title }));
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

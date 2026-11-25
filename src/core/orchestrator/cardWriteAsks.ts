import { type IntegrationApprovalChoice, NOT_ALLOWED_WHY } from "@shared/integrations";
import { allowanceCovers, buildRowChoiceOf, type IntegrationAllowance } from "@shared/writeAsk";
import type { IntegrationAskTaken } from "../integrations";
import { TaskService } from "../tasks/taskService";
import { addressesRowIssue, heldForDontFileWhy } from "./buildRows";
import type { CrewCore } from "./crewCore";
import type { WriteAskSent } from "./githubGateway";
import {
  askCall,
  listedOn,
  waitingIntegrationAsks,
  writeAnsweredFacts,
  writeSentLine,
} from "./integrationAsks";

/**
 * The captain's click on a card that answers a crewmate's held write
 * (docs/integrations.md): a kept write where a project lives, sent once, or
 * every ask an integration approval card lists. `CardActions` composes it.
 */
export class CardWriteAsks {
  constructor(private readonly core: CrewCore) {}

  /** The captain's click on a kept write where a project lives: sent once, its crewmate told once. */
  answerWriteAsk(cardId: string, taskId: string, askId: string): void {
    void this.core.options.sendWriteAsk?.(taskId, askId).then((sent) => {
      const still = this.core.options.tasks.get(taskId);
      if (!still || TaskService.isClosed(still)) return;
      if (sent.ask)
        this.core.options.tasks.note(taskId, writeSentLine(sent), {
          news: false,
          feed: true,
          actor: "host",
        });
      this.tellWriteAnswered(taskId, cardId, [{ id: askId, sent }]);
    });
  }

  /**
   * The captain's click on a crewmate's integration approval card answers
   * every ask it listed (INF-2993 piece 2), oldest first: one the captain
   * unticked is refused in the app's words, the others run once each with the choice.
   * An Allow for the rest of this task also runs the task's other waiting
   * asks inside it. Every ask is taken before the first runs, so none can
   * drop or run twice, and the crewmate hears every outcome in one steer.
   * A reader's Build row is never sent: the click files it as the captain
   * picked on its row (`BuildRows.answer`). A write to an issue whose row
   * the captain marked Don't file on this click is held back, never sent.
   */
  async answerIntegrationCard(
    cardId: string,
    taskId: string,
    askId: string,
    choice: IntegrationApprovalChoice,
    notAllowed: readonly string[],
    answers?: readonly { name: string; values: readonly string[] }[],
  ): Promise<void> {
    const delivery = this.core.options.tasks.delivery;
    const send = this.core.options.sendTakenIntegrationAsk;
    if (!send) return;
    const listed = listedOn(this.core.options.tasks.get(taskId)?.delivery?.writeAsks, cardId);
    const ids = listed.length > 0 ? listed.map((ask) => ask.id) : [askId];
    const outcomes: { id: string; sent: WriteAskSent }[] = [];
    const taken: { id: string; taken: IntegrationAskTaken }[] = [];
    for (const id of ids) {
      const took = delivery.takeWriteAsk(taskId, id);
      if (notAllowed.includes(id) && "ask" in took) {
        const outcome = { kind: "refused" as const, why: NOT_ALLOWED_WHY };
        delivery.recordWriteAskOutcome(taskId, id, outcome);
        const ask = took.ask;
        outcomes.push({
          id,
          sent: { ok: false, ask, call: askCall(ask), place: ask.place, outcome },
        });
      } else taken.push({ id, taken: took });
    }
    // Every row's pick is read before the first write runs, so a reply that
    // comes before its issue's row on the card is held back all the same.
    const skipped = taken.flatMap(({ id, taken: took }) =>
      choice === "once" &&
      "ask" in took &&
      took.ask.kind === "build" &&
      buildRowChoiceOf(answers, id) === "skip"
        ? [took.ask]
        : [],
    );
    const allowances: IntegrationAllowance[] = [];
    const run = async (id: string, took: IntegrationAskTaken, as: IntegrationApprovalChoice) => {
      const build = "ask" in took && took.ask.kind === "build" ? took.ask : undefined;
      const heldFor =
        "ask" in took ? skipped.find((row) => addressesRowIssue(row, took.ask)) : undefined;
      if (heldFor && "ask" in took) {
        const outcome = { kind: "refused" as const, why: heldForDontFileWhy(heldFor.issue) };
        delivery.recordWriteAskOutcome(taskId, id, outcome);
        const ask = took.ask;
        outcomes.push({
          id,
          sent: { ok: false, ask, call: askCall(ask), place: ask.place, outcome },
        });
        return;
      }
      const sending = build
        ? this.core.buildRows.answer(taskId, build, as, buildRowChoiceOf(answers, id))
        : send(taskId, took, as);
      const sent: WriteAskSent = await sending.catch((caught: unknown) => {
        const why = caught instanceof Error ? caught.message : String(caught);
        const ask = "ask" in took ? took.ask : undefined;
        if (ask) delivery.recordWriteAskOutcome(taskId, id, { kind: "unknown", why });
        return {
          ok: false,
          ...(ask ? { ask } : {}),
          call: ask ? askCall(ask) : "",
          place: ask?.place ?? "",
          outcome: ask ? { kind: "unknown" as const, why } : { kind: "refused" as const, why },
        };
      });
      if (sent.allowance) allowances.push(sent.allowance);
      outcomes.push({ id, sent });
    };
    for (const one of taken) await run(one.id, one.taken, choice);
    // The waiting asks of the same task inside a new allowance run on the
    // same click (INF-2993), their cards revised or taken down. An ask
    // whose card its crewmate withdrew no longer waits, so it never runs
    // (INF-3307 audit).
    const covered = waitingIntegrationAsks(
      this.core.options.tasks.get(taskId)?.delivery?.writeAsks,
    ).filter(
      (ask) =>
        this.core.cards.get(ask.card ?? `integration-ask-${ask.id}`) !== undefined &&
        allowances.some((allowance) => allowanceCovers(allowance, ask)),
    );
    const more = covered.map((ask) => ({
      id: ask.id,
      taken: delivery.takeWriteAsk(taskId, ask.id),
    }));
    for (const card of new Set(covered.map((ask) => ask.card ?? `integration-ask-${ask.id}`)))
      this.core.integrationAsks.showAsks(taskId, card);
    for (const one of more) await run(one.id, one.taken, "once");
    const still = this.core.options.tasks.get(taskId);
    if (!still || TaskService.isClosed(still)) return;
    // One line per allowance, however many of the card's asks it covered.
    const named = new Set<string>();
    for (const { sent } of outcomes) {
      if (!sent.ask) continue;
      this.core.options.tasks.note(taskId, writeSentLine(sent), {
        news: false,
        feed: true,
        actor: "host",
      });
      const allowed = sent.allowance && `${sent.allowance.action}\n${sent.allowance.scope}`;
      if (allowed && !named.has(allowed) && sent.allowance && sent.ask.kind === "integration") {
        named.add(allowed);
        this.core.options.tasks.note(
          taskId,
          `The captain allowed ${sent.ask.action} on ${sent.place} for the rest of this task, for ${sent.allowance.words}.`,
          { news: false, feed: true, actor: "host" },
        );
      }
    }
    const order = new Map(
      [...ids, ...covered.map((ask) => ask.id)].map((id, index) => [id, index]),
    );
    outcomes.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    this.tellWriteAnswered(taskId, cardId, outcomes);
  }

  /** One `write-answered` steer naming every outcome of one click, in its card's order. */
  private tellWriteAnswered(
    taskId: string,
    cardId: string,
    outcomes: readonly { id: string; sent: WriteAskSent }[],
  ): void {
    const [first, ...rest] = outcomes;
    if (!first) return;
    void this.core.steer
      .steerCrewmate(
        taskId,
        {
          facts: {
            ...writeAnsweredFacts(first.id, first.sent),
            ...(rest.length > 0
              ? {
                  also: rest.map((one) => {
                    const { kind: _kind, ...facts } = writeAnsweredFacts(one.id, one.sent);
                    return facts;
                  }),
                }
              : {}),
          },
          once: `write-answered:${first.id}`,
        },
        "captain",
        { via: "card", cardId },
      )
      .catch((caught: unknown) => {
        console.warn("[crew] write outcome not delivered:", caught);
      });
  }
}

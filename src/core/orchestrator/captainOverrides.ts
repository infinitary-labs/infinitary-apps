import { anythingElseOf, type Card, mergeEffectOf } from "@shared/cards";
import {
  choiceWords,
  type HoldOverride,
  holdNames,
  mergeClickRefusal,
  type OverridableHold,
  overrideSpan,
  overrideWords,
  STANDING_WORDS_FROM,
  standingOverride,
} from "@shared/holds";
import { CREWMATE_TAB_VIA } from "@shared/provenance";
import { TaskService } from "../tasks/taskService";
import type { CardService } from "./cardService";
import type { TaskRuntime } from "./crewRuntime";
import type { CrewSupervisorOptions } from "./crewSupervisorOptions";
import type { SettleOwners } from "./settleOwners";

/** How an override refused on its words begins, so a caller that cites words for its own record can say it in its own. */
export const OVERRIDE_REFUSED = "Override refused: nothing was recorded.";

/**
 * The captain's own words a first mate tool cites (INF-1216): this turn's
 * (`from` omitted or `turn`), every message of his it carries, however it
 * began; or the words on the task `cite` reads from a card, the Crewmate
 * tab or the standing override. A scheduled check carries none of his
 * words, so it cites none. The host checks only that the words are his.
 */
export function captainWordsIn(
  turn: { canCreate: boolean; asked: readonly string[] },
  from: string | undefined,
  cite: (from: string) => ReturnType<CaptainOverrides["citedCaptainWords"]>,
): ReturnType<CaptainOverrides["citedCaptainWords"]> {
  if (from && from !== "turn") {
    if (!turn.canCreate && turn.asked.length === 0)
      return {
        ok: false,
        text: `${OVERRIDE_REFUSED} A scheduled check records no override, since no words of the captain's arrived with it; the one standing still applies.`,
      };
    return cite(from);
  }
  const words = turn.asked.join("\n").trim();
  return words
    ? { ok: true, words }
    : {
        ok: false,
        text: `${OVERRIDE_REFUSED} Only the captain's own words declare one: this turn's, or their reply or click on a card of the task or line in its Crewmate tab, cited with from.`,
      };
}

/** What the captain's overrides reach of the supervisor beyond its options. */
export type CaptainOverridesHost = {
  now(): number;
  /** The card stack: the cards whose replies and clicks are the captain's words. */
  readonly cards: CardService;
  /** Settling: a kept merge click waiting on a hold the captain's words pass runs now. */
  readonly settling: SettleOwners;
  /** Bring the task's captain gate up to date (`IdleLadder.syncCaptainGate`). */
  syncCaptainGate(taskId: string, at: number): void;
  /** The crewmate running a task here now, if one is. */
  runtime(taskId: string): TaskRuntime | undefined;
  /** Deliver what is due on a task's lane now. */
  sweepTaskLane(taskId: string, now: number): Promise<void>;
};

/**
 * The captain's overrides (docs/delivery-rigor.md, "The holds"): the soft
 * holds the captain's words pass on a task, the words the first mate cites for them,
 * and the notice its crewmate is served when they change.
 */
export class CaptainOverrides {
  constructor(
    private readonly options: Pick<CrewSupervisorOptions, "inbox" | "tasks">,
    private readonly host: CaptainOverridesHost,
  ) {}

  /**
   * update_task override (docs/delivery-rigor.md, "The holds"): the
   * captain's words, which the first mate heard in this turn, pass the soft
   * holds it declares, for this version or the task's life. The host keeps
   * his words as the row's reason and never reads them; it checks only that
   * the task is live, since update_task has already refused a hold the
   * override cannot pass, in that hold's own words (`overrideRefusal`). One
   * override stands at a time: a new one replaces it. Naming a counted limit
   * reopens it now. Words that are his click on a merge (`mergeClick`, from
   * `citedCaptainWords`) are his approval of it, kept until the checks pass,
   * so they never pass the checks (INF-1966), and the record keeps that
   * fact for `standing` to carry.
   */
  declareOverride(
    taskId: string,
    input: {
      words: string;
      holds: OverridableHold[];
      until: "version" | "task";
      mergeClick?: true;
    },
  ): { ok: boolean; text: string } {
    const record = this.options.tasks.get(taskId);
    if (!record) throw new Error(`Unknown task "${taskId}".`);
    const handle = `${record.key || record.id} "${record.title}"`;
    if (TaskService.isClosed(record))
      return { ok: false, text: `${handle} is closed, so no hold is left to pass.` };
    const holds = [...new Set(input.holds)];
    if (holds.length === 0)
      return { ok: false, text: "Name at least one soft hold the captain's words pass." };
    if (input.mergeClick && holds.includes("checks"))
      return { ok: false, text: mergeClickRefusal(input.words) };
    const head = record.delivery?.headSha;
    if (input.until === "version" && !head)
      return {
        ok: false,
        text: `${handle} has no version yet, so an override for this version has nothing to cover. Declare until task if their words mean the whole task.`,
      };
    // The version is a head of the pull request the task names now - its own
    // or a selected one - so the override records which (INF-1884 R2).
    const prNumber = record.delivery?.prNumber;
    const override: HoldOverride = {
      words: input.words,
      holds,
      until: input.until,
      ...(input.until === "version" && head
        ? { head, ...(prNumber !== undefined ? { prNumber } : {}) }
        : {}),
      ...(input.mergeClick ? { mergeClick: true as const } : {}),
      at: this.host.now(),
    };
    this.options.tasks.delivery.recordPermissionRecords(
      taskId,
      { override },
      {
        kind: "note",
        actor: "firstmate",
        feed: true,
        text: overrideWords(override),
        data: { news: true },
      },
    );
    this.overrideNoticed(taskId, override);
    // His kept merge click reads the same record: one waiting on a hold his
    // words pass runs now (a no-op when none stands).
    void this.host.settling.kept.runMergeAuthorization(taskId).catch((caught: unknown) => {
      console.warn("[crew] kept merge could not run:", caught);
    });
    return {
      ok: true,
      text: `Recorded the captain's override on ${handle}: their words pass ${holdNames(holds)} ${overrideSpan(override)}. Every soft hold named reads it, their merge click included; go on as their words asked. override with empty holds takes it back.`,
    };
  }

  /** update_task override with empty holds: the captain takes his override back; a second row says so. */
  withdrawOverride(taskId: string): { ok: boolean; text: string } {
    const record = this.options.tasks.get(taskId);
    if (!record) throw new Error(`Unknown task "${taskId}".`);
    const handle = `${record.key || record.id} "${record.title}"`;
    const override = record.delivery?.override;
    if (!override) return { ok: false, text: `${handle} has no override to take back.` };
    this.options.tasks.delivery.recordPermissionRecords(
      taskId,
      { override: undefined },
      {
        kind: "note",
        actor: "firstmate",
        feed: true,
        text: `You took back your words on ${holdNames(override.holds)}: they hold again.`,
        data: { news: true, overrideWithdrawn: override },
      },
    );
    this.overrideNoticed(taskId, override, true);
    this.host.syncCaptainGate(taskId, this.host.now());
    return {
      ok: true,
      text: `Took back the captain's override on ${handle}: ${holdNames(override.holds)} hold again.`,
    };
  }

  /**
   * The captain's override changed on a task (INF-1216): its crewmate is
   * served his standing words, or that he took them back, on its durable
   * lane, so its next turn reads them on this computer or another. A
   * notice alone starts no turn (`deliverableRows`); a running turn hears
   * it now. Its reviewer reads the override in every review turn's brief.
   */
  overrideNoticed(taskId: string, override: HoldOverride, withdrawn = false): void {
    const record = this.options.tasks.get(taskId);
    if (!record) return;
    this.options.inbox.enqueueSteerOnce(taskId, {
      facts: {
        kind: "task-override-changed",
        task: { id: taskId, key: record.key, title: record.title },
        override: { words: override.words, holds: override.holds, until: override.until },
        ...(withdrawn ? { withdrawn: true as const } : {}),
      },
      once: `task-override:${withdrawn ? "withdrawn" : "standing"}:${override.at}`,
    });
    if (this.host.runtime(taskId)?.state === "streaming")
      void this.host.sweepTaskLane(taskId, this.host.now());
  }

  /**
   * The captain's own words the first mate cites for an override (INF-1216,
   * INF-1582 finding 2): on a card of this task (`from` is the card's id),
   * the newest of his reply in its thread and his click on its button, on
   * the first mate's cards and a crewmate's alike; his newest line in its
   * Crewmate tab (`crewmate-tab`), read from the steer that carried it; or
   * the words of the override standing on it (`standing`), so one sentence
   * names more holds. The host checks only that the words are his and on
   * this task, and reads none of them. `mergeClick` says the words are his
   * click on a merge, a typed fact of the card's action or the standing
   * record, never read from the words (INF-1966).
   */
  citedCaptainWords(
    taskId: string,
    from: string,
  ): { ok: true; words: string; mergeClick?: true } | { ok: false; text: string } {
    const record = this.options.tasks.get(taskId);
    if (!record) throw new Error(`Unknown task "${taskId}".`);
    const handle = record.key || record.id;
    const cited = from.trim();
    if (cited === STANDING_WORDS_FROM) {
      const standing = standingOverride(record.delivery, record.delivery?.headSha);
      return standing
        ? {
            ok: true,
            words: standing.words,
            ...(standing.mergeClick ? { mergeClick: true as const } : {}),
          }
        : {
            ok: false,
            text: `Override refused: nothing was recorded. No override stands on ${handle} at this version, so there are no recorded words of the captain's to name more holds with.`,
          };
    }
    const found = this.typedWords(taskId, cited);
    if (found.ok) {
      const { at: _at, ...words } = found;
      return { ...words, ok: true };
    }
    switch (found.missing) {
      case "tab":
        return {
          ok: false,
          text: `Override refused: nothing was recorded. The record holds no words the captain typed in ${handle}'s Crewmate tab.`,
        };
      case "card":
        return {
          ok: false,
          text: `Override refused: nothing was recorded. There is no card "${cited}"; pass from as the id of the card the captain replied under or clicked, ${CREWMATE_TAB_VIA}, or ${STANDING_WORDS_FROM}.`,
        };
      case "elsewhere":
        return {
          ok: false,
          text: `Override refused: nothing was recorded. Card "${found.card}" is not on ${handle}, so the captain's words there pass nothing on it.`,
        };
      case "silent":
        return {
          ok: false,
          text: `Override refused: nothing was recorded. The record holds no words of the captain's on card "${found.card}": no reply in its thread and no click on its buttons.`,
        };
    }
  }

  /**
   * The captain's words a crewmate's report passes on (INF-3202,
   * docs/card-authoring.md "The You asked line"): his newest words on a
   * card of the crewmate's own task, or his newest line in its Crewmate
   * tab, with when he typed them - read by the same reader an override
   * citation uses. A card on another task, or one holding none of his
   * words, is refused with the fix. The host reads none of the words.
   */
  relayedCaptainWords(
    taskId: string,
    from: string,
  ): { ok: true; words: string; at: number } | { ok: false; text: string } {
    const record = this.options.tasks.get(taskId);
    if (!record) throw new Error(`Unknown task "${taskId}".`);
    const handle = record.key || record.id;
    const cited = from.trim();
    const found = this.typedWords(taskId, cited);
    if (found.ok) return { ok: true, words: found.words, at: found.at };
    const fix = `name the id of your own card the captain replied under or clicked, or ${CREWMATE_TAB_VIA} for a line they typed in your Crewmate tab, or leave captain_words_from out.`;
    switch (found.missing) {
      case "tab":
        return {
          ok: false,
          text: `Report refused: captain_words_from names ${CREWMATE_TAB_VIA}, but the record holds no words the captain typed in ${handle}'s Crewmate tab; ${fix}`,
        };
      case "card":
        return {
          ok: false,
          text: `Report refused: there is no card "${cited}" for captain_words_from; ${fix}`,
        };
      case "elsewhere":
        return {
          ok: false,
          text: `Report refused: card "${found.card}" is not on ${handle}, so captain_words_from cannot name it; ${fix}`,
        };
      case "silent":
        return {
          ok: false,
          text: `Report refused: the record holds no words of the captain's on card "${found.card}" for captain_words_from: no reply in its thread and no click on its buttons; ${fix}`,
        };
    }
  }

  /**
   * The captain's newest words on a card of this task, or in its Crewmate
   * tab (`crewmate-tab`), read from the steer that carried it, with when he
   * typed them; or what is missing.
   */
  private typedWords(
    taskId: string,
    cited: string,
  ):
    | { ok: true; words: string; at: number; mergeClick?: true }
    | { ok: false; missing: "tab" | "card" }
    | { ok: false; missing: "elsewhere" | "silent"; card: string } {
    if (cited === CREWMATE_TAB_VIA) {
      const message = this.options.tasks
        .timeline(taskId)
        .findLast(
          (event) =>
            event.kind === "steered" &&
            event.actor === "captain" &&
            event.data?.via === CREWMATE_TAB_VIA,
        );
      const span = message?.data?.words as { from: number; to: number } | undefined;
      const words = message && span ? message.text.slice(span.from, span.to).trim() : "";
      return message && words ? { ok: true, words, at: message.at } : { ok: false, missing: "tab" };
    }
    const card = this.host.cards.get(cited) ?? this.host.cards.stored(cited);
    if (!card) return { ok: false, missing: "card" };
    if (card.taskId !== taskId) return { ok: false, missing: "elsewhere", card: card.title };
    const words = this.captainWordsOnCard(card);
    return words ? { ok: true, ...words } : { ok: false, missing: "silent", card: card.title };
  }

  /**
   * The captain's newest words on a card: his reply in its thread, or his
   * click on one of its buttons (`choiceWords`), whichever came last. A
   * body's own script choosing is never his click. A click on a merge says
   * so (`clickApprovesMerge`).
   */
  private captainWordsOnCard(
    card: Card,
  ): { words: string; at: number; mergeClick?: true } | undefined {
    const reply = this.host.cards
      .messages(card.id)
      .findLast((message) => message.who === "captain");
    const typed = reply?.text.trim();
    const past = this.host.cards.past(card.id);
    const ending = past?.ending;
    const clicked =
      past && ending?.how === "chose" && ending.by === "captain" && ending.label
        ? {
            at: ending.at,
            words: choiceWords(ending.label, past.title, anythingElseOf(past.answers)),
            ...(this.clickApprovesMerge(card, ending.actionId)
              ? { mergeClick: true as const }
              : {}),
          }
        : undefined;
    if (clicked && (!typed || !reply || clicked.at >= reply.at)) return clicked;
    return typed && reply ? { words: typed, at: reply.at } : undefined;
  }

  /**
   * Whether the captain's click on this action approved a merge (INF-1966):
   * a merge card's merge, whose words the app draws from the checks
   * (`mergeLabel`) for the task's current change - never Merge
   * anyway, which passes the checks itself, nor a merge past the branch
   * rules, whose card names each failed check it skips. Read from the
   * action's declared effect, never from its words.
   */
  private clickApprovesMerge(card: Card, actionId: string | undefined): boolean {
    const action = actionId ? card.actions.find((entry) => entry.id === actionId) : undefined;
    const effect = action ? mergeEffectOf(action) : undefined;
    if (!action || !effect || action.passes) return false;
    if (!effect.review) return true;
    const review = card.taskId
      ? this.options.tasks
          .get(card.taskId)
          ?.delivery?.mergeReviews?.find((item) => item.id === effect.review)
      : undefined;
    return !review?.skips;
  }
}

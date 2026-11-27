import type { DirectionCitation } from "@shared/actions";
import type { CaptainAllowance } from "@shared/captainAllowances";
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
import { type SaidPart, said, saidLine, saidList } from "@shared/i18n/said";
import type { KnowledgeDirectionHeard } from "@shared/knowledge";
import { CREWMATE_TAB_VIA } from "@shared/provenance";
import type { TaskRecord } from "../storage/taskRecords";
import { alreadyAllowed, inheritedOverride, sameWorkLineage } from "../tasks/alreadyAllowed";
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
 * words, so it cites none; `scheduledElse` says what such a check may cite
 * instead, where the tool takes one. The host checks only that the words
 * are his.
 */
export function captainWordsIn(
  turn: { canCreate: boolean; asked: readonly string[] },
  from: string | undefined,
  cite: (from: string) => ReturnType<CaptainOverrides["citedCaptainWords"]>,
  scheduledElse?: string,
): ReturnType<CaptainOverrides["citedCaptainWords"]> {
  if (from && from !== "turn") {
    if (!citesKeptWords(turn))
      return {
        ok: false,
        text: `${OVERRIDE_REFUSED} A scheduled check cites no card, Crewmate tab line or standing words, since none of the captain's words arrived with it; the one standing still applies.${scheduledElse ? ` ${scheduledElse}` : ""}`,
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

/** A direction an override cites, at the revision cited (`HoldOverride.direction`). */
type CitedDirection = NonNullable<HoldOverride["direction"]>;

/**
 * Each hold an override can pass, as the captain reads it on the task's
 * record in their own language (INF-7021); `HOLDS`' names stay the words the
 * crew is served. A kind a later version retired, still on a saved
 * override, reads as a retired hold.
 */
const HOLD_SAID = {
  "asks-first": "taskHoldAsksFirst",
  decisions: "taskHoldDecisions",
  waits: "taskHoldWaits",
  parts: "taskHoldParts",
  checks: "taskHoldChecks",
  proof: "taskHoldProof",
  story: "taskHoldStory",
  "load-line": "taskHoldLoadLine",
  "cost-limit": "taskHoldCostLimit",
} as const satisfies Record<OverridableHold, string>;
const RETIRED_HOLD_SAID = "taskHoldRetired";

/** The holds an override passes, as one list the record words where it is shown. */
function holdsSaid(holds: readonly string[]): SaidPart {
  const named = holds.map((kind) =>
    Object.hasOwn(HOLD_SAID, kind) ? HOLD_SAID[kind as OverridableHold] : RETIRED_HOLD_SAID,
  );
  const [first = RETIRED_HOLD_SAID, ...rest] = [...new Set(named)];
  return saidList([first, ...rest]);
}

/** Why an override citing a direction is refused, after `OVERRIDE_REFUSED`. */
// i18n-exempt: refusals served to the first mate, never shown to a person
const CITED_DIRECTION_WHY = {
  noKnowledge:
    "The standing directions cannot be read here, so no direction can be cited; cite the captain's own words.",
  unreadable: (reason: string) =>
    `The standing directions cannot be read now (${reason}); cite the captain's own words.`,
  noProject: (handle: string) =>
    `${handle} belongs to no project, so no project direction reaches it; cite the captain's own words.`,
  notProject: (id: string, handle: string) =>
    `d:${id} is not a direction of ${handle}'s project: one that applies everywhere, or to another project, passes no hold here. Cite a current direction of its project, or the captain's own words.`,
  missing: (id: string) =>
    `There is no current direction d:${id}: it is unknown or retired. Read your standing directions again, or cite the captain's own words.`,
  unheard: (id: string) =>
    `d:${id}'s current revision was not heard from the captain, so it is no yes and passes no hold. Cite the captain's own words; a revision saved from their words is heard.`,
  captainStands: (handle: string, words: string) =>
    `The captain's own words already stand on ${handle} ("${words}"), and an override citing a direction never replaces them. To name more holds with their words, cite from standing.`,
  changed: (id: string, revision: number) =>
    `d:${id} is no longer at revision ${revision}, the one these words are: it was revised or retired since. Cite it again by its d: id, or the captain's own words.`,
};

/** What else a scheduled check may cite for an override, after its refusal of the captain's words. */
// i18n-exempt: served to the first mate, never shown to a person
export const SCHEDULED_CITES_DIRECTION =
  "A heard direction of the task's project, cited by its d: id, may still record one.";

/** How a direction change refused on its cited words begins. */
// i18n-exempt: a refusal served to the first mate, never shown to a person
export const DIRECTION_REFUSED = "Direction refused: nothing was saved.";
// i18n-exempt: a refusal served to the first mate, never shown to a person
const DIRECTION_CITES = `Cite turn for words the captain typed this turn, a card's id for the captain's reply or click there, or ${CREWMATE_TAB_VIA} or ${STANDING_WORDS_FROM} with task naming the task; or leave from out to save it on your own judgment, not heard.`;

/** Why a direction change's citation is refused, after `DIRECTION_REFUSED`. */
// i18n-exempt: refusals served to the first mate, never shown to a person
const DIRECTION_WHY = {
  taskAlone: `task names a task only beside from. ${DIRECTION_CITES}`,
  noTurnWords: `This turn carries no words of the captain's. ${DIRECTION_CITES}`,
  choiceOnly:
    "This turn carries the captain's choice on a card, not words they typed: cite that card's id as from, so its check reads what they picked.",
  scheduled:
    "A scheduled wake carries no words of the captain's, so it cites none; leave from out to save it on your own judgment, not heard.",
  mergeClick:
    "The captain's click on a merge is consent to that merge, never words about a direction.",
  taskNeeded: (cited: string) => `${cited} names a task's words: give task as its key.`,
  noTask: (ref: string) => `There is no task "${ref}".`,
  noTabWords: (handle: string) =>
    `The record holds no words the captain typed in ${handle}'s Crewmate tab.`,
  noStanding: (handle: string) => `No standing reply of the captain's stands on ${handle}.`,
  standingDirection: (handle: string, id: string) =>
    `The override standing on ${handle} cites direction d:${id}, not words the captain gave on that task; cite where their own words were heard.`,
  noCard: (cited: string) =>
    `There is no card "${cited}"; pass from as the id of the card the captain replied under or clicked.`,
  silentCard: (title: string) =>
    `The record holds no words of the captain's on card "${title}": no reply in its thread and no click on its buttons.`,
  unticked: (title: string, named: string[], id: string | undefined) =>
    named.length > 0
      ? `The captain's click on card "${title}" named ${named.join(", ")}${id ? `, not d:${id}` : ""}; it heard only those.`
      : `The captain's click on card "${title}" ticked no direction, so it heard none.`,
};

/** A card control whose value is a direction's `d:` id: an offer to tick it. */
const OFFERED_DIRECTION = /\bvalue\s*=\s*["']d:[a-z0-9][a-z0-9-]{0,63}["']/i;

function directionRefused(why: string): { ok: false; text: string } {
  return { ok: false, text: `${DIRECTION_REFUSED} ${why}` };
}

/**
 * Where the captain's own words a direction change cites were heard
 * (docs/knowledge.md, "Heard from the captain"), by the rule an override's
 * citation keeps (`captainWordsIn`): words the captain typed this turn, or
 * words the record keeps, which a scheduled wake with none of its own cites
 * none of. A turn that carries only a card choice cites that card, never
 * `turn`: its words are the button's label, and the card's check is what
 * hears only the directions a click ticked. With no citation the change is
 * the first mate's own judgment and saves unheard; a citation the record
 * does not hold is refused, so nothing is saved under a mark it lacks.
 */
export function heardDirection(
  turn: { canCreate: boolean; asked: readonly string[]; typed: boolean },
  change: DirectionCitation & { id?: string },
  overrides: Pick<CaptainOverrides, "directionWords">,
): { ok: true; heard?: KnowledgeDirectionHeard } | { ok: false; text: string } {
  const from = change.from?.trim();
  if (!from) return change.task ? directionRefused(DIRECTION_WHY.taskAlone) : { ok: true };
  if (from === "turn") {
    if (turn.typed && turn.asked.join("\n").trim()) return { ok: true, heard: { from: "turn" } };
    return directionRefused(
      turn.asked.length > 0 ? DIRECTION_WHY.choiceOnly : DIRECTION_WHY.noTurnWords,
    );
  }
  if (!citesKeptWords(turn)) return directionRefused(DIRECTION_WHY.scheduled);
  return overrides.directionWords(from, change.task, change.id);
}

/** A scheduled wake with no words of the captain's own cites none the record keeps. */
function citesKeptWords(turn: { canCreate: boolean; asked: readonly string[] }): boolean {
  return turn.canCreate || turn.asked.length > 0;
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
    private readonly options: Pick<CrewSupervisorOptions, "inbox" | "tasks" | "knowledge">,
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
   * so they never create a general override. The scoped merge approval
   * and its repair carry remain the only permission that click gives.
   * Words that are a direction's (`direction`, from `citedDirection`)
   * stand only while it does (`directionsChanged`), and never replace an
   * override from the captain's own words, which replaces theirs (INF-7021).
   */
  declareOverride(
    taskId: string,
    input: {
      words: string;
      holds: OverridableHold[];
      until: "version" | "task";
      mergeClick?: true;
      direction?: CitedDirection;
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
    if (input.mergeClick) return { ok: false, text: mergeClickRefusal(input.words) };
    const head = record.delivery?.headSha;
    const standing = standingOverride(record.delivery, head);
    if (input.direction && standing && !standing.direction)
      return {
        ok: false,
        text: `${OVERRIDE_REFUSED} ${CITED_DIRECTION_WHY.captainStands(handle, standing.words)}`,
      };
    // Words carried through `standing` may rest on a revision that changed
    // since, such as a closed parent's, which the change hook never reached.
    if (input.direction && !this.directionStands(input.direction))
      return {
        ok: false,
        text: `${OVERRIDE_REFUSED} ${CITED_DIRECTION_WHY.changed(input.direction.id, input.direction.revision)}`,
      };
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
        ? { head, ...(prNumber !== undefined ? { prNumber, prUrl: record.delivery?.prUrl } : {}) }
        : {}),
      ...(input.direction ? { direction: input.direction } : {}),
      at: this.host.now(),
    };
    const line = input.direction
      ? saidLine(
          said(
            override.until === "task"
              ? "taskOverrideDirectionTask"
              : "taskOverrideDirectionVersion",
            { direction: input.direction.id, holds: holdsSaid(holds), words: override.words },
          ),
        )
      : undefined;
    this.options.tasks.delivery.recordPermissionRecords(
      taskId,
      { override },
      {
        kind: "note",
        actor: "firstmate",
        feed: true,
        text: line?.text ?? overrideWords(override),
        data: { news: true, ...(line ? { said: line.said, feedLine: true } : {}) },
      },
    );
    this.overrideNoticed(taskId, override);
    // His kept merge click reads the same record: one waiting on a hold his
    // words pass runs now (a no-op when none stands).
    void this.host.settling.kept.runMergeAuthorization(taskId).catch((caught: unknown) => {
      console.warn("[crew] kept merge could not run:", caught);
    });
    if (input.direction)
      return {
        ok: true,
        // i18n-exempt: an answer served to the first mate, never shown to a person
        text: `Recorded an override on ${handle} from the captain's direction d:${input.direction.id} (revision ${input.direction.revision}): it passes ${holdNames(holds)} ${overrideSpan(override)} while that revision stands; the host ends it when the direction is revised or retired. The captain's own words stand over it: words of theirs you record replace it, and it never replaces theirs. Every soft hold named reads it; go on as the direction asks. override with empty holds takes it back.`,
      };
    return {
      ok: true,
      text: `Recorded the captain's override on ${handle}: their words pass ${holdNames(holds)} ${overrideSpan(override)}. Every soft hold named reads it, their merge click included; go on as their words asked. override with empty holds takes it back.`,
    };
  }

  /**
   * The captain's standing direction an override cites by its `d:` id
   * (INF-7021): a current direction of the task's project whose current
   * revision is the captain's own, heard from their words - the yes
   * `keptYeses` counts. Its words are the direction's text, kept with its
   * id and revision so the override ends when it changes
   * (`directionsChanged`). Any turn may cite one, a scheduled check
   * included, since the record keeps the words as it keeps a card's.
   */
  citedDirection(
    taskId: string,
    from: string,
  ): { ok: true; words: string; direction: CitedDirection } | { ok: false; text: string } {
    const record = this.options.tasks.get(taskId);
    if (!record) throw new Error(`Unknown task "${taskId}".`);
    const handle = record.key || record.id;
    const id = from.trim().replace(/^d:/, "");
    const refused = (why: string) => ({ ok: false as const, text: `${OVERRIDE_REFUSED} ${why}` });
    const directions = this.options.knowledge?.directions;
    if (!directions) return refused(CITED_DIRECTION_WHY.noKnowledge);
    if (!record.repoId) return refused(CITED_DIRECTION_WHY.noProject(handle));
    const all = directions.revisions();
    if (!(all instanceof Map)) return refused(CITED_DIRECTION_WHY.unreadable(all.reason));
    const known = all.get(id);
    if (!known || known.retired) return refused(CITED_DIRECTION_WHY.missing(id));
    // The directions this task's crew is served are the ones it may cite.
    const row = directions
      .standing({ kind: "crewmate", taskId, repoId: record.repoId })
      .find((entry) => entry.id === id);
    if (!row) return refused(CITED_DIRECTION_WHY.notProject(id, handle));
    if (row.origin !== "captain-turn" || !row.heard)
      return refused(CITED_DIRECTION_WHY.unheard(id));
    return { ok: true, words: row.text, direction: { id: row.id, revision: row.revision } };
  }

  /**
   * End each standing override that cites a direction no longer at the
   * revision it cited (INF-7021): the direction was revised, retired or
   * removed. It runs on the knowledge collection's change hook, and once
   * at start for a change made while the app was closed. A collection that
   * cannot be read ends nothing, since it cannot say the direction changed.
   */
  directionsChanged(): void {
    const directions = this.options.knowledge?.directions;
    if (!directions) return;
    // A live part reads the override of a task it is part of, even a closed
    // one (`inheritedOverride`), so those are ended too.
    const reached = new Map<string, TaskRecord>();
    for (const live of this.options.tasks.listLive())
      for (
        let record: TaskRecord | undefined = live;
        record && !reached.has(record.id);
        record = record.parentId ? this.options.tasks.get(record.parentId) : undefined
      )
        reached.set(record.id, record);
    const resting = [...reached.values()].flatMap((record) => {
      const override = standingOverride(record.delivery, record.delivery?.headSha);
      return override?.direction ? [{ record, override, cited: override.direction }] : [];
    });
    if (resting.length === 0) return;
    const current = directions.revisions();
    if (!(current instanceof Map)) return;
    for (const { record, override, cited } of resting) {
      const now = current.get(cited.id);
      if (now && !now.retired && now.revision === cited.revision) continue;
      const line = saidLine(
        said(now && !now.retired ? "taskOverrideDirectionRevised" : "taskOverrideDirectionGone", {
          direction: cited.id,
          holds: holdsSaid(override.holds),
        }),
      );
      this.options.tasks.delivery.recordPermissionRecords(
        record.id,
        { override: undefined },
        {
          kind: "note",
          actor: "host",
          feed: true,
          text: line.text,
          data: {
            news: true,
            said: line.said,
            feedLine: true,
            overrideWithdrawn: override,
            directionChanged: cited.id,
          },
        },
      );
      this.overrideNoticed(record.id, override, "direction-changed");
      this.host.syncCaptainGate(record.id, this.host.now());
    }
  }

  /** Whether the direction an override cites is still current at the revision it cites. */
  private directionStands(cited: CitedDirection): boolean {
    const current = this.options.knowledge?.directions.revisions();
    const now = current instanceof Map ? current.get(cited.id) : undefined;
    return now !== undefined && !now.retired && now.revision === cited.revision;
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
    this.overrideNoticed(taskId, override, "taken-back");
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
  overrideNoticed(
    taskId: string,
    override: HoldOverride,
    ended?: "taken-back" | "direction-changed",
  ): void {
    const record = this.options.tasks.get(taskId);
    if (!record) return;
    this.options.inbox.enqueueSteerOnce(taskId, {
      facts: {
        kind: "task-override-changed",
        task: { id: taskId, key: record.key, title: record.title },
        override: {
          words: override.words,
          holds: override.holds,
          until: override.until,
          ...(override.direction ? { direction: override.direction } : {}),
        },
        ...(ended ? { withdrawn: true as const } : {}),
        ...(ended === "direction-changed" ? { directionChanged: true as const } : {}),
      },
      once: `task-override:${ended ? "withdrawn" : "standing"}:${override.at}`,
    });
    if (this.host.runtime(taskId)?.turn.running)
      void this.host.sweepTaskLane(taskId, this.host.now());
  }

  /**
   * What the captain already allowed on a task changed (INF-3170 piece 2):
   * a yes was recorded from their click, `takenBack` on their words, or the
   * task now carries on earlier work (a `replaced-by` link). Every crewmate
   * holding work whose lineage includes the task - the task itself, a
   * stronger-model retry or a takeover of it - is served its whole list on
   * its durable lane, as the override's notice is: it starts no turn, and a
   * running turn hears it now. A task not yet started reads it in its
   * brief, and a reviewer in every review turn's brief. A link that brings
   * no yes sends nothing.
   */
  allowedNoticed(taskId: string, takenBack?: CaptainAllowance): void {
    const tasks = this.options.tasks;
    for (const record of tasks.listActive()) {
      if (!sameWorkLineage(tasks, record).some((task) => task.id === taskId)) continue;
      const allowed = alreadyAllowed(tasks, record);
      if (!takenBack && allowed.allowances.length === 0) continue;
      const newest = allowed.allowances.at(-1)?.at ?? 0;
      this.options.inbox.enqueueSteerOnce(record.id, {
        facts: {
          kind: "task-allowed-changed",
          task: { id: record.id, key: record.key, title: record.title },
          allowed,
          ...(takenBack ? { takenBack: { words: takenBack.words, covers: takenBack.covers } } : {}),
        },
        once: takenBack
          ? `task-allowed:taken:${takenBack.card}:${takenBack.at}`
          : `task-allowed:given:${newest}:${allowed.allowances.length}`,
      });
      if (this.host.runtime(record.id)?.turn.running)
        void this.host.sweepTaskLane(record.id, this.host.now());
    }
  }

  /**
   * update_task take_back_yes (INF-3170 piece 2): the captain's words,
   * heard by the first mate, take back the yes they gave on that card - on
   * the task itself or on a task whose work it does again, where the yes is
   * kept.
   */
  withdrawAllowance(taskId: string, card: string): { ok: boolean; text: string } {
    const record = this.options.tasks.get(taskId);
    if (!record) throw new Error(`Unknown task "${taskId}".`);
    const handle = `${record.key || record.id} "${record.title}"`;
    const holder = sameWorkLineage(this.options.tasks, record).find((task) =>
      task.delivery?.captainAllowances?.some((entry) => entry.card === card.trim()),
    );
    const taken = holder
      ? this.options.tasks.delivery.withdrawAllowance(holder.id, card.trim())
      : undefined;
    if (!holder || !taken)
      return {
        ok: false,
        text: `${handle} has no yes recorded from card "${card.trim()}". Its crew facts list each yes with the card it was given on.`,
      };
    this.allowedNoticed(holder.id, taken);
    return {
      ok: true,
      text: `Took back the captain's yes on ${handle}: "${taken.words}". Its crewmate asks again before anything it covered.`,
    };
  }

  /**
   * The captain's own words the first mate cites for an override (INF-1216,
   * INF-1582 finding 2): on a card of this task (`from` is the card's id),
   * the newest of his reply in its thread and his click on its button, on
   * the first mate's cards and a crewmate's alike; his newest line in its
   * Crewmate tab (`crewmate-tab`), read from the steer that carried it; or
   * the words of the override standing on it (`standing`), so one sentence
   * names more holds. With `partOf`, which only the override passes, a part
   * also cites his words on a card of a task it is part of, or that task's
   * standing override, a merge click there staying one (INF-1939 friction
   * 5). The host checks only that the words are his and on this task, or
   * one it is part of, and reads none of them. `mergeClick` says the words are his
   * click on a merge, a typed fact of the card's action or the standing
   * record, never read from the words (INF-1966).
   */
  citedCaptainWords(
    taskId: string,
    from: string,
    reach: { partOf?: boolean } = {},
  ):
    | { ok: true; words: string; mergeClick?: true; direction?: CitedDirection }
    | { ok: false; text: string } {
    const record = this.options.tasks.get(taskId);
    if (!record) throw new Error(`Unknown task "${taskId}".`);
    const handle = record.key || record.id;
    const cited = from.trim();
    if (cited === STANDING_WORDS_FROM) {
      const standing = standingOverride(record.delivery, record.delivery?.headSha);
      // Words a direction's override stands on keep citing it, so the new
      // override ends with that direction too (INF-7021).
      if (standing)
        return {
          ok: true,
          words: standing.words,
          ...(standing.mergeClick ? { mergeClick: true as const } : {}),
          ...(standing.direction ? { direction: standing.direction } : {}),
        };
      // A part may carry the override on a task it is part of where the
      // captain's words cover it (INF-1939 friction 5): the first mate
      // records them on it. A merge click there stays one, so it is refused.
      const inherited = reach.partOf ? inheritedOverride(this.options.tasks, record) : undefined;
      return inherited
        ? {
            ok: true,
            words: inherited.override.words,
            ...(inherited.override.mergeClick ? { mergeClick: true as const } : {}),
            ...(inherited.override.direction ? { direction: inherited.override.direction } : {}),
          }
        : {
            ok: false,
            text: `Override refused: nothing was recorded. No override stands on ${handle} at this version, so there are no recorded words of the captain's to name more holds with.`,
          };
    }
    let found = this.typedWords(taskId, cited);
    if (!found.ok && found.missing === "elsewhere" && reach.partOf) {
      // His words on a card of a task this one is part of reach it too; a
      // click on that task's merge stays one, so the caller refuses it.
      const owner = (this.host.cards.get(cited) ?? this.host.cards.stored(cited))?.taskId;
      if (owner && this.options.tasks.graph.ancestors(taskId).some((task) => task.id === owner)) {
        const onOwner = this.typedWords(owner, cited);
        if (onOwner.ok) found = onOwner;
      }
    }
    if (found.ok) {
      const { at: _at, line: _line, ...words } = found;
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
   * Where the captain's words a direction change cites are kept
   * (`heardDirection`): the captain's newest words on any card, the newest
   * line typed in a task's Crewmate tab, or a task's standing reply. A click
   * on a merge is consent to that merge, never words about a direction. A
   * click on a card that offers directions as controls valued by `d:` id,
   * or whose answers name them so, heard only the ones its answers name, so
   * a direction left unticked is refused, and every one when none is ticked
   * (INF-6987: each one the captain ticks is confirmed). The host reads
   * none of the words.
   */
  directionWords(
    cited: string,
    taskRef: string | undefined,
    id: string | undefined,
  ): { ok: true; heard: KnowledgeDirectionHeard } | { ok: false; text: string } {
    if (cited === CREWMATE_TAB_VIA || cited === STANDING_WORDS_FROM) {
      if (!taskRef) return directionRefused(DIRECTION_WHY.taskNeeded(cited));
      const record = this.options.tasks.resolve(taskRef);
      if (!record) return directionRefused(DIRECTION_WHY.noTask(taskRef));
      const handle = record.key || record.id;
      if (cited === CREWMATE_TAB_VIA)
        return this.typedWords(record.id, CREWMATE_TAB_VIA).ok
          ? { ok: true, heard: { from: "crewmate-tab", task: handle } }
          : directionRefused(DIRECTION_WHY.noTabWords(handle));
      const standing = standingOverride(record.delivery, record.delivery?.headSha);
      if (!standing) return directionRefused(DIRECTION_WHY.noStanding(handle));
      if (standing.mergeClick) return directionRefused(DIRECTION_WHY.mergeClick);
      // A direction's own words never hear a direction change, or a
      // direction could confirm itself.
      if (standing.direction)
        return directionRefused(DIRECTION_WHY.standingDirection(handle, standing.direction.id));
      return { ok: true, heard: { from: "standing", task: handle } };
    }
    const card = this.host.cards.get(cited) ?? this.host.cards.stored(cited);
    if (!card) return directionRefused(DIRECTION_WHY.noCard(cited));
    const words = this.captainWordsOnCard(card);
    if (!words) return directionRefused(DIRECTION_WHY.silentCard(card.title));
    if (words.mergeClick) return directionRefused(DIRECTION_WHY.mergeClick);
    if (words.line === undefined) {
      const named = (this.host.cards.past(card.id)?.answers ?? [])
        .filter((answer) => !answer.skipped)
        .flatMap((answer) => answer.values)
        .filter((value) => value.startsWith("d:"));
      const bare = id?.replace(/^d:/, "");
      const asked = named.length > 0 || OFFERED_DIRECTION.test(card.body ?? "");
      if (asked && !(bare && named.includes(`d:${bare}`)))
        return directionRefused(DIRECTION_WHY.unticked(card.title, named, bare));
    }
    // The mark keeps at most 400 characters of the title, as its schema reads it back.
    return { ok: true, heard: { from: "card", card: card.id, title: card.title.slice(0, 400) } };
  }

  /**
   * The captain's words a crewmate's report passes on (INF-3202,
   * docs/card-authoring.md "The You asked line"): his newest words on a
   * card of the crewmate's own task, or his newest line in its Crewmate
   * tab, with when he typed them and, for a reply, the line's number in the
   * card's thread (INF-6115 piece 3) - read by the same reader an override
   * citation uses. A card on another task, or one holding none of his
   * words, is refused with the fix. The host reads none of the words.
   */
  relayedCaptainWords(
    taskId: string,
    from: string,
  ): { ok: true; words: string; at: number; line?: number } | { ok: false; text: string } {
    const record = this.options.tasks.get(taskId);
    if (!record) throw new Error(`Unknown task "${taskId}".`);
    const handle = record.key || record.id;
    const cited = from.trim();
    const found = this.typedWords(taskId, cited);
    if (found.ok)
      return {
        ok: true,
        words: found.words,
        at: found.at,
        ...(found.line !== undefined ? { line: found.line } : {}),
      };
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
    | { ok: true; words: string; at: number; line?: number; mergeClick?: true }
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
  ): { words: string; at: number; line?: number; mergeClick?: true } | undefined {
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
    return typed && reply ? { words: typed, at: reply.at, line: reply.id } : undefined;
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

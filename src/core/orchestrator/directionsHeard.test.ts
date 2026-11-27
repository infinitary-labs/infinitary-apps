/**
 * Where a standing direction was heard from the captain (INF-6987's approved
 * plan, piece P; docs/knowledge.md, "Heard from the captain"): each revision
 * records whether the captain's own words for it were heard and from where,
 * only a heard current revision is a yes, and the directions saved before
 * these marks are confirmed once, on one card (the captain's pick: "Confirm
 * today's directions once, on one card"). Each case drives the first mate's
 * own app_change with the real card stack and Crewmate tab, and reads the
 * saved direction back from Knowledge.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CREWMATE_TAB_VIA } from "@shared/provenance";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import {
  bindDirections,
  fakeClockEachTest,
  notifyProse,
  setup,
  tick,
  toolsOf,
} from "../../../tests/helpers/firstmateHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { KnowledgeService } from "../knowledge/knowledgeService";
import { openInMemoryDatabase } from "../storage/db";
import { InboxStore } from "../storage/inboxStore";
import { keptYeses } from "../tasks/alreadyAllowed";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { DIRECTION_REFUSED } from "./captainOverrides";
import { askToConfirmDirections, DIRECTIONS_TO_CONFIRM_ONCE } from "./directionsToConfirm";

fakeClockEachTest();

type Harness = ReturnType<typeof setup>;

/** The first mate's app_change on the direction line, answering its text. */
async function direction(h: Harness, value: Record<string, unknown>, evidence: string) {
  const result = await toolsOf(h.specs)
    .get("app_change")
    ?.execute(`direction-${String(value.id ?? value.text)}`, {
      action: "direction",
      value,
      evidence,
    });
  return result?.content[0]?.text ?? "";
}

function readDirection(knowledge: KnowledgeService, id: string) {
  const read = knowledge.directions.read({ id });
  if (read.state !== "ready") throw new Error(`No direction ${id}: ${read.state}`);
  return read.direction;
}

/** The directions still waiting for the captain's confirmation, by id. */
function unmarkedIds(knowledge: KnowledgeService): string[] {
  const rows = knowledge.directions.unmarked();
  if (!Array.isArray(rows)) throw new Error(`Knowledge is unavailable: ${rows.reason}`);
  return rows.map((row) => row.id).sort();
}

function card(h: Harness, title: string, body = "<p>Shall I keep this as a rule?</p>") {
  return h.supervisor.addFirstmateCard({
    title,
    body,
    actions: [
      { id: "keep", label: "Keep it", default: true },
      { id: "skip", label: "Not now" },
    ],
  });
}

describe("where the captain's words for a direction were heard", () => {
  it("marks each revision heard where its cited words are: this turn, a card and a task's Crewmate tab", async () => {
    const h = setup({
      silent: true,
      seedTasks: [
        {
          id: "t-journeys",
          title: "Run the journeys",
          status: "idle",
          sessionFile: "/tmp/t-j.jsonl",
        },
      ],
    });
    const knowledge = h.knowledge as KnowledgeService;
    bindDirections(h.agent, knowledge);
    const key = h.tasks.get("t-journeys")?.key ?? "t-journeys";
    expect(
      (
        await h.supervisor.steer.steerFromCrewmateTab(
          "t-journeys",
          "From now on run every journey before a merge.",
        )
      ).ok,
    ).toBe(true);
    await h.agent.converse("From now on, squash-merge every pull request.");
    const releases = card(h, "Ask before each release?");
    h.supervisor.cardActions.replyToCard(releases, "Yes, ask me before every release.");
    await tick();

    expect(
      await direction(
        h,
        { op: "add", id: "squash", text: "Squash-merge every pull request.", from: "turn" },
        "The captain said it in this turn.",
      ),
    ).not.toContain(DIRECTION_REFUSED);
    await direction(
      h,
      { op: "add", id: "releases", text: "Ask before every release.", from: releases },
      "The captain replied on the card.",
    );
    await direction(
      h,
      {
        op: "add",
        id: "journeys",
        text: "Run every journey before a merge.",
        from: CREWMATE_TAB_VIA,
        task: key,
      },
      "The captain typed it in the task's Crewmate tab.",
    );

    expect(readDirection(knowledge, "squash")).toMatchObject({
      heard: { from: "turn" },
      history: [{ revision: 1, heard: { from: "turn" } }],
    });
    expect(readDirection(knowledge, "releases")).toMatchObject({
      heard: { from: "card", card: releases, title: "Ask before each release?" },
      history: [{ heard: { from: "card", card: releases } }],
    });
    expect(readDirection(knowledge, "journeys")).toMatchObject({
      heard: { from: "crewmate-tab", task: key },
    });
  });

  it("refuses a citation the record does not hold, and saves nothing", async () => {
    const h = setup({
      silent: true,
      seedTasks: [
        { id: "t-quiet", title: "A quiet task", status: "idle", sessionFile: "/tmp/t-q.jsonl" },
      ],
    });
    const knowledge = h.knowledge as KnowledgeService;
    bindDirections(h.agent, knowledge);
    const key = h.tasks.get("t-quiet")?.key ?? "t-quiet";
    const silent = card(h, "Keep the rule?");
    await h.agent.converse("hello");
    const attempts = [
      [{ from: "card-nope" }, `${DIRECTION_REFUSED} There is no card "card-nope"`],
      [
        { from: silent },
        `${DIRECTION_REFUSED} The record holds no words of the captain's on card "Keep the rule?"`,
      ],
      [
        { from: CREWMATE_TAB_VIA, task: key },
        `${DIRECTION_REFUSED} The record holds no words the captain typed in ${key}'s Crewmate tab.`,
      ],
      [{ from: CREWMATE_TAB_VIA }, `${DIRECTION_REFUSED} crewmate-tab names a task's words`],
      [{ task: key }, `${DIRECTION_REFUSED} task names a task only beside from.`],
    ] as const;
    for (const [citation, refusal] of attempts) {
      expect(
        await direction(
          h,
          { op: "add", id: "kept-rule", text: "Keep the rule.", ...citation },
          "Cited words that are not there.",
        ),
      ).toContain(refusal);
      expect(knowledge.directions.read({ id: "kept-rule" })).toEqual({ state: "missing" });
    }
  });

  it("saves a scheduled wake's change unheard, and refuses its citations", async () => {
    const h = setup({ silent: true });
    const knowledge = h.knowledge as KnowledgeService;
    bindDirections(h.agent, knowledge);
    await h.agent.converse("hello");
    const replied = card(h, "Keep the review rule?");
    h.supervisor.cardActions.replyToCard(replied, "Keep it.");
    notifyProse(h.db, h.agent, "scheduled: review directions", "scheduled");
    // Each turn ends in turn until the scheduled check's own turn runs.
    for (let turns = 0; !h.session.prompts.at(-1)?.includes("review directions"); turns++) {
      if (turns > 4) throw new Error("The scheduled check never ran.");
      h.session.emitTurnEnd("done");
      h.session.resolveNextPrompt();
      await tick();
    }
    const rule = "Review every direction once a week.";
    expect(
      await direction(
        h,
        { op: "add", id: "weekly", text: rule },
        "The first mate's own judgment on a scheduled check.",
      ),
    ).not.toContain(DIRECTION_REFUSED);
    const saved = readDirection(knowledge, "weekly");
    expect(saved.heard).toBeUndefined();
    expect(saved.history[0]?.heard).toBeUndefined();
    for (const from of [replied, "turn"])
      expect(
        await direction(
          h,
          { op: "revise", id: "d:weekly", text: `${rule} Ask first.`, from },
          "Claimed words on a scheduled check.",
        ),
      ).toContain(DIRECTION_REFUSED);
    expect(readDirection(knowledge, "weekly")).toMatchObject({ revision: 1, text: rule });
  });
});

describe("only a heard current revision is a yes", () => {
  const HARBOR = { id: "repo-harbor", name: "harbor", path: "/projects/harbor" };

  it("hears a later revision only from its own citation, and lists only heard ones as kept yeses", () => {
    const knowledge = new KnowledgeService({
      projects: { get: (id) => (id === HARBOR.id ? HARBOR : undefined), list: () => [HARBOR] },
    });
    const tasks = new TaskService({ db: openInMemoryDatabase(), strict: true });
    seedTask(tasks, { id: "t-check", title: "Check harbor", status: "running", repoId: HARBOR.id });
    const record = tasks.get("t-check");
    if (!record) throw new Error("No task.");
    const yeses = () =>
      keptYeses(tasks, record, undefined, knowledge.directions).map((y) => y.card);
    knowledge.directions.change({
      op: "add",
      id: "staging",
      scope: HARBOR.id,
      text: "Run the staging check without asking.",
      reason: "The captain said so.",
      heard: { from: "turn" },
    });
    knowledge.directions.change({
      op: "add",
      id: "own-judgment",
      scope: HARBOR.id,
      text: "Run the slow check without asking.",
      reason: "The first mate's reading of an earlier choice.",
    });
    expect(yeses()).toEqual(["d:staging"]);
    knowledge.directions.change({
      op: "revise",
      id: "d:staging",
      expectedRevision: 1,
      text: "Run the staging and slow checks without asking.",
      reason: "The first mate widened it on its own judgment.",
    });
    const staging = knowledge.directions.read({ id: "staging" });
    expect(staging.state === "ready" && staging.direction.heard).toBeUndefined();
    expect(
      staging.state === "ready" &&
        staging.direction.history.map(({ revision, heard }) => ({ revision, heard })),
    ).toEqual([
      { revision: 2, heard: undefined },
      { revision: 1, heard: { from: "turn" } },
    ]);
    expect(yeses()).toEqual([]);
  });
});

describe("confirming the directions saved before heard marks", () => {
  /**
   * A home whose directions an earlier build saved: its knowledge
   * collection is at schema 4, before `direction_heard`, so the update
   * opens them with no mark.
   */
  function olderHome(texts: Record<string, string>): KnowledgeService {
    const dir = join(scratchDir("infinitary-heard-"), "knowledge");
    mkdirSync(dir, { recursive: true });
    const projects = { get: () => undefined, list: () => [] };
    const earlier = new KnowledgeService({ dir, projects });
    for (const [id, text] of Object.entries(texts))
      earlier.directions.change({ op: "add", id, scope: "captain", text, reason: "Kept." });
    earlier.close();
    const db = new Database(join(dir, "knowledge.db"));
    db.exec("DROP TABLE direction_heard; DELETE FROM schema_migrations WHERE version = 5;");
    db.close();
    return new KnowledgeService({ dir, projects });
  }

  it("asks once, ever, and hears each ticked direction from that card", async () => {
    const knowledge = olderHome({
      mornings: "Plan reviews for the morning.",
      squash: "Squash-merge every pull request.",
      quiet: "Never post to the team channel.",
    });
    expect(unmarkedIds(knowledge)).toEqual(["mornings", "quiet", "squash"]);
    const h = setup({ silent: true, knowledge: false });
    bindDirections(h.agent, knowledge);
    askToConfirmDirections({
      knowledge,
      inbox: new InboxStore(h.db),
      notify: (wake) => h.agent.notifyOp(wake, "agent"),
    });
    await tick();
    expect(h.session.prompts).toHaveLength(1);
    for (const id of ["d:mornings", "d:squash", "d:quiet"])
      expect(h.session.prompts[0]).toContain(id);
    expect(h.session.prompts[0]).toContain("Raise one card now listing each");
    // The next start finds the ask already made.
    const again = vi.fn();
    askToConfirmDirections({ knowledge, inbox: new InboxStore(h.db), notify: again });
    expect(again).not.toHaveBeenCalled();
    h.session.emitTurnEnd("Asked.");
    h.session.resolveNextPrompt();
    await tick();

    const box = (id: string) =>
      `<label><input type="checkbox" name="directions" value="d:${id}"> ${id}</label>`;
    const confirm = h.supervisor.addFirstmateCard({
      title: "Which of these directions are yours?",
      body: `<fieldset><legend>Directions</legend>${["mornings", "squash", "quiet"].map(box).join("")}</fieldset>`,
      actions: [{ id: "confirm", label: "Confirm the ticked ones", default: true }],
    });
    h.supervisor.cardActions.act(confirm, "confirm", "chrome", {
      answers: [
        {
          name: "directions",
          values: ["d:mornings", "d:squash"],
          labels: ["mornings", "squash"],
          changed: true,
        },
      ],
    });
    await tick();
    const confirmFrom = (id: string, text: string) =>
      direction(
        h,
        { op: "revise", id: `d:${id}`, expectedRevision: 1, text, from: confirm },
        "The captain ticked it on the confirm card.",
      );
    await confirmFrom("mornings", "Plan reviews for the morning.");
    await confirmFrom("squash", "Squash-merge every pull request.");
    expect(await confirmFrom("quiet", "Never post to the team channel.")).toContain(
      `${DIRECTION_REFUSED} The captain's click on card "Which of these directions are yours?" named d:mornings, d:squash, not d:quiet; it heard only those.`,
    );
    // The click turn's only words are its button's label, so citing this
    // turn cannot hear a direction the click left unticked.
    expect(
      await direction(
        h,
        {
          op: "revise",
          id: "d:quiet",
          expectedRevision: 1,
          text: "Never post to the team channel.",
          from: "turn",
        },
        "The captain clicked Confirm the ticked ones.",
      ),
    ).toContain(
      `${DIRECTION_REFUSED} This turn carries the captain's choice on a card, not words they typed: cite that card's id as from`,
    );
    for (const id of ["mornings", "squash"])
      expect(readDirection(knowledge, id)).toMatchObject({
        revision: 2,
        heard: { from: "card", card: confirm },
      });
    expect(readDirection(knowledge, "quiet")).toMatchObject({ revision: 1 });
    expect(unmarkedIds(knowledge)).toEqual(["quiet"]);
    h.session.emitTurnEnd("Confirmed two.");
    h.session.resolveNextPrompt();
    await tick();

    // A click that ticks none hears none of the directions it offered.
    const none = h.supervisor.addFirstmateCard({
      title: "Is this one yours?",
      body: `<fieldset><legend>Directions</legend>${box("quiet")}</fieldset>`,
      actions: [{ id: "confirm", label: "Confirm the ticked ones", default: true }],
    });
    h.supervisor.cardActions.act(none, "confirm", "chrome", {
      answers: [{ name: "directions", values: [], changed: false }],
    });
    await tick();
    expect(
      await direction(
        h,
        {
          op: "revise",
          id: "d:quiet",
          expectedRevision: 1,
          text: "Never post to the team channel.",
          from: none,
        },
        "The captain clicked without ticking it.",
      ),
    ).toContain(
      `${DIRECTION_REFUSED} The captain's click on card "Is this one yours?" ticked no direction, so it heard none.`,
    );
    expect(readDirection(knowledge, "quiet")).toMatchObject({ revision: 1 });
  });

  it("asks nothing on a home whose directions all carry marks, and records the ask as made", () => {
    const knowledge = new KnowledgeService({
      projects: { get: () => undefined, list: () => [] },
    });
    knowledge.directions.change({
      op: "add",
      id: "mornings",
      scope: "captain",
      text: "Plan reviews for the morning.",
      reason: "The first mate's own judgment, saved by this build.",
    });
    const inbox = new InboxStore(openInMemoryDatabase());
    const notify = vi.fn();
    askToConfirmDirections({ knowledge, inbox, notify });
    expect(notify).not.toHaveBeenCalled();
    expect(inbox.woken("", DIRECTIONS_TO_CONFIRM_ONCE)).toBe(true);
  });
});

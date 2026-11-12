import { firstmatePauseCard } from "@core/orchestrator/hostCards";
import { openInMemoryDatabase } from "@core/storage/db";
import { condenseActivity } from "@core/tasks/recordActivity";
import { seedTask } from "@core/tasks/seedTask";
import { TaskService } from "@core/tasks/taskService";
import { TaskTimeline } from "@core/tasks/taskTimeline";
import type { Card, PastCard } from "@shared/cards";
import { HERE } from "@shared/deviceNames";
import {
  type DeviceUpdateNudgeFacts,
  deviceUpdateActions,
  deviceUpdateBody,
  deviceUpdateCardId,
  deviceUpdateMeta,
  deviceUpdateTitle,
} from "@shared/deviceUpdateNudge";
import { type FeedLine, feedLineFrom } from "@shared/feed";
import { plainProblem } from "@shared/plainProblem";
import { runsOnSaid } from "@shared/repos";
import type { TaskDetail, TaskEventView } from "@shared/tasks";
import type { TimelineReading } from "@shared/timeline";

/**
 * The first mate's own words, as its core writes them, for a computer that
 * controls it to name its computer in (docs/view.md, "The first mate's own
 * words"): its feed lines and refusals, its own cards, and a task's record,
 * beside the captain's words and a crewmate's, which stay as written.
 */

/** A card on the stage, before the fields a card below sets. */
function stageCard(id: string): Card {
  return {
    id,
    author: "firstmate",
    priority: 15,
    title: id,
    meta: "firstmate",
    body: "<p>First line.</p>",
    actions: [],
    status: "ready",
    createdAt: 1,
  };
}

/**
 * What the first mate's core says of its own computer (INF-3486), written
 * with `here` where it says this computer: a feed line it marks as its own
 * words, a refusal in each shape a refusal takes, and a refused request.
 */
export function ownWords(here: string) {
  return {
    note: `Your saved sign-in was not used for "Sign up on the harbour site": No sign-in for harbour.example is saved on ${here}. Its browser is still paused for you.`,
    openPage: `This task runs on another computer, so its project's page does not open on ${here}.`,
    reopen: `Four task browsers are already open on ${here}. Stop one, then open this again.`,
    stop: `${here === HERE.this ? HERE.This : here} keeps no task browsers.`,
  };
}
export const SAID = ownWords(HERE.this);
/** The captain's own turn, which says this computer in the captain's words. */
export const CAPTAIN = captainLine(`Keep the harbour site on ${HERE.this}.`);
/** A project's move back to the first mate's computer, which says it and here as places (INF-3676). */
export const RUNS_HERE = runsOnSaid("harbour-site", null, true);

/** A computer on an older Infinitary, whose update card the first mate's computer writes itself. */
const OLDER: DeviceUpdateNudgeFacts = {
  deviceId: "old-studio",
  name: "Mac Studio",
  other: { app: "0.7.0-alpha.503", than: "older", takesWork: false, updateBy: "connection" },
  homeApp: "0.7.1-alpha.557",
};
/** The cards the first mate's computer wrote itself, and a crewmate's that says this computer too. */
export function ownCards(): Card[] {
  const body = deviceUpdateBody(OLDER);
  return [
    {
      ...stageCard(deviceUpdateCardId(OLDER.deviceId)),
      author: "host",
      title: deviceUpdateTitle(OLDER),
      meta: deviceUpdateMeta(OLDER),
      body,
      actions: deviceUpdateActions(OLDER),
      // Its second paragraph is new since the captain last saw it.
      changes: { at: 2, added: 1, removed: 0, rewritten: false, marks: [body.indexOf("<p>", 1)] },
    },
    {
      ...firstmatePauseCard("card-fm-no-headroom", {
        pause: "client",
        providerName: "Claude",
        body: "<p>Claude Code stopped answering.</p>",
      }),
      createdAt: 1,
    },
    {
      ...stageCard("card-soundings"),
      author: "crewmate",
      taskId: "harbour",
      body: `<p>Checked the soundings on ${HERE.this}.</p>`,
    },
  ];
}
/** The update card once its card is gone from the stage, as the record shows it. */
export function pastUpdateCard(): PastCard {
  const [card] = ownCards();
  if (!card) throw new Error("No update card");
  return {
    id: card.id,
    author: card.author,
    title: card.title,
    meta: card.meta,
    body: card.body,
    actions: card.actions.map(({ effect: _effect, ...action }) => action),
    ending: { how: "dismissed", at: 3 },
    answers: [],
    messages: [],
  };
}

/** A task's record as the first mate's core reads it: its own words, a crewmate's and the captain's. */
export function ownRecord(): Pick<TaskDetail, "activityLog" | "timeline" | "problem"> {
  let id = 0;
  const event = (
    kind: TaskEventView["kind"],
    text: string,
    data: Record<string, unknown> | null,
    actor: TaskEventView["actor"] = "host",
  ): TaskEventView => ({
    id: ++id,
    at: id * 1000,
    actor,
    kind,
    text,
    data,
    ref: null,
    feed: false,
  });
  const page = "https://github.com/o/harbour-site/pull/612";
  return {
    activityLog: condenseActivity(
      [
        event("pr_opened", "opened #612", { prNumber: 612, changeLabel: "#612", prUrl: page }),
        event("note", SAID.note, { news: true }),
        event("note", `${HERE.This} could not reach #612 where the project lives.`, {
          news: true,
        }),
        event("progress", `Checked the soundings on ${HERE.this}.`, null, "crewmate"),
        event("ask", CAPTAIN.text, null, "captain"),
      ],
      (model) => model,
    ),
    timeline: ownTimeline(),
    problem: plainProblem("spawn git ENOENT"),
  };
}

/**
 * The timeline readings the record's Activity draws, from the first mate's
 * own reader: the brief it served, quoting the captain; its own note; and a
 * crewmate's line.
 */
export function ownTimeline(): TimelineReading[] {
  const db = openInMemoryDatabase();
  let at = 0;
  const tasks = new TaskService({ db, strict: true, now: () => (at += 1000) });
  seedTask(tasks, { id: "harbour", title: "Chart the harbour", status: "queued" });
  tasks.recordBrief("harbour", [`Goal: The soundings run on ${HERE.this}.`]);
  tasks.note("harbour", `No sign-in for harbour.example is saved on ${HERE.this}.`, {
    news: true,
  });
  tasks.noteProgress("harbour", `Checked the soundings on ${HERE.this}.`);
  const readings = new TaskTimeline({ tasks }).history("harbour");
  db.close();
  return readings;
}

/** The feed line of the captain's own turn, as the core draws it. */
function captainLine(text: string): Omit<FeedLine, "at"> {
  const line = feedLineFrom({ type: "user_turn", text });
  if (!line) throw new Error("The captain's turn draws no feed line.");
  return line;
}

/** A core's answer in its own words to a request that has one, or undefined. */
export function answerInOwnWords(channel: string): unknown {
  if (channel === "inf:feed:recent")
    return [
      { kind: "info", text: SAID.note, at: 1, taskKey: "HAR-1", event: "note", saidHere: true },
      { ...CAPTAIN, at: 2 },
    ] satisfies FeedLine[];
  if (channel === "inf:tasks:detail") return ownRecord();
  if (channel === "inf:cards:list") return ownCards();
  if (channel === "inf:cards:show") return ownCards()[0];
  if (channel === "inf:cards:show-past") return pastUpdateCard();
  if (channel === "inf:cards:open-page") return { refusal: SAID.openPage };
  if (channel === "inf:browser:reopen") return { ok: false, text: SAID.reopen };
  if (channel === "inf:browser:stop") throw new Error(SAID.stop);
  return undefined;
}

/** The reads that carry a task's record and the cards the first mate's computer wrote itself. */
export const OWN_READS = [
  ["inf:tasks:detail", ["harbour"]],
  ["inf:cards:list", []],
  ["inf:cards:show", ["card-device-update"]],
  ["inf:cards:show-past", ["card-device-update"]],
] as const;

import type { Core } from "@core/index";
import { seedTask } from "@core/tasks/seedTask";
import { BOARD_DELTA_TRIGGER } from "@shared/tasks";

/** What the test home lends the catch-up check's steps: its board task numbers, its away cards and its wait. */
export type CatchUpHome = {
  nextBoardTask: () => number;
  awayCards: string[];
  until: (predicate: () => boolean) => Promise<void>;
};

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "null");

/**
 * The test home's `catch-up-board` (INF-6817 piece 2, `PhoneCatchUpTests`): a returning phone replays what it
 * missed only while the replay weighs no more than its reload, whose board is the light board it last read
 * (docs/connection.md, "Catching up"). Below the delta trigger every board change goes out as the whole board, and a
 * replay carries the newest one, so it always outweighs the light board; on a short record `away-traffic`'s two whole
 * card lists outweigh it too. Opens tasks until the board is past the trigger, so each change goes out as a delta, and
 * the light board outweighs the traffic, sized from the card list now since other checks' cards stay on this home;
 * `closeCatchUpBoard` closes them, so a later check's light board again holds only its own open work; the closed rows
 * keep the whole board past the trigger, and its pushes deltas, for the rest of that home.
 */
export async function openCatchUpBoard(core: Core, opened: string[]) {
  const target = 4 * bytes(await core.dispatch("inf:cards:list", [])) + 64_000;
  const light = async () => bytes(await core.dispatch("inf:tasks:board", [{ closed: false }]));
  const rows = async () => (await core.dispatch("inf:tasks:board", [])).tasks.length;
  while ((await rows()) <= BOARD_DELTA_TRIGGER.rows || (await light()) < target)
    for (let i = 0; i < 25; i++)
      opened.push(
        seedTask(core.services.tasks, {
          id: `phone-catch-up-board-${opened.length + 1}`,
          title: `Log the harbour's tide marks and moorings for the season, page ${opened.length + 1}`,
          status: "queued",
          startPolicy: "on-request",
        }).id,
      );
  return { tasks: opened.length, rows: await rows(), lightBytes: await light(), target };
}

export function closeCatchUpBoard(core: Core, opened: string[]): void {
  for (const id of opened.splice(0))
    core.services.tasks.close(id, { status: "done", reason: "finished", actor: "host" });
}

/**
 * The test home's `away-traffic` (INF-2773): what a phone misses while away, replayed at its return: board updates,
 * cards and a reaction. The board and the cards each go out on their own short timer, so each change waits for its
 * own push: six board updates and two card lists, never one coalesced update, and none the phone reads live.
 */
export async function awayTraffic(core: Core, home: CatchUpHome) {
  const pushed = new Set<string>();
  const cardsPushed = new Set<string>();
  const stopWatching = core.events.subscribe((channel, payload) => {
    const rows =
      channel === "inf:tasks:delta"
        ? (payload as { upserts: { id: string }[] }).upserts
        : channel === "inf:tasks"
          ? (payload as { tasks: { id: string }[] }).tasks
          : [];
    for (const row of rows) pushed.add(row.id);
    if (channel === "inf:cards")
      for (const card of payload as { id: string }[]) cardsPushed.add(card.id);
  });
  const ids: string[] = [];
  const cards: string[] = [];
  try {
    for (let i = 0; i < 6; i++) {
      const n = home.nextBoardTask();
      const id = seedTask(core.services.tasks, {
        id: `phone-board-${n}`,
        title: `Chart the harbour's ${n}th mooring`,
        status: "queued",
        startPolicy: "on-request",
      }).id;
      ids.push(id);
      await home.until(() => pushed.has(id));
    }
    for (const [n, title] of ["The pilot boat came in", "The tide turned"].entries()) {
      const card = core.services.supervisor.addFirstmateCard({
        id: `phone-away-${n}`,
        title,
        body: `<p>${title} while you were away.</p>`,
        actions: [],
      });
      cards.push(card);
      home.awayCards.push(card);
      await home.until(() => cardsPushed.has(card));
    }
  } finally {
    stopWatching();
  }
  core.events.emit("inf:event", { type: "firstmate_emote", emote: "salute" });
  return { ids, cards };
}

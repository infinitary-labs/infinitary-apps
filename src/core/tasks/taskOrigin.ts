import type { AskRecord } from "../storage/askStore";
import type { TaskEvent } from "../storage/taskEventStore";
import type { TaskRecord } from "../storage/taskStore";

/**
 * Where a task's work began, when it was not a message of the captain's
 * (INF-2326, docs/card-authoring.md "The You asked line"). The first mate's
 * tools save one when they file or start a task while answering one of
 * these, at that moment: an automation keeps the name it had when it ran,
 * since a one-time automation leaves Settings once it has run and runs are
 * kept only 30 days; a click keeps the button's words and what the captain
 * wrote with it; a crewmate's report keeps the task that reported, whose own
 * origin the line then reads, and the captain's words the report passed on
 * with when he typed them on that task, when its crewmate named where
 * (INF-3202).
 */
export type SavedOrigin =
  | { kind: "automation"; ruleId: string; name?: string }
  | { kind: "chose"; cardId: string; card: string; choice: string; written?: string }
  | { kind: "report"; taskId: string; words?: { text: string; at: number } };

/** The `note` event a saved origin rides: its data's one key. */
export const ORIGIN_NOTE_KEY = "origin";

/** The saved origin's timeline line. */
export function originNoteText(origin: SavedOrigin, reporter?: string): string {
  switch (origin.kind) {
    case "automation":
      return origin.name
        ? `Filed while answering the automation "${origin.name}"`
        : "Filed while answering an automation";
    case "chose":
      return `Filed from your choice "${origin.choice}" on "${origin.card}"`;
    case "report":
      return `Filed after ${reporter ?? "a crewmate"}'s report${origin.words ? ", which passed on your words" : ""}`;
  }
}

/** A saved origin read back from its note's data, or undefined for any other note. */
export function savedOriginOf(event: TaskEvent): SavedOrigin | undefined {
  if (event.kind !== "note") return undefined;
  const origin = event.data?.[ORIGIN_NOTE_KEY] as Partial<SavedOrigin> | undefined;
  if (!origin || typeof origin !== "object") return undefined;
  if (origin.kind === "automation" && typeof origin.ruleId === "string")
    return origin as SavedOrigin;
  if (origin.kind === "chose" && typeof origin.choice === "string") return origin as SavedOrigin;
  if (origin.kind === "report" && typeof origin.taskId === "string") {
    const words = origin.words;
    return {
      kind: "report",
      taskId: origin.taskId,
      ...(words && typeof words.text === "string" && typeof words.at === "number"
        ? { words: { text: words.text, at: words.at } }
        : {}),
    };
  }
  return undefined;
}

/**
 * What a card's line says about where its work came from, nearest first
 * (INF-2326): the captain's message that filed or started the work (`asked`),
 * an automation that filed it, a card click it was filed from (`chose`), else
 * a steer or question of theirs aimed at that work alone (`said`), else the
 * nearest task it came from (`from`). `through` counts the tasks between the
 * card's task and the one the source sits on.
 */
export type TaskOriginLine =
  | { kind: "asked" | "said"; at: number; text: string; through: number }
  | { kind: "chose"; at: number; choice: string; card: string; text: string; through: number }
  | { kind: "automation"; at: number; name: string; through: number }
  | { kind: "from"; at: number; key: string; title: string };

/** The facts the walk reads, each a typed read the task service already owns. */
export type OriginReader = {
  get(id: string): TaskRecord | undefined;
  /** The tasks whose work this one took over: the task it replaced, retried or branched from. */
  handedOver(id: string): string[];
  /** Its plan: the task its basis names. */
  basis(id: string): string | undefined;
  /** The tasks it follows up: those it was discovered from. */
  followsUp(id: string): string[];
  /** Its `ask` and `note` events, oldest first. */
  events(id: string): TaskEvent[];
  ask(id: string): AskRecord | undefined;
  /** How many tasks this message attached to. */
  askReach(askId: string): number;
};

/** The tools whose effect on a task is never where its work came from. */
const NEVER_QUOTED = new Set(["tool:settle_task", "tool:interrupt_crewmate"]);

/**
 * Whether an `ask` event filed or started its task. A newer event says so
 * itself (`starts`); an event saved before it did counts when the tool that
 * attached it files or starts work, or when it was the message's first task
 * and attached by a card the first mate raised for it or the host's fallback.
 */
function startedBy(event: TaskEvent): boolean {
  const data = event.data ?? {};
  if (typeof data.starts === "boolean") return data.starts;
  const via = data.via;
  if (via === "tool:spawn_crewmate" || via === "tool:create_task") return true;
  return data.first === true && (via === "tool:emit_card" || via === "host:fallback");
}

type Found =
  | { kind: "asked"; at: number; ask: AskRecord }
  | { kind: "relayed"; text: string; at: number }
  | { kind: "saved"; at: number; origin: SavedOrigin };

/**
 * A task's own origin: the oldest message that filed or started it, or the
 * oldest origin saved on it, whichever came first. A report origin is a
 * route, not a source: the walk follows it to the reporting task. One that
 * keeps the captain's words its report passed on is a source: those words,
 * typed on the reporting task (INF-3202).
 */
function ownOrigin(reader: OriginReader, id: string): Found | undefined {
  for (const event of reader.events(id)) {
    if (event.kind === "ask" && event.ref && startedBy(event)) {
      const ask = reader.ask(event.ref);
      if (ask) return { kind: "asked", at: ask.at, ask };
    }
    const saved = savedOriginOf(event);
    if (saved?.kind === "report" && saved.words)
      return { kind: "relayed", text: saved.words.text, at: saved.words.at };
    if (saved && saved.kind !== "report") return { kind: "saved", at: event.at, origin: saved };
  }
  return undefined;
}

/** The oldest message on a task aimed at it alone, never one that only settled or interrupted it. */
function ownSaying(reader: OriginReader, id: string): AskRecord | undefined {
  for (const event of reader.events(id)) {
    if (event.kind !== "ask" || !event.ref) continue;
    if (NEVER_QUOTED.has(String(event.data?.via ?? ""))) continue;
    if (reader.askReach(event.ref) > 1) continue;
    const ask = reader.ask(event.ref);
    if (ask) return ask;
  }
  return undefined;
}

/** The tasks a task's work came from, in the order the walk tries them. */
function sources(reader: OriginReader, id: string): string[] {
  const record = reader.get(id);
  const reports = reader.events(id).flatMap((event) => {
    const saved = savedOriginOf(event);
    return saved?.kind === "report" ? [saved.taskId] : [];
  });
  return [
    ...reader.handedOver(id),
    ...(record?.parentId ? [record.parentId] : []),
    ...[reader.basis(id)].filter((next): next is string => !!next),
    ...reader.followsUp(id),
    ...reports,
  ];
}

/**
 * The line for a card on task `id`: one walk outward from it, nearest first
 * (each task before any task one step further away), through the work it
 * took over, its parent, its plan and the task it follows up. The first
 * origin wins; with none anywhere, the nearest message aimed at one task
 * alone; with nothing of the captain's, the nearest task it came from.
 * Work handed over is tried before the task's own origin, so a replacement's
 * own message about the move never takes the first message's place.
 */
export function originAbout(reader: OriginReader, id: string): TaskOriginLine | undefined {
  if (!reader.get(id)) return undefined;
  const order: { id: string; through: number }[] = [];
  const seen = new Set<string>([id]);
  // Handed-over work sits at the same distance, ahead of the task itself.
  const place = (next: string, through: number): void => {
    for (const from of reader.handedOver(next)) {
      if (seen.has(from) || !reader.get(from)) continue;
      seen.add(from);
      place(from, through + 1);
    }
    order.push({ id: next, through });
  };
  place(id, 0);
  for (let index = 0; index < order.length; index += 1) {
    const at = order[index] as { id: string; through: number };
    for (const next of sources(reader, at.id)) {
      if (seen.has(next) || !reader.get(next)) continue;
      seen.add(next);
      place(next, at.through + 1);
    }
  }
  for (const { id: taskId, through } of order) {
    const found = ownOrigin(reader, taskId);
    if (!found) continue;
    if (found.kind === "asked")
      return { kind: "asked", at: found.ask.at, text: found.ask.text, through };
    // The words sit on the reporting task, one further back.
    if (found.kind === "relayed")
      return { kind: "asked", at: found.at, text: found.text, through: through + 1 };
    const origin = found.origin;
    if (origin.kind === "automation")
      return { kind: "automation", at: found.at, name: origin.name ?? "", through };
    if (origin.kind === "chose")
      return {
        kind: "chose",
        at: found.at,
        choice: origin.choice,
        card: typeof origin.card === "string" ? origin.card : "",
        text: origin.written ?? "",
        through,
      };
  }
  for (const { id: taskId, through } of order) {
    const ask = ownSaying(reader, taskId);
    if (ask) return { kind: "said", at: ask.at, text: ask.text, through };
  }
  const nearest = order.find((entry) => entry.through > 0);
  const task = nearest && reader.get(nearest.id);
  return task
    ? { kind: "from", at: task.createdAt, key: task.key || task.id, title: task.title }
    : undefined;
}

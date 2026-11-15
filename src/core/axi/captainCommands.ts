import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { ANYTHING_ELSE_ANSWER, type CardAnswer, type TaskLifecycleOp } from "@shared/cards";
import { NOW_GROUP_LABELS, type NowGroup, nowGroupOf } from "@shared/nowPanel";
import { dropReviewKeys } from "@shared/recordDrop";
import { foldForSearch } from "@shared/searchText";
import type { DropEffects } from "@shared/tasks";
import { cutText } from "@shared/textCut";
import { encode } from "@toon-format/toon";
import { AxiError } from "axi-sdk-js";
import { INBOX_COMMAND, INFINITARY_COMMAND } from "../integrations/commandWords";
import type { AxiArguments, AxiCommand, TaskAxiCli } from "./cli";
import type { CaptainOp, CaptainOpInput, CaptainReply, InboxOp, InboxOpInput } from "./protocol";

/**
 * `infinitary-axi`, Infinitary from your terminal (docs/axi-commands.md,
 * "Infinitary from your terminal"; INF-1894 from INF-1893's agreed design,
 * the captain's picks: nouns with verbs as gh-axi, the raw verb `api`, the
 * six daily nouns with automation and knowledge, and setup as a thin skill
 * that points an agent at the command). Every verb asks the app as the
 * captain; a change - your words to the first mate, a card's button, a
 * task's own buttons, or `api` on a change - is recorded as yours from the
 * command (INF-1895). `note` and `receipts` are the inbox's, kept word for
 * word.
 *
 * It follows the captain's AXI principles: TOON on stdout, three or four
 * fields a row with `--fields` for others, long words cut with `--full`,
 * whole counts, an empty list that says so, errors on stdout with exit 1
 * for a refusal and 2 for a malformed ask, the bare command showing what
 * waits on you, and `help` lines naming the next complete commands.
 */

/** The app as this command reaches it: each operation, answered for the captain. */
export type CaptainConnection = {
  call: <Op extends CaptainOp | InboxOp>(
    command: string,
    op: Op,
    input: Op extends CaptainOp
      ? CaptainOpInput[Op]
      : Op extends InboxOp
        ? InboxOpInput[Op]
        : never,
  ) => Promise<CaptainReply>;
};

const C = INFINITARY_COMMAND;

const DESCRIPTION = "Infinitary from your terminal, as you: your cards, your tasks and your crew.";

/** Rows a list prints unless `--limit` asks for others. */
const ROWS = 50;
/** Characters of a body or report a show prints unless `--full` asks for all of it. */
const CUT = 1000;

function invalid(message: string, help: string[] = []): never {
  throw new AxiError(message, "VALIDATION_ERROR", help);
}

/** The answer's rows, or its refusal as an error with exit 1 or 2. */
function answerOf(reply: CaptainReply): Record<string, unknown> {
  if (reply.kind !== "answer")
    throw new AxiError("Infinitary is still answering an earlier command; run this again", "BUSY");
  const { answer } = reply;
  if (answer.refused)
    throw new AxiError(
      answer.text ?? "Refused.",
      answer.refused === "invalid" ? "VALIDATION_ERROR" : "REFUSED",
    );
  return answer.data ?? {};
}

/**
 * One request as the captain, through the app's own request: a read, or a
 * change the app records as yours from this command.
 */
async function read<T = unknown>(
  connection: CaptainConnection,
  command: string,
  channel: string,
  args: unknown[] = [],
): Promise<T> {
  const data = answerOf(await connection.call(command, "captain.request", { channel, args }));
  return data.value as T;
}

function words(text: string | null | undefined, full: boolean): Record<string, unknown> {
  const all = (text ?? "").trim();
  if (full || all.length <= CUT) return { text: all };
  return {
    text: `${cutText(all, CUT)}... (${all.length - CUT} more characters)`,
    chars: all.length,
  };
}

/** A card or report body's HTML as plain words: no markup, scripts, styles or drawings. */
export function plainWords(html: string): string {
  return html
    .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/li|\/h\d|\/tr|\/div|\/summary|\/legend|\/figcaption)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n[\s]*/g, "\n")
    .trim();
}

/** The questions a card's body asks: each field's name, kind and options. */
export function questionsOf(html: string): { name: string; kind: string; options: string }[] {
  const found = new Map<string, { kind: string; options: string[] }>();
  for (const match of html.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
    const [, tag = "", attributes = ""] = match;
    const name = /\bname="([^"]*)"/i.exec(attributes)?.[1];
    if (!name) continue;
    const type = /\btype="([^"]*)"/i.exec(attributes)?.[1]?.toLowerCase();
    if (type === "hidden" || type === "submit" || type === "button") continue;
    const kind = tag.toLowerCase() === "input" ? (type ?? "text") : tag.toLowerCase();
    const entry = found.get(name) ?? { kind, options: [] };
    const value = /\bvalue="([^"]*)"/i.exec(attributes)?.[1];
    if ((kind === "radio" || kind === "checkbox") && value !== undefined) entry.options.push(value);
    found.set(name, entry);
  }
  for (const match of html.matchAll(/<select\b[^>]*\bname="([^"]*)"[^>]*>([\s\S]*?)<\/select>/gi)) {
    const entry = found.get(match[1] ?? "");
    if (!entry) continue;
    for (const option of (match[2] ?? "").matchAll(/<option\b[^>]*\bvalue="([^"]+)"/gi))
      entry.options.push(option[1] ?? "");
  }
  return [...found].map(([name, { kind, options }]) => ({
    name,
    kind,
    options: options.join("|"),
  }));
}

/** Rows cut to `--limit` and `--fields`, with a whole count beside them. */
function listed(
  name: string,
  all: Record<string, unknown>[],
  fields: string[],
  args: AxiArguments,
  empty: string,
): Record<string, unknown> {
  const limitRaw = args.flags["--limit"];
  const limit = typeof limitRaw === "string" ? Number(limitRaw) : ROWS;
  if (!Number.isInteger(limit) || limit < 1)
    invalid("--limit takes a whole number of rows, 1 or more");
  const asked = typeof args.flags["--fields"] === "string" ? args.flags["--fields"].split(",") : [];
  const known = new Set(all.flatMap((row) => Object.keys(row)));
  for (const field of asked)
    if (all.length > 0 && !known.has(field))
      invalid(`No field ${field} on these rows`, [`Fields: ${[...known].join(", ")}`]);
  const shown = asked.length > 0 ? asked : fields;
  const rows = all
    .slice(0, limit)
    .map((row) => Object.fromEntries(shown.map((field) => [field, row[field] ?? ""])));
  return {
    [name]: rows,
    count: all.length === 0 ? empty : `${rows.length} of ${all.length}`,
  };
}

/** What a command prints: TOON, or JSON with `--json`, with its next commands. */
function printed(args: AxiArguments, data: Record<string, unknown>, help: string[]): string {
  if (args.flags["--json"]) return `${JSON.stringify(data, null, 2)}\n`;
  return `${encode(data)}${help.length > 0 ? `\n${encode({ help })}` : ""}\n`;
}

const LIST_FLAGS = {
  "--limit": "value",
  "--fields": "value",
  "--json": "switch",
} as const;
const SHOW_FLAGS = { "--full": "switch", "--json": "switch" } as const;

type CardRow = {
  id: string;
  taskId: string;
  author: string;
  title: string;
  meta: string;
  body: string;
  createdAt?: number;
  actions?: { id: string; label: string; default?: boolean }[];
  replies?: number;
  offerId?: string;
};

type TaskRow = Parameters<typeof nowGroupOf>[0] & {
  id: string;
  key: string;
  projectId: string;
  title: string;
  goal: string | null;
  status: string;
  activity: string | null;
  outcomeSummary?: string;
  blockedBy?: string[];
};

type Board = {
  at: number;
  projects: { id: string; key: string; name: string }[];
  tasks: TaskRow[];
};

type CrewLine = { kind: string; at: number; text?: string; name?: string; target?: string };

/** A task's id from its key: the board's rows, then the older ones search reaches. */
async function taskIdOf(connection: CaptainConnection, key: string): Promise<string> {
  const board = await boardOf(connection, "task");
  const wanted = key.toUpperCase();
  const found =
    board.tasks.find((one) => one.key.toUpperCase() === wanted) ??
    (await read<TaskRow[]>(connection, "task", "inf:tasks:search", [key])).find(
      (one) => one.key.toUpperCase() === wanted,
    );
  if (!found) throw new AxiError(`No task ${key}`, "REFUSED", [`${C} task search <words>`]);
  return found.id;
}

/** A lane as the command names it: the board's, with done for done this week. */
type Lane = "waiting" | "working" | "queued" | "backlog" | "done";
const LANES: readonly Lane[] = ["waiting", "working", "queued", "backlog", "done"];

function laneOf(task: TaskRow): Lane | null {
  const group: NowGroup | null = nowGroupOf(task);
  return group === "landed" ? "done" : group;
}

function cardKind(card: CardRow): string {
  return (card.actions?.length ?? 0) > 0 ? "decision" : "note";
}

function cardFrom(card: CardRow, keys: Map<string, string>): string {
  if (card.author === "firstmate") return "your first mate";
  return keys.get(card.taskId) ?? card.meta ?? card.author;
}

async function boardOf(connection: CaptainConnection, command: string): Promise<Board> {
  return read<Board>(connection, command, "inf:tasks:board");
}

function keysOf(board: Board): Map<string, string> {
  return new Map(board.tasks.map((task) => [task.id, task.key]));
}

type Window = { label: string; percentRemaining?: number; pace?: string; resetText?: string };
type Snapshot = {
  providers: { label: string; status: string; measuredAt?: number; windows: Window[] }[];
} | null;

function allowanceRows(snapshot: Snapshot): Record<string, unknown>[] {
  return (snapshot?.providers ?? []).map((provider) => {
    const window = provider.windows[0];
    return {
      provider: provider.label,
      left:
        window?.percentRemaining === undefined
          ? provider.status === "ok"
            ? "unknown"
            : provider.status
          : `${Math.round(window.percentRemaining)}%`,
      pace: window?.pace?.replace("_", " ") ?? "unknown",
      resets: window?.resetText ?? "",
    };
  });
}

/** The noun's first word as a verb, or the noun's own list. */
function verbOf(args: AxiArguments, verbs: readonly string[], noun: string): string {
  const verb = args.positional[0] ?? "list";
  if (!verbs.includes(verb))
    invalid(`Unknown verb ${verb} for ${noun}`, [`Verbs: ${verbs.join(", ")}`]);
  return verb;
}

function one(args: AxiArguments, what: string, usage: string): string {
  const value = args.positional[1];
  if (!value || args.positional.length > 2)
    invalid(`This takes one ${what}`, [`Usage: ${C} ${usage}`]);
  return value;
}

const CARD_USAGE =
  "card [list | show <id> | thread <id> | act <id> <action> [--answer name=value]... | reply <id> <words> [--answer name=value]... | close <id>] [--limit <n>] [--fields a,b] [--full] [--json]";

/** A card's answers from `--answer name=value`, each name one of its questions. */
function answersOf(args: AxiArguments, open: CardRow): CardAnswer[] {
  const raw = args.flags["--answer"];
  const given = Array.isArray(raw) ? raw : [];
  const questions = questionsOf(open.body);
  const names = new Set([...questions.map((question) => question.name), ANYTHING_ELSE_ANSWER]);
  const answers = new Map<string, string[]>();
  for (const pair of given) {
    const at = pair.indexOf("=");
    const name = pair.slice(0, at);
    if (at < 1) invalid(`--answer takes name=value, not ${pair}`, [`Usage: ${C} ${CARD_USAGE}`]);
    if (!names.has(name))
      invalid(`Card ${open.id} asks no question ${name}`, [
        questions.length > 0
          ? `Questions: ${questions.map((question) => question.name).join(", ")}`
          : `Card ${open.id} asks no questions; send words with ${ANYTHING_ELSE_ANSWER}=<words>`,
      ]);
    answers.set(name, [...(answers.get(name) ?? []), pair.slice(at + 1)]);
  }
  return [...answers].map(([name, values]) =>
    name === ANYTHING_ELSE_ANSWER
      ? { name, values: [], changed: true, written: values.join("\n") }
      : { name, values, changed: true },
  );
}

/** What a card's button did that only Infinitary's window shows, in words. */
function effectWords(effect: { target?: string } | undefined): Record<string, unknown> {
  return effect?.target
    ? { window: `This button opens ${effect.target} in Infinitary's window; open it there.` }
    : {};
}

async function card(args: AxiArguments, connection: CaptainConnection): Promise<string> {
  const verb = verbOf(args, ["list", "show", "thread", "act", "reply", "close"], "card");
  const cards = await read<CardRow[]>(connection, "card", "inf:cards:list");
  const keys = keysOf(await boardOf(connection, "card"));
  if (verb === "act" || verb === "reply" || verb === "close")
    return cardChange(verb, args, connection, cards);
  if (verb === "list") {
    const rows = cards.map((one) => ({
      id: one.id,
      kind: cardKind(one),
      title: one.title,
      from: cardFrom(one, keys),
      age: one.createdAt ? new Date(one.createdAt).toISOString() : "",
    }));
    return printed(
      args,
      listed(
        "cards",
        rows,
        ["id", "kind", "title", "from"],
        args,
        "0 open cards; nothing waits on you",
      ),
      rows.length > 0 ? [`${C} card show <id>`] : [],
    );
  }
  const id = one(args, "card id", CARD_USAGE);
  const open = cards.find((shown) => shown.id === id);
  if (verb === "thread") {
    const thread = await read<{ messages: { who: string; text: string; at: number }[] }>(
      connection,
      "card",
      "inf:cards:thread",
      [id],
    );
    const rows = thread.messages.map((message) => ({
      who: message.who,
      at: new Date(message.at).toISOString(),
      text: message.text,
    }));
    return printed(args, listed("replies", rows, ["who", "at", "text"], args, "0 replies"), [
      `${C} card show ${id}`,
    ]);
  }
  const full = args.flags["--full"] === true;
  const shown: (CardRow & { ending?: { how: string } }) | null =
    open ??
    (await read<CardRow & { ending?: { how: string } }>(connection, "card", "inf:cards:past", [
      id,
    ]));
  if (!shown) throw new AxiError(`No card ${id}`, "REFUSED", [`${C} card list`]);
  const body = plainWords(shown.body);
  const cut = words(body, full);
  const questions = questionsOf(shown.body);
  const actions = (shown.actions ?? []).map((action) => ({
    id: action.id,
    label: action.label,
    recommended: action.default === true,
  }));
  const thread = open
    ? await read<{ messages: unknown[] }>(connection, "card", "inf:cards:thread", [id])
    : { messages: [] };
  return printed(
    args,
    {
      id: shown.id,
      kind: cardKind(shown),
      title: shown.title,
      from: cardFrom(shown, keys),
      ...(open ? {} : { closed: shown.ending?.how ?? "yes" }),
      body: cut.text,
      ...(cut.chars ? { body_chars: cut.chars } : {}),
      actions,
      questions,
      thread: `${thread.messages.length} replies`,
    },
    [
      ...(cut.chars ? [`${C} card show ${id} --full`] : []),
      ...(thread.messages.length > 0 ? [`${C} card thread ${id}`] : []),
    ],
  );
}

const TASK_USAGE =
  "task [list [--lane waiting|working|queued|backlog|done] [--project <key>] | show <key> | search <words> | crewmate <key> | steer <key> <words> | interrupt <key> | start|stop|continue|drop|queue|unqueue <key>] [--limit <n>] [--fields a,b] [--full] [--json]";

/** The task record's own buttons, by the word the command gives each. */
const TASK_BUTTONS = {
  start: "start-task",
  stop: "stop-task",
  continue: "continue-task",
  drop: "drop-task",
  queue: "queue-task",
  unqueue: "unqueue-task",
} as const satisfies Record<string, TaskLifecycleOp>;
type TaskButton = keyof typeof TASK_BUTTONS;
/** What each button's answer says it did. */
const TASK_DONE: Record<TaskButton, string> = {
  start: "started",
  stop: "stopped",
  continue: "continued",
  drop: "dropped",
  queue: "queued",
  unqueue: "unqueued",
};

async function task(args: AxiArguments, connection: CaptainConnection): Promise<string> {
  const verb = verbOf(
    args,
    ["list", "show", "search", "crewmate", "steer", "interrupt", ...Object.keys(TASK_BUTTONS)],
    "task",
  );
  if (verb === "steer" || verb === "interrupt" || Object.hasOwn(TASK_BUTTONS, verb))
    return taskChange(verb, args, connection);
  const full = args.flags["--full"] === true;
  if (verb === "list") {
    const board = await boardOf(connection, "task");
    const lane = args.flags["--lane"];
    if (lane !== undefined && !LANES.includes(lane as Lane))
      invalid(`No lane ${lane}`, [`Lanes: ${LANES.join(", ")}`]);
    const projectKey = args.flags["--project"];
    const project =
      typeof projectKey === "string"
        ? board.projects.find((one) => one.key.toLowerCase() === projectKey.toLowerCase())
        : undefined;
    if (typeof projectKey === "string" && !project)
      throw new AxiError(`No project ${projectKey}`, "REFUSED", [`${C} project list`]);
    const rows = board.tasks
      .map((one) => ({ task: one, lane: laneOf(one) }))
      .filter(
        (row) =>
          row.lane !== null &&
          (lane === undefined || row.lane === lane) &&
          (!project || row.task.projectId === project.id),
      )
      .sort((a, b) => LANES.indexOf(a.lane as Lane) - LANES.indexOf(b.lane as Lane))
      .map((row) => ({
        key: row.task.key,
        title: row.task.title,
        lane: row.lane,
        activity: row.task.activity ?? "",
        status: row.task.status,
      }));
    return printed(
      args,
      listed("tasks", rows, ["key", "title", "lane", "activity"], args, "0 tasks"),
      rows.length > 0 ? [`${C} task show <key>`] : [],
    );
  }
  if (verb === "search") {
    const query = args.positional.slice(1).join(" ").trim();
    if (!query) invalid("search takes words", [`Usage: ${C} task search <words>`]);
    const needle = foldForSearch(query);
    const board = await boardOf(connection, "task");
    const onBoard = board.tasks.filter((one) =>
      [one.key, one.title, one.goal ?? ""].some((field) => foldForSearch(field).includes(needle)),
    );
    const older = await read<TaskRow[]>(connection, "task", "inf:tasks:search", [query]);
    const seen = new Set(onBoard.map((one) => one.id));
    const rows = [...onBoard, ...older.filter((one) => !seen.has(one.id))].map((one) => ({
      key: one.key,
      title: one.title,
      status: one.status,
      lane: laneOf(one) ?? "",
    }));
    return printed(
      args,
      listed("tasks", rows, ["key", "title", "status"], args, `0 tasks match ${query}`),
      rows.length > 0 ? [`${C} task show <key>`] : [],
    );
  }
  const key = one(args, "task key", TASK_USAGE);
  const id = await taskIdOf(connection, key);
  const detail = await read<TaskRow>(connection, "task", "inf:tasks:detail", [id]);
  if (verb === "crewmate") {
    const record = await read<{ lines: CrewLine[]; earlier: number }>(
      connection,
      "task",
      "inf:tasks:crewmate",
      [id],
    );
    const rows = record.lines.map((line) => {
      const text = line.text ?? `${line.name ?? ""} ${line.target ?? ""}`.trim();
      return {
        at: new Date(line.at).toISOString(),
        kind: line.kind,
        text:
          full || text.length <= 200
            ? text
            : `${cutText(text, 200)}... (${text.length - 200} more characters)`,
      };
    });
    // The newest lines are the ones a reader wants: `--limit` keeps the last n.
    const raw = args.flags["--limit"];
    const keep = typeof raw === "string" ? Number(raw) : 20;
    if (!Number.isInteger(keep) || keep < 1)
      invalid("--limit takes a whole number of lines, 1 or more");
    const shown = rows.slice(-keep);
    return printed(
      args,
      {
        key: detail.key,
        lines: shown,
        count:
          rows.length === 0
            ? "0 lines; no crewmate has worked on it yet"
            : `last ${shown.length} of ${rows.length + record.earlier} lines`,
      },
      rows.length > shown.length ? [`${C} task crewmate ${detail.key} --limit ${rows.length}`] : [],
    );
  }
  const goal = words(detail.goal, full);
  const outcome = words(detail.outcomeSummary, full);
  return printed(
    args,
    {
      key: detail.key,
      title: detail.title,
      status: detail.status,
      lane: laneOf(detail) ?? "",
      activity: detail.activity ?? "",
      goal: goal.text,
      ...(goal.chars ? { goal_chars: goal.chars } : {}),
      ...(detail.outcomeSummary ? { outcome: outcome.text } : {}),
      blocked_by: detail.blockedBy ?? [],
    },
    [
      `${C} task crewmate ${detail.key}`,
      ...(goal.chars || outcome.chars ? [`${C} task show ${detail.key} --full`] : []),
    ],
  );
}

/** A card's thread as the app answers it. */
type Thread = { messages: { who: string; text: string; at: number }[] };

/** Press a card's button, reply in its thread, or close it, as you. */
async function cardChange(
  verb: "act" | "reply" | "close",
  args: AxiArguments,
  connection: CaptainConnection,
  cards: CardRow[],
): Promise<string> {
  const id = args.positional[1];
  if (!id) invalid(`card ${verb} takes a card id`, [`Usage: ${C} ${CARD_USAGE}`]);
  const open = cards.find((shown) => shown.id === id);
  if (verb === "close") {
    if (args.positional.length > 2) invalid("card close takes one card id");
    if (!open) {
      // Closed already is nothing to do; a card the app never had is no card.
      if (!(await read<CardRow | null>(connection, "card", "inf:cards:past", [id])))
        throw new AxiError(`No card ${id}`, "REFUSED", [`${C} card list`]);
      return printed(args, { card: id, closed: "already" }, []);
    }
    await read(connection, "card", "inf:cards:close", [id]);
    return printed(args, { card: id, closed: "yes" }, [`${C} card list`]);
  }
  if (!open) throw new AxiError(`No open card ${id}`, "REFUSED", [`${C} card list`]);
  const answers = answersOf(args, open);
  if (verb === "act") {
    const action = args.positional[2];
    if (!action || args.positional.length > 3)
      invalid("card act takes a card id and one of its buttons", [`Usage: ${C} ${CARD_USAGE}`]);
    const button = open.actions?.find((one) => one.id === action);
    if (!button)
      invalid(`Card ${id} has no button ${action}`, [
        open.actions?.length
          ? `Buttons: ${open.actions.map((one) => one.id).join(", ")}`
          : `Card ${id} has no buttons; reply with \`${C} card reply ${id} <words>\``,
      ]);
    const result = await read<{ effect?: { target?: string }; refusal?: string }>(
      connection,
      "card",
      "inf:cards:act",
      [id, action, "chrome", ...(answers.length > 0 ? [{ answers }] : [])],
    );
    if (result.refusal) throw new AxiError(result.refusal, "REFUSED", [`${C} card show ${id}`]);
    return printed(
      args,
      {
        card: id,
        pressed: button.label,
        ...(answers.length > 0 ? { answers: answers.length } : {}),
        ...effectWords(result.effect),
      },
      [`${C} card list`],
    );
  }
  const text = args.positional.slice(2).join(" ").trim();
  if (!text && answers.length === 0)
    invalid("card reply takes your words", [`Usage: ${C} ${CARD_USAGE}`]);
  const thread = await read<Thread>(connection, "card", "inf:cards:reply", [
    id,
    { text, ...(answers.length > 0 ? { answers } : {}) },
  ]);
  return printed(args, { card: id, replied: "yes", thread: `${thread.messages.length} replies` }, [
    `${C} card thread ${id}`,
  ]);
}

/** Steer or interrupt a task's crewmate, or press one of its record's buttons, as you. */
async function taskChange(
  verb: string,
  args: AxiArguments,
  connection: CaptainConnection,
): Promise<string> {
  const key = args.positional[1];
  if (!key) invalid(`task ${verb} takes a task key`, [`Usage: ${C} ${TASK_USAGE}`]);
  if (verb === "steer") {
    const text = args.positional.slice(2).join(" ").trim();
    if (!text) invalid("task steer takes your words", [`Usage: ${C} task steer <key> <words>`]);
    const id = await taskIdOf(connection, key);
    const sent = await read<{ ok: boolean; text?: string }>(connection, "task", "inf:task:steer", [
      id,
      text,
    ]);
    if (!sent.ok) throw new AxiError(sent.text ?? "Refused.", "REFUSED");
    return printed(args, { task: key, steered: "yes" }, [`${C} task crewmate ${key}`]);
  }
  if (args.positional.length > 2) invalid(`task ${verb} takes one task key`);
  const id = await taskIdOf(connection, key);
  if (verb === "interrupt") {
    const sent = await read<{ ok: boolean; text?: string }>(
      connection,
      "task",
      "inf:task:interrupt",
      [id],
    );
    if (!sent.ok) throw new AxiError(sent.text ?? "Refused.", "REFUSED");
    return printed(args, { task: key, interrupted: "yes" }, [`${C} task crewmate ${key}`]);
  }
  const button = verb as TaskButton;
  const detail = await read<TaskRow & { dropEffects?: DropEffects }>(
    connection,
    "task",
    "inf:tasks:detail",
    [id],
  );
  // Nothing to do is an answer: a stopped task stopped again, a running one started again.
  if (
    (button === "stop" && detail.status !== "active") ||
    (button === "start" && detail.status === "active")
  )
    return printed(args, { task: key, [TASK_DONE[button]]: "already" }, []);
  // A drop sends what it affects, as the window's review shows it, and the answer names them.
  const review =
    button === "drop" && detail.dropEffects ? dropReviewKeys(detail.dropEffects) : null;
  const done = await read<{ ok: boolean; text?: string }>(connection, "task", "inf:task:run", [
    id,
    TASK_BUTTONS[button],
    review,
  ]);
  if (!done.ok) throw new AxiError(done.text ?? "Refused.", "REFUSED", [`${C} task show ${key}`]);
  return printed(
    args,
    {
      task: key,
      [TASK_DONE[button]]: "yes",
      ...(review && review.waiting.length > 0 ? { waiting_on_it: review.waiting } : {}),
      ...(review && review.underway.length > 0 ? { underway: review.underway } : {}),
    },
    [`${C} task show ${key}`],
  );
}

const SAY_USAGE =
  "say <words> [--card <id>] [--task <key>] [--project <key>] [--file <path>]... [--wait [--for <seconds>]] [--json]";
/** Seconds `say --wait` waits by default, and at most: inside the minute a command is given. */
const SAY_SECONDS = 45;

type LastTurn = { you: string; reply: { text: string; words?: string; problem?: boolean } | null };

/** Your words to your first mate, as from the window's input. */
async function say(
  args: AxiArguments,
  connection: CaptainConnection,
  cwd: string,
): Promise<string> {
  const text = args.positional.join(" ").trim();
  if (!text) invalid("say takes your words", [`Usage: ${C} ${SAY_USAGE}`]);
  const wait = args.flags["--wait"] === true;
  const forRaw = args.flags["--for"];
  if (forRaw !== undefined && !wait)
    invalid("--for goes with --wait", [`Usage: ${C} ${SAY_USAGE}`]);
  const seconds = typeof forRaw === "string" ? Number(forRaw) : SAY_SECONDS;
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > WATCH_SECONDS_AT_MOST)
    invalid(`--for takes seconds from 0 to ${WATCH_SECONDS_AT_MOST}`);
  const fileRaw = args.flags["--file"];
  const files = (Array.isArray(fileRaw) ? fileRaw : []).map((path) => {
    try {
      return {
        name: cutText(basename(path), 120),
        text: readFileSync(isAbsolute(path) ? path : resolve(cwd, path), "utf8"),
      };
    } catch {
      return invalid(`--file could not read ${path}`);
    }
  });
  // The window's hints, by the names you know them by: the card, the task and the project.
  const cardId = args.flags["--card"];
  const cards = await read<CardRow[]>(connection, "say", "inf:cards:list");
  if (typeof cardId === "string" && !cards.some((one) => one.id === cardId))
    throw new AxiError(`No open card ${cardId}`, "REFUSED", [`${C} card list`]);
  const taskKey = args.flags["--task"];
  const taskId = typeof taskKey === "string" ? await taskIdOf(connection, taskKey) : undefined;
  const projectKey = args.flags["--project"];
  let projectId: string | undefined;
  if (typeof projectKey === "string") {
    const projects = await read<Project[]>(connection, "say", "inf:projects:list");
    projectId = projects.find((one) => one.key.toLowerCase() === projectKey.toLowerCase())?.id;
    if (!projectId)
      throw new AxiError(`No project ${projectKey}`, "REFUSED", [`${C} project list`]);
  }
  const before = new Map(cards.map((one) => [one.id, one.offerId]));
  const start = wait
    ? String(answerOf(await connection.call("say", "captain.watch", { waitMs: 0 })).cursor)
    : undefined;
  await read(connection, "say", "inf:converse", [
    {
      text,
      ...(files.length > 0 ? { files } : {}),
      ...(typeof cardId === "string" ? { visibleCardId: cardId } : {}),
      ...(taskId ? { taskId } : {}),
      ...(projectId ? { focusedProjectId: projectId } : {}),
    },
  ]);
  if (!wait)
    return printed(args, { sent: "yes", to: "your first mate" }, [
      `${C} watch --only cards`,
      `${C} say <words> --wait`,
    ]);
  // Wait for the first mate's reply line beside these words, reading again on each change.
  const deadline = Date.now() + seconds * 1000;
  let cursor = start;
  let last: LastTurn | null = null;
  for (;;) {
    last = await read<LastTurn | null>(connection, "say", "inf:conversation:last-turn");
    const remaining = deadline - Date.now();
    if ((last?.you.trim() === text && last.reply) || remaining <= 0) break;
    const changed = answerOf(
      await connection.call("say", "captain.watch", {
        ...(cursor ? { after: cursor } : {}),
        waitMs: remaining,
        channels: ["inf:event", "inf:cards"],
      }),
    );
    cursor = String(changed.cursor);
  }
  const keys = keysOf(await boardOf(connection, "say"));
  const shown = (await read<CardRow[]>(connection, "say", "inf:cards:list"))
    .filter((one) => one.author === "firstmate" && before.get(one.id) !== one.offerId)
    .map((one) => ({
      id: one.id,
      kind: cardKind(one),
      title: one.title,
      from: cardFrom(one, keys),
    }));
  const reply = last?.you.trim() === text ? last.reply : null;
  return printed(
    args,
    {
      sent: "yes",
      reply: reply ? (reply.words ?? reply.text) : `none yet after ${seconds} s`,
      ...(reply?.problem ? { problem: true } : {}),
      cards: shown.length > 0 ? shown : "0 new cards from your first mate",
    },
    [
      ...shown.map((one) => `${C} card show ${one.id}`),
      ...(reply ? [] : [`${C} watch --only cards --after ${cursor}`]),
    ],
  );
}

async function activity(args: AxiArguments, connection: CaptainConnection): Promise<string> {
  if (args.positional.length > 0)
    invalid("activity takes no words", [`Usage: ${C} activity [--task <key>]`]);
  const lines = await read<{ kind: string; text: string; at: number; taskKey?: string }[]>(
    connection,
    "activity",
    "inf:feed:recent",
  );
  const taskKey = args.flags["--task"];
  const rows = lines
    .filter((line) => typeof taskKey !== "string" || line.taskKey === taskKey)
    .map((line) => ({
      when: new Date(line.at).toISOString(),
      kind: line.kind,
      text: line.text,
      task: line.taskKey ?? "",
    }));
  return printed(
    args,
    listed("activity", rows, ["when", "kind", "text", "task"], args, "0 lines"),
    [],
  );
}

async function allowance(args: AxiArguments, connection: CaptainConnection): Promise<string> {
  if (args.positional.length > 0) invalid("allowance takes no words");
  const snapshot = await read<Snapshot>(connection, "allowance", "inf:quota:snapshot");
  const rows = allowanceRows(snapshot);
  return printed(
    args,
    listed(
      "allowance",
      rows,
      ["provider", "left", "pace", "resets"],
      args,
      "0 providers signed in",
    ),
    [],
  );
}

type Project = {
  id: string;
  key: string;
  name: string;
  repo: { name: string } | null;
  /** Every repository it holds, first first; absent from an older app. */
  repos?: { name: string }[];
  archived: boolean;
  counts: Record<string, number>;
};
type Repo = { name: string; path: string; runsOn: string | null; delivery: string };

async function project(args: AxiArguments, connection: CaptainConnection): Promise<string> {
  const verb = verbOf(args, ["list", "show"], "project");
  const projects = await read<Project[]>(connection, "project", "inf:projects:list");
  const repos = await read<Repo[]>(connection, "project", "inf:repos:list");
  // One row for each repository a project holds (INF-4220): one for a project of one, as before.
  const rowsOf = (one: Project) =>
    (one.repos ?? (one.repo ? [one.repo] : [undefined])).map((member) => {
      const repo = member && repos.find((candidate) => candidate.name === member.name);
      return {
        key: one.key,
        name: one.name,
        ...((one.repos?.length ?? 0) > 1 ? { repository: member?.name ?? "" } : {}),
        folder: repo?.path ?? "",
        runs_on: repo ? (repo.runsOn ?? "this computer") : "",
        open: one.counts.open ?? 0,
        active: one.counts.active ?? 0,
        delivery: repo?.delivery ?? "",
      };
    });
  const rowOf = (one: Project): Record<string, unknown> => {
    const [first, ...rest] = rowsOf(one);
    return rest.length ? { ...first, repositories: [first, ...rest] } : { ...first };
  };
  if (verb === "list") {
    const rows = projects.filter((one) => !one.archived).flatMap(rowsOf);
    const fields = rows.some((row) => "repository" in row)
      ? ["key", "name", "repository", "folder", "runs_on"]
      : ["key", "name", "folder", "runs_on"];
    return printed(
      args,
      listed("projects", rows, fields, args, "0 projects"),
      rows.length > 0 ? [`${C} task list --project <key>`] : [],
    );
  }
  const key = one(args, "project key", "project show <key>");
  const found = projects.find((candidate) => candidate.key.toLowerCase() === key.toLowerCase());
  if (!found) throw new AxiError(`No project ${key}`, "REFUSED", [`${C} project list`]);
  return printed(args, rowOf(found), [`${C} task list --project ${found.key}`]);
}

type Rule = { id: string; name: string; state: string; when?: string; nextFire?: number | null };

async function automation(args: AxiArguments, connection: CaptainConnection): Promise<string> {
  const verb = verbOf(args, ["list", "show"], "automation");
  const listing = await read<{ state: string; rules?: Rule[]; reason?: string }>(
    connection,
    "automation",
    "inf:automation:list",
  );
  if (listing.state !== "ready")
    throw new AxiError(listing.reason ?? "Automation is not ready.", "REFUSED");
  const rules = listing.rules ?? [];
  const rowOf = (rule: Rule) => ({
    id: rule.id,
    name: rule.name,
    state: rule.state,
    when: rule.when ?? "",
    next: rule.nextFire ? new Date(rule.nextFire).toISOString() : "",
  });
  if (verb === "list")
    return printed(
      args,
      listed("rules", rules.map(rowOf), ["id", "name", "state", "when"], args, "0 rules"),
      rules.length > 0 ? [`${C} automation show <id>`] : [],
    );
  const id = one(args, "rule id", "automation show <id>");
  const rule = rules.find((candidate) => candidate.id === id);
  if (!rule) throw new AxiError(`No rule ${id}`, "REFUSED", [`${C} automation list`]);
  const history = await read<{ firedAt: number; delivery: string; events: number }[]>(
    connection,
    "automation",
    "inf:automation:history",
    [id],
  );
  const runs = history.map((run) => ({
    fired: new Date(run.firedAt).toISOString(),
    delivery: run.delivery,
    events: run.events,
  }));
  return printed(
    args,
    { ...rowOf(rule), ...listed("runs", runs, ["fired", "delivery", "events"], args, "0 runs") },
    [],
  );
}

type Collections = {
  state: string;
  reason?: string;
  collections?: { scope: string; name: string; concepts: number; findings: number }[];
};

async function knowledge(args: AxiArguments, connection: CaptainConnection): Promise<string> {
  const verb = verbOf(args, ["list", "search", "show"], "knowledge");
  const full = args.flags["--full"] === true;
  if (verb === "show") {
    const id = one(args, "entry id", "knowledge show <id>");
    const answer = await read<{
      state: string;
      reason?: string;
      entry?: {
        id: string;
        kind: string;
        title?: string;
        explanation?: string;
        statement?: string;
        scope: string;
      };
    }>(connection, "knowledge", "inf:knowledge:entry", [{ id }]);
    if (answer.state !== "ready" || !answer.entry)
      throw new AxiError(answer.reason ?? `No entry ${id}`, "REFUSED");
    const { entry } = answer;
    const text = words(entry.explanation ?? entry.statement ?? "", full);
    return printed(
      args,
      {
        id: entry.id,
        kind: entry.kind,
        scope: entry.scope,
        title: entry.title ?? "",
        text: text.text,
        ...(text.chars ? { text_chars: text.chars } : {}),
      },
      text.chars ? [`${C} knowledge show ${id} --full`] : [],
    );
  }
  const listing = await read<Collections>(connection, "knowledge", "inf:knowledge:collections");
  if (listing.state !== "ready")
    throw new AxiError(listing.reason ?? "Knowledge is not ready.", "REFUSED");
  const collections = listing.collections ?? [];
  if (verb === "list") {
    const rows = collections.map((one) => ({
      scope: one.scope,
      name: one.name,
      concepts: one.concepts,
      findings: one.findings,
    }));
    return printed(
      args,
      listed("collections", rows, ["scope", "name", "concepts", "findings"], args, "0 collections"),
      rows.length > 0 ? [`${C} knowledge search <words>`] : [],
    );
  }
  const query = args.positional.slice(1).join(" ").trim();
  if (!query)
    invalid("search takes words", [`Usage: ${C} knowledge search <words> [--scope <scope>]`]);
  const scope = args.flags["--scope"];
  const scopes = typeof scope === "string" ? [scope] : collections.map((one) => one.scope);
  const rows: Record<string, unknown>[] = [];
  for (const each of scopes) {
    const found = await read<{
      state: string;
      rows?: { id: string; title: string; findings: number }[];
    }>(connection, "knowledge", "inf:knowledge:concepts", [{ scope: each, query }]);
    for (const row of found.rows ?? [])
      rows.push({ id: row.id, title: row.title, findings: row.findings, scope: each });
  }
  return printed(
    args,
    listed("concepts", rows, ["id", "title", "findings"], args, `0 concepts match ${query}`),
    rows.length > 0 ? [`${C} knowledge show <id>`] : [],
  );
}

/** The push channels each `--only` group watches. */
const WATCH_GROUPS: Record<string, string[]> = {
  cards: ["inf:cards", "inf:cards:thread"],
  tasks: ["inf:tasks", "inf:tasks:delta"],
  activity: ["inf:event"],
  allowance: ["inf:quota"],
};
/** Seconds `watch` waits by default, and at most: inside the minute a command is given. */
const WATCH_SECONDS = 25;
const WATCH_SECONDS_AT_MOST = 50;

async function watch(args: AxiArguments, connection: CaptainConnection): Promise<string> {
  if (args.positional.length > 0) invalid("watch takes no words", [`Usage: ${C} ${WATCH_USAGE}`]);
  const forRaw = args.flags["--for"];
  const seconds = typeof forRaw === "string" ? Number(forRaw) : WATCH_SECONDS;
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > WATCH_SECONDS_AT_MOST)
    invalid(`--for takes seconds from 0 to ${WATCH_SECONDS_AT_MOST}`);
  const only = typeof args.flags["--only"] === "string" ? args.flags["--only"].split(",") : [];
  for (const group of only)
    if (!Object.hasOwn(WATCH_GROUPS, group))
      invalid(`No group ${group}`, [`Groups: ${Object.keys(WATCH_GROUPS).join(", ")}`]);
  const named =
    typeof args.flags["--channel"] === "string" ? args.flags["--channel"].split(",") : [];
  const channels = [...only.flatMap((group) => WATCH_GROUPS[group] ?? []), ...named];
  const after = args.flags["--after"];
  const data = answerOf(
    await connection.call("watch", "captain.watch", {
      ...(typeof after === "string" ? { after } : {}),
      waitMs: seconds * 1000,
      ...(channels.length > 0 ? { channels } : {}),
      ...(named.length > 0 ? { full: true } : {}),
    }),
  );
  const changes = (data.changes as unknown[]) ?? [];
  return printed(
    args,
    {
      ...(data.reloaded ? { reloaded: true } : {}),
      cursor: data.cursor,
      changes,
      ...(changes.length === 0 ? { count: `0 changes in ${seconds} s` } : {}),
    },
    [
      `${C} watch --after ${String(data.cursor)}${only.length > 0 ? ` --only ${only.join(",")}` : ""}`,
      ...(data.reloaded
        ? [`Your cursor was from before; read the state again, such as \`${C}\``]
        : []),
    ],
  );
}

const WATCH_USAGE =
  "watch [--after <cursor>] [--for <seconds>] [--only cards,tasks,activity,allowance] [--channel <push>[,<push>]] [--json]";

/** Each positional argument as JSON when it parses, else as words. */
function argumentOf(raw: string, strings: boolean): unknown {
  if (strings) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const API_USAGE =
  "api list [--area <name>] [--reads | --changes] | api show <channel> | api <channel> [arg]... [--input <file>] [--string]";

async function api(
  args: AxiArguments,
  connection: CaptainConnection,
  cwd: string,
): Promise<string> {
  const first = args.positional[0];
  if (!first) invalid("api takes list, show or a channel", [`Usage: ${C} ${API_USAGE}`]);
  if (first === "list") {
    const data = answerOf(await connection.call("api", "captain.channels", {}));
    const all = data.channels as { channel: string; effect: string; args: number }[];
    const area = args.flags["--area"];
    const effect = args.flags["--reads"] ? "read" : args.flags["--changes"] ? "change" : undefined;
    const rows = all.filter(
      (row) =>
        (typeof area !== "string" || row.channel.split(":")[1] === area) &&
        (effect === undefined || row.effect === effect),
    );
    const filter = [typeof area === "string" ? `--area ${area}` : "", effect ? `--${effect}s` : ""]
      .filter(Boolean)
      .join(" ");
    const out = listed(
      "channels",
      rows,
      ["channel", "effect", "args"],
      {
        ...args,
        flags: {
          ...args.flags,
          "--limit": args.flags["--limit"] ?? String(Math.max(1, rows.length)),
        },
      },
      `0 of ${all.length} channels${filter ? ` (filter: ${filter})` : ""}`,
    );
    if (rows.length > 0)
      out.count = `${(out.channels as unknown[]).length} of ${all.length} channels${filter ? ` (filter: ${filter})` : ""}`;
    return printed(args, out, [`${C} api show <channel>`]);
  }
  if (first === "show") {
    const channel = one(args, "channel", "api show <channel>");
    const data = answerOf(await connection.call("api", "captain.channels", { channel }));
    return printed(args, data, [
      `${C} api ${channel}${(data.args as unknown[]).length > 0 ? " <arg>..." : ""}`,
    ]);
  }
  let values: unknown[];
  const input = args.flags["--input"];
  if (typeof input === "string") {
    if (args.positional.length > 1)
      invalid("--input takes the whole argument list; give no arguments beside it");
    let text: string;
    try {
      text = readFileSync(isAbsolute(input) ? input : resolve(cwd, input), "utf8");
    } catch {
      invalid(`--input could not read ${input}`);
    }
    try {
      values = JSON.parse(text);
    } catch {
      invalid(`--input holds no JSON: ${input}`);
    }
    if (!Array.isArray(values)) invalid("--input holds the argument list as a JSON array");
  } else {
    values = args.positional
      .slice(1)
      .map((raw) => argumentOf(raw, args.flags["--string"] === true));
  }
  try {
    const value = await read(connection, "api", "captain.request" === first ? "" : first, values);
    return printed(args, { channel: first, value: value ?? null }, []);
  } catch (error) {
    if (error instanceof AxiError && error.code === "VALIDATION_ERROR")
      throw new AxiError(error.message, error.code, [`${C} api show ${first}`]);
    throw error;
  }
}

/** The skill `setup` writes: a pointer at the command, nothing more (the captain's pick). */
export const SKILL_TEXT = `---
name: ${C}
description: Use Infinitary from the terminal as the person - what waits on them, their cards, tasks, crew, allowance, projects, automation and knowledge; their words to their first mate, a card's buttons and a task's own buttons; and notes. Use when asked about Infinitary, its tasks or its cards.
---
Run \`${C}\` first: it shows what waits on the person and the next commands. \`${C} --help\` lists every command, and \`${C} <command> --help\` explains one.
`;

const SETUP_USAGE = "setup [skill] [--check] [--dir <skills folder>]";

async function setup(
  args: AxiArguments,
  _connection: CaptainConnection,
  cwd: string,
): Promise<string> {
  const what = args.positional[0] ?? "skill";
  if (what !== "skill" || args.positional.length > 1)
    invalid(`setup writes the skill alone`, [`Usage: ${C} ${SETUP_USAGE}`]);
  const dirRaw = args.flags["--dir"];
  const dir =
    typeof dirRaw === "string"
      ? isAbsolute(dirRaw)
        ? dirRaw
        : resolve(cwd, dirRaw)
      : join(homedir(), ".claude", "skills");
  const path = join(dir, C, "SKILL.md");
  let now: string | undefined;
  try {
    now = readFileSync(path, "utf8");
  } catch {
    now = undefined;
  }
  const state = now === SKILL_TEXT ? "current" : now === undefined ? "missing" : "stale";
  if (args.flags["--check"]) {
    if (state !== "current")
      throw new AxiError(`The skill at ${path} is ${state}`, "REFUSED", [
        `${C} setup skill${typeof dirRaw === "string" ? ` --dir ${dirRaw}` : ""}`,
      ]);
    return printed(args, { skill: path, state }, []);
  }
  if (state !== "current") {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, SKILL_TEXT);
  }
  return printed(
    args,
    { skill: path, state: state === "current" ? "already current" : "written" },
    [`${C} setup --check`],
  );
}

/** The inbox's two verbs, kept word for word from `infinitary-inbox-axi`. */
async function note(args: AxiArguments, connection: CaptainConnection): Promise<string> {
  const text = args.positional.join(" ").trim();
  if (!text) invalid("note takes the event's words", [`Usage: ${C} ${NOTE_USAGE}`]);
  const requestId = args.flags["--request-id"];
  const source = args.flags["--source"];
  const data = answerOf(
    await connection.call("note", "inbox.note", {
      text,
      ...(typeof requestId === "string" ? { requestId } : {}),
      ...(typeof source === "string" ? { source } : {}),
    }),
  );
  return printed(args, data, [
    `Run \`${C} receipts\` to see when your first mate handled it`,
    "listening 0 means no turned-on rule listens, so nothing wakes your first mate: turn on the Infinitary Inbox events rule in Settings → Automation",
  ]);
}

const NOTE_USAGE = 'note [--request-id <id>] [--source <name>] "<words>"';
const RECEIPTS_USAGE = "receipts [--after <cursor>]";

async function receipts(args: AxiArguments, connection: CaptainConnection): Promise<string> {
  if (args.positional.length > 0)
    invalid("receipts takes no words", [`Usage: ${C} ${RECEIPTS_USAGE}`]);
  const raw = args.flags["--after"];
  const after = typeof raw === "string" ? Number(raw) : 0;
  if (!Number.isInteger(after) || after < 0)
    invalid("--after takes a cursor a receipts read answered", [`Usage: ${C} ${RECEIPTS_USAGE}`]);
  return printed(args, answerOf(await connection.call("receipts", "inbox.receipts", { after })), [
    `Run \`${C} receipts --after <cursor>\` to read on from here`,
  ]);
}

/** The bare command: what waits on you, then the next commands. */
async function home(connection: CaptainConnection): Promise<Record<string, unknown>> {
  const [cards, board, crew, snapshot] = await Promise.all([
    read<CardRow[]>(connection, "home", "inf:cards:list"),
    boardOf(connection, "home"),
    read<{ working: number; idle: number; queued: number }>(connection, "home", "inf:crew:counts"),
    read<Snapshot>(connection, "home", "inf:quota:snapshot"),
  ]);
  const keys = keysOf(board);
  const lanes = new Map<Lane, TaskRow[]>(LANES.map((lane) => [lane, []]));
  for (const one of board.tasks) {
    const lane = laneOf(one);
    if (lane) lanes.get(lane)?.push(one);
  }
  const count = (lane: Lane) => lanes.get(lane)?.length ?? 0;
  const working = (lanes.get("working") ?? []).slice(0, 10);
  return {
    cards:
      cards.length === 0
        ? "0 open cards; nothing waits on you"
        : cards.slice(0, 10).map((one) => ({
            id: one.id,
            kind: cardKind(one),
            title: one.title,
            from: cardFrom(one, keys),
          })),
    tasks: `${count("waiting")} ${NOW_GROUP_LABELS.waiting} · ${count("working")} working · ${count("queued")} queued · ${count("backlog")} in the backlog · ${count("done")} done this week`,
    working:
      working.length === 0
        ? "0 tasks working"
        : working.map((one) => ({ key: one.key, title: one.title, activity: one.activity ?? "" })),
    crew: `${crew.working} working · ${crew.idle} idle · ${crew.queued} queued`,
    allowance: allowanceRows(snapshot),
    help: [
      ...(cards.length > 0 ? [`${C} card show <id>`] : []),
      `${C} task list --lane queued`,
      `${C} say <words>`,
      `${C} watch`,
      `${C} --help`,
    ],
  };
}

function commands(cwd: string): Record<string, AxiCommand<CaptainConnection>> {
  return {
    card: {
      usage: CARD_USAGE,
      description:
        "Your open cards: list them, show one as plain words with its buttons and questions, or read its thread; press a button with act, answering its questions with --answer name=value, reply in its thread, or close it. A change is recorded as yours from this command.",
      flags: { ...LIST_FLAGS, ...SHOW_FLAGS, "--answer": "values" },
      run: card,
    },
    task: {
      usage: TASK_USAGE,
      description:
        "Your tasks as the board lanes them: list, show one, search by key or title, or read its crewmate's record; steer or interrupt its crewmate, or press its record's start, stop, continue, drop, queue or unqueue. A change is recorded as yours from this command.",
      flags: { ...LIST_FLAGS, ...SHOW_FLAGS, "--lane": "value", "--project": "value" },
      run: task,
    },
    say: {
      usage: SAY_USAGE,
      description: `Your words to your first mate, as from the window's input, recorded as yours from this command. It answers at once; its answer arrives on a card or beside your words, and --wait waits up to --for seconds (${SAY_SECONDS} by default) and prints them. --card, --task and --project name what you are looking at, and --file adds a text file.`,
      flags: {
        "--card": "value",
        "--task": "value",
        "--project": "value",
        "--file": "values",
        "--wait": "switch",
        "--for": "value",
        "--json": "switch",
      },
      run: (args, connection) => say(args, connection, cwd),
    },
    activity: {
      usage: "activity [--task <key>] [--limit <n>] [--fields a,b] [--json]",
      description: "Activity's newest lines: when, kind, words and task.",
      flags: { ...LIST_FLAGS, "--task": "value" },
      run: activity,
    },
    allowance: {
      usage: "allowance [--json]",
      description: "Each provider's allowance: how much is left, the pace and when it resets.",
      flags: { ...LIST_FLAGS },
      run: allowance,
    },
    project: {
      usage: "project [list | show <key>] [--json]",
      description: "Your projects: key, name, folder and the computer it runs on.",
      flags: { ...LIST_FLAGS },
      run: project,
    },
    automation: {
      usage: "automation [list | show <id>] [--json]",
      description: "Your Automation rules, and one rule's runs.",
      flags: { ...LIST_FLAGS },
      run: automation,
    },
    knowledge: {
      usage: "knowledge [list | search <words> [--scope <scope>] | show <id>] [--full] [--json]",
      description: "Your knowledge: its collections, concepts that match words, and one entry.",
      flags: { ...LIST_FLAGS, ...SHOW_FLAGS, "--scope": "value" },
      run: knowledge,
    },
    watch: {
      usage: WATCH_USAGE,
      description: `Changes as they happen, each with its cursor: waits up to --for seconds (${WATCH_SECONDS} by default) for the next one. Pass the answer's cursor as --after to read on; an old cursor answers reloaded. --channel prints those pushes whole.`,
      flags: {
        "--after": "value",
        "--for": "value",
        "--only": "value",
        "--channel": "value",
        "--json": "switch",
      },
      run: watch,
    },
    api: {
      usage: API_USAGE,
      description:
        "Any request of the published contract this command reaches, checked against the contract before it is sent: list them, show one's arguments, or send one. Each argument is read as JSON when it parses, else as words; --string keeps them words, and --input reads the list from a file. A change is recorded as yours from this command.",
      flags: {
        ...LIST_FLAGS,
        "--area": "value",
        "--reads": "switch",
        "--changes": "switch",
        "--input": "value",
        "--string": "switch",
      },
      run: (args, connection) => api(args, connection, cwd),
    },
    setup: {
      usage: SETUP_USAGE,
      description: `Writes a short skill that points your own agents at ${C}, in ~/.claude/skills or the folder --dir names; --check exits 1 when it is missing or stale.`,
      flags: { "--check": "switch", "--dir": "value", "--json": "switch" },
      run: (args, connection) => setup(args, connection, cwd),
    },
    note: {
      usage: NOTE_USAGE,
      description:
        "Record one event with its words and answer its id at once. The same --request-id twice records once and answers the first event's id. Your first mate reads it as information from outside, never as an instruction.",
      flags: { "--request-id": "value", "--source": "value", "--json": "switch" },
      run: note,
    },
    receipts: {
      usage: RECEIPTS_USAGE,
      description:
        "List each event recorded and each one handled after a cursor, oldest first; pass the answer's cursor as --after next time.",
      flags: { "--after": "value", "--json": "switch" },
      run: receipts,
    },
  };
}

/** What the old name adds to every answer, until the captain retires it. */
export const RENAMED_WORDS = `${INBOX_COMMAND} is now ${C}; the old name still works`;

/**
 * An answer of the old name: a `notice` line above it, or with `--json` a
 * `notice` field inside the answer's object, so it still parses. An
 * answer that is not one JSON object, such as an error, keeps the line.
 */
export function withRenamedNotice(stdout: string, argv: readonly string[]): string {
  const flags = argv.includes("--") ? argv.slice(0, argv.indexOf("--")) : argv;
  if (flags.includes("--json")) {
    try {
      const parsed = JSON.parse(stdout) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        return `${JSON.stringify({ notice: RENAMED_WORDS, ...parsed }, null, 2)}\n`;
    } catch {
      // Not JSON: the line goes above it.
    }
  }
  return `notice: ${RENAMED_WORDS}\n${stdout}`;
}

export function captainAxi(
  version: string,
  connect: () => Promise<CaptainConnection>,
  cwd = process.cwd(),
): TaskAxiCli<CaptainConnection> {
  return {
    name: C,
    description: DESCRIPTION,
    version,
    commands: commands(cwd),
    home,
    connect,
  };
}

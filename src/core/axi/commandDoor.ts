import type { IncomingMessage, ServerResponse } from "node:http";
import { CORE_INVOKE_CHANNELS, type CoreInvokeChannel, invokeContract } from "@shared/ipc";
import { cutText } from "@shared/textCut";
import { z } from "zod";
import { asTheCommand } from "../askedFromTheCommand";
import { EventJournal, type JournalEntry, type JournalLimits } from "../connection/journal";
import { type CoreDispatch, VIEWER_CHANNELS } from "../dispatcher";
import type { CoreEventBus } from "../events";
import { INFINITARY_COMMAND, type Inbox } from "../integrations";
import { type AxiChannel, CaptainInvalid, type CaptainTool } from "./channel";
import type { CaptainOpInput } from "./protocol";

/**
 * The door `infinitary-axi` enters through (docs/axi-commands.md,
 * "Infinitary from your terminal"; INF-1894, from INF-1880's and INF-1893's
 * agreed plans): a request the connection's local door admitted by its key
 * runs as the captain, the actor the window on this computer has, in a
 * command process of its own (`AxiChannel.person`).
 *
 * The inbox's switch in Settings, Integrations, is the command's: off, it
 * refuses every verb and the notes stay. It reaches every core request a
 * view of this computer reaches - not a computer's work, not Secrets, and
 * not what only a window asks (`VIEWER_CHANNELS`), such as a task browser's
 * pictures - and reads and
 * changes as the captain (INF-1895): each request runs as the command's
 * (`asTheCommand`), so what it changes is recorded as the captain's from
 * the command. Every argument list is checked against the published
 * contract before it is sent.
 *
 * It keeps the pushes the core sends while the switch is on, in the
 * connection's own `EventJournal` bounded in bytes, so `watch` prints what
 * changed after a cursor, waits for the next change, and answers a cursor
 * from another run, from before the switch was off or older than it keeps
 * with `reloaded`.
 */

/** Whether `infinitary-axi` reaches a core request at all, read or change. */
export function commandReaches(channel: CoreInvokeChannel): boolean {
  return (
    invokeContract[channel].reach !== "work" &&
    !channel.includes("secret") &&
    // Only a window asks these: a task browser's pictures, and this computer's own window.
    !VIEWER_CHANNELS.has(channel)
  );
}

/** The pushes `watch` never prints: Secrets stay the window's alone. */
function watchSees(channel: string): boolean {
  return !channel.includes("secret") && channel !== "inf:browser:frame";
}

/** The core requests the command reaches, in the contract's order. */
export const COMMAND_CHANNELS: readonly CoreInvokeChannel[] =
  CORE_INVOKE_CHANNELS.filter(commandReaches);

/**
 * What the door keeps for `watch --after`: a short history, bounded in bytes
 * as the connection's own journal is, since a push can be a whole board.
 */
const WATCH_KEPT: JournalLimits = { entries: 256, bytes: 4 * 1024 * 1024 };
/** How long `watch` may wait: inside the minute a command process is given. */
const WATCH_WAIT_CEILING_MS = 50_000;
/** How many changes one `watch` answer prints; its cursor reads on. */
const WATCH_PAGE = 100;
/** How much of a push one change line shows, unless `--channel` asks for it whole. */
const SUMMARY_CHARS = 160;

/** One kept push as the journal holds it: when it came, and what it carried. */
type Kept = { at: number; payload: unknown };

/** One argument of a request, in words: its type and the contract's limits. */
function ruleOf(schema: Record<string, unknown>): { type: string; rule: string } {
  const parts: string[] = [];
  const type = Array.isArray(schema.enum)
    ? "string"
    : typeof schema.type === "string"
      ? schema.type
      : Array.isArray(schema.anyOf)
        ? (schema.anyOf as Record<string, unknown>[])
            .map((one) => String(one.type ?? one.const ?? "value"))
            .join(" or ")
        : "value";
  if (Array.isArray(schema.enum)) parts.push(`one of ${schema.enum.join(", ")}`);
  if (typeof schema.minLength === "number" && typeof schema.maxLength === "number")
    parts.push(`${schema.minLength} to ${schema.maxLength} characters`);
  else if (typeof schema.maxLength === "number")
    parts.push(`at most ${schema.maxLength} characters`);
  if (typeof schema.pattern === "string") parts.push(`matching ${schema.pattern}`);
  if (schema.type === "object" && schema.properties && typeof schema.properties === "object") {
    const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
    parts.push(
      `fields ${Object.keys(schema.properties)
        .map((name) => (required.has(name) ? name : `${name}?`))
        .join(", ")}`,
    );
  }
  return { type, rule: parts.join(" · ") };
}

/** A request's argument list as the contract publishes it. */
function argumentsOf(channel: CoreInvokeChannel): {
  required: number;
  rows: { position: number; type: string; rule: string }[];
} {
  const schema = z.toJSONSchema(invokeContract[channel].request, { io: "input" }) as Record<
    string,
    unknown
  >;
  const items = Array.isArray(schema.prefixItems)
    ? (schema.prefixItems as Record<string, unknown>[])
    : [];
  const declared = (invokeContract[channel].request as unknown as { _zod: { def: unknown } })._zod
    .def as { items?: readonly { _zod: { optin?: string } }[] };
  let required = declared.items?.length ?? items.length;
  while (required > 0 && declared.items?.[required - 1]?._zod.optin === "optional") required -= 1;
  return {
    required,
    rows: items.map((item, index) => ({ position: index + 1, ...ruleOf(item) })),
  };
}

/** A zod refusal as one line naming the argument's position. */
function refusalOf(error: z.ZodError, channel: string): string {
  const issue = error.issues[0];
  if (!issue) return `${channel} refused its arguments`;
  const [first, ...rest] = issue.path;
  const where =
    typeof first === "number"
      ? `argument ${first + 1}${rest.length > 0 ? ` (${rest.join(".")})` : ""}`
      : "the arguments";
  return `${channel}: ${where}: ${issue.message}`;
}

export type CommandDoorOptions = {
  channel: Pick<AxiChannel, "person">;
  dispatch: CoreDispatch;
  events: Pick<CoreEventBus, "subscribe">;
  /** The inbox, whose switch is the command's and whose notes `note` drops. */
  inbox: Pick<Inbox, "on" | "kept" | "door">;
  now?: () => number;
};

export class CommandDoor {
  private readonly now: () => number;
  /** The pushes, numbered from a fresh epoch each run; kept only while the switch is on. */
  private readonly journal = new EventJournal(WATCH_KEPT);
  private readonly waiting = new Set<() => void>();
  private readonly detach: () => void;
  /**
   * The switch, read once and again on each Integrations push, which every
   * change to it sends at once, so an ordinary push reads no file.
   */
  private on: boolean;

  constructor(private readonly options: CommandDoorOptions) {
    this.now = options.now ?? Date.now;
    this.on = options.inbox.on;
    this.detach = options.events.subscribe((channel, payload) => {
      if (!watchSees(channel)) return;
      if (channel === "inf:integrations") this.on = options.inbox.on;
      // Off, a push is numbered and nothing is kept, so a cursor from before reloads.
      const { on } = this;
      this.journal.record(
        () => (on ? JSON.stringify({ at: this.now(), payload } satisfies Kept) : ""),
        channel,
        on,
      );
      // A waiting watch answers a change, or `reloaded` once the switch went off.
      for (const wake of [...this.waiting]) wake();
    });
  }

  /** One request the local door admitted: as the captain while the switch is on. */
  readonly serve = (request: IncomingMessage, response: ServerResponse): void => {
    const { inbox } = this.options;
    void this.options.channel.person(
      request,
      response,
      inbox.on
        ? { captain: this.tool, inbox: inbox.door }
        : {
            refused: `${INFINITARY_COMMAND} is off in Settings → Integrations.`,
            // Notes stay only while they are kept: never before the first
            // turn-on, nor after Delete in Data (the captain's answer on F17).
            help: inbox.kept
              ? "Turn it on in Settings → Integrations; your saved notes stay"
              : "Turn it on in Settings → Integrations",
          },
    );
  };

  /** The app quits: nothing more is kept, and a waiting watch answers now. */
  close(): void {
    this.detach();
    for (const wake of [...this.waiting]) wake();
  }

  private readonly tool: CaptainTool = {
    "captain.request": (input) => this.request(input),
    "captain.channels": async (input) => this.channels(input),
    "captain.watch": (input) => this.watch(input),
  };

  private async request(
    input: CaptainOpInput["captain.request"],
  ): Promise<Record<string, unknown>> {
    const channel = String(input.channel ?? "") as CoreInvokeChannel;
    if (!Object.hasOwn(invokeContract, channel) || !CORE_INVOKE_CHANNELS.includes(channel))
      throw new CaptainInvalid(`${channel || "That"} is not a request of the published contract`);
    if (!commandReaches(channel))
      throw new Error(
        invokeContract[channel].reach === "work"
          ? `${channel} is asked only by a computer that runs work.`
          : `${channel} is answered only in the window.`,
      );
    const args = Array.isArray(input.args) ? input.args : [];
    const { required, rows } = argumentsOf(channel);
    if (args.length < required || args.length > rows.length)
      throw new CaptainInvalid(
        `${channel} takes ${required === rows.length ? required : `${required} to ${rows.length}`} argument${rows.length === 1 ? "" : "s"}, ${args.length} given`,
      );
    const parsed = invokeContract[channel].request.safeParse(args);
    if (!parsed.success) throw new CaptainInvalid(refusalOf(parsed.error, channel));
    const value = await asTheCommand(() =>
      this.options.dispatch(channel, parsed.data, { kind: "captain" }),
    );
    return { value: value as unknown };
  }

  private channels(input: CaptainOpInput["captain.channels"]): Record<string, unknown> {
    if (input.channel === undefined) {
      return {
        channels: COMMAND_CHANNELS.map((channel) => ({
          channel,
          effect: invokeContract[channel].effect,
          args: argumentsOf(channel).rows.length,
        })),
      };
    }
    const channel = input.channel as CoreInvokeChannel;
    if (!COMMAND_CHANNELS.includes(channel))
      throw new CaptainInvalid(
        `${input.channel} is not a request ${INFINITARY_COMMAND} reaches; list them with \`${INFINITARY_COMMAND} api list\``,
      );
    const { required, rows } = argumentsOf(channel);
    return { channel, effect: invokeContract[channel].effect, required, args: rows };
  }

  private async watch(input: CaptainOpInput["captain.watch"]): Promise<Record<string, unknown>> {
    const { journal } = this;
    const wanted = input.channels && input.channels.length > 0 ? new Set(input.channels) : null;
    const matches = (entry: JournalEntry) => !wanted || wanted.has(entry.channel);
    let from = journal.seq;
    let reloaded = false;
    if (input.after !== undefined) {
      const split = input.after.lastIndexOf("-");
      const cursor = {
        epoch: input.after.slice(0, split),
        seq: Number(input.after.slice(split + 1)),
      };
      if (split > 0 && Number.isInteger(cursor.seq) && journal.since(cursor) !== null)
        from = cursor.seq;
      else reloaded = true;
    }
    // Null once the switch went off or the kept bytes passed the cursor: a reload.
    const after = () => journal.since({ epoch: journal.epoch, seq: from });
    const waits = () => {
      const due = after();
      return due !== null && !due.some(matches);
    };
    if (!reloaded && waits()) {
      const waitMs = Math.max(0, Math.min(WATCH_WAIT_CEILING_MS, Number(input.waitMs) || 0));
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.waiting.delete(check);
          resolve();
        };
        const check = () => {
          if (!waits()) done();
        };
        const timer = setTimeout(done, waitMs);
        this.waiting.add(check);
      });
    }
    let due = after();
    if (due === null) {
      reloaded = true;
      from = journal.seq;
      due = [];
    }
    const page = due.filter(matches).slice(0, WATCH_PAGE);
    const last =
      page.length === WATCH_PAGE
        ? (page.at(-1)?.seq ?? journal.seq)
        : (due.at(-1)?.seq ?? Math.max(from, journal.seq));
    return {
      ...(reloaded ? { reloaded: true } : {}),
      cursor: `${journal.epoch}-${last}`,
      changes: page.map((entry) => {
        const kept = JSON.parse(entry.frame) as Kept;
        const text = JSON.stringify(kept.payload) ?? "null";
        return {
          cursor: `${journal.epoch}-${entry.seq}`,
          channel: entry.channel,
          at: new Date(kept.at).toISOString(),
          ...(input.full
            ? { payload: kept.payload }
            : {
                summary:
                  text.length > SUMMARY_CHARS
                    ? `${cutText(text, SUMMARY_CHARS)}… (${text.length - SUMMARY_CHARS} more characters)`
                    : text,
              }),
        };
      }),
      more: due.filter(matches).length > page.length,
    };
  }
}

/**
 * The door a booted core's connection serves at `COMMAND_PATH`, or none
 * when the core has no command process to run it in. The app and the
 * command's own tests open it here, so both serve the same door.
 */
export function openCommandDoor(core: {
  dispatch: CoreDispatch;
  events: Pick<CoreEventBus, "subscribe">;
  services: {
    taskCommands?: Pick<AxiChannel, "person">;
    integrationInbox: Pick<Inbox, "on" | "kept" | "door">;
  };
}): CommandDoor | undefined {
  const channel = core.services.taskCommands;
  return channel
    ? new CommandDoor({
        channel,
        dispatch: core.dispatch,
        events: core.events,
        inbox: core.services.integrationInbox,
      })
    : undefined;
}

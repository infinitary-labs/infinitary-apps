import { randomBytes } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { IntegrationDoorView } from "@shared/integrations";
import { AXI_KEY_HEADER } from "../../axi/protocol";
import type { IntegrationBinding, IntegrationEventItem, IntegrationEventSpec } from "../binding";
import { INBOX_COMMAND } from "../commandWords";

/**
 * The inbox (docs/integrations.md, "The inbox"; INF-1214, direction A): a
 * door a person's own program on this computer drops a freeform event
 * through, and an integration kind whose one event an Automation rule
 * listens to, so the first mate wakes on it as evidence from outside, never
 * an instruction.
 *
 * Its folder, `userData/integrations/inbox/` (0700), holds the person key
 * as the one header line the launcher's curl sends (`key`, 0600), the
 * running app's loopback address while it is open (`address`, 0600), and a
 * log of what happened (`events.jsonl`, 0600): each event as it was
 * recorded, and each handled mark once a first mate turn handled the rule's
 * delivery that carried it. A line's `seq` is its place in the log: a look
 * reads events after a cursor of it, and a receipts read lists lines after
 * one. The key lets a program drop an event and read receipts, nothing
 * more; the channel admits it for `infinitary-inbox-axi` alone.
 */

/** The one event the inbox tells. */
export const INBOX_EVENT: IntegrationEventSpec = {
  name: "event_arrived",
  label: "An event arrives",
  description:
    "Each event a program on this computer drops into the inbox with infinitary-inbox-axi; the summary is where it came from, when the program named it, and its words.",
  every: 1,
  atOnce: true,
};

/** The label an event's words reach every agent under (docs/integrations.md, "Data from outside"). */
export const INBOX_FENCE = "inbox-data";

/** The inbox's one connection id, and its folder's name under the integrations folder. */
export const INBOX_ID = "inbox";

/** How many receipts one read answers; its `next` cursor reads on. */
const RECEIPTS_PAGE = 100;

/** A request id or a source as a program names it: one short word of safe characters. */
const WORD = /^[A-Za-z0-9._:@/+-]{1,128}$/;

type EventLine = {
  seq: number;
  type: "event";
  id: string;
  at: number;
  text: string;
  request_id?: string;
  source?: string;
};
type HandledLine = { seq: number; type: "handled"; id: string; at: number };
type Line = EventLine | HandledLine;

/** What a drop answers at once: the event's id and whether this drop recorded it. */
export type InboxReceipt = {
  event: string;
  recorded: boolean;
  /** The request id was seen before: the earlier event's id, recorded once. */
  duplicate?: true;
  /** How many turned-on rules listen; none means nothing wakes the first mate. */
  listening: number;
};

/** One line of the receipts read. */
export type InboxReceiptLine = {
  seq: number;
  event: string;
  state: "recorded" | "handled";
  at: string;
  request_id?: string;
  source?: string;
};

/** What a program may ask of the inbox through its door: drop, read receipts, read how it stands. */
export type InboxDoor = {
  note: (input: { text: string; requestId?: string; source?: string }) => InboxReceipt;
  receipts: (after: number) => { receipts: InboxReceiptLine[]; cursor: number; more: boolean };
  status: () => { on: boolean; events: number; handled: number; listening: number };
};

/** What the inbox asks of Automation: a look now, how many rules listen, and its rule added. */
export type InboxWake = {
  dropped: () => void;
  listening: () => number;
  added: (say?: (text: string) => void) => void;
};

/** Where the channel admits the person key and where the launcher finds the app. */
export type InboxChannel = {
  address: string;
  admit: (key: string, door: InboxDoor) => void;
  shut: () => void;
};

export type InboxOptions = {
  /** `userData/integrations/inbox`. */
  dir: string;
  /** The launcher's `infinitary-inbox-axi` link in the app's `axi-bin` folder. */
  command: string;
  /**
   * The folder the launcher finds the inbox in when nothing names one: the
   * release's (`launcherDefaultDir`). A run whose folder is elsewhere names
   * it in the line to copy.
   */
  defaultDir: string;
  /** The folder the one-click link goes into (`/usr/local/bin`). */
  linkDir: string;
  /** A folder whose link the Linux packages install, read only (`/usr/bin`). */
  installedDir?: string;
  now?: () => number;
};

/**
 * The folder the launcher reads when `INFINITARY_INBOX` names none: the
 * release's own data folder, `~/Library/Application Support/infinitary` on
 * a Mac and `$XDG_CONFIG_HOME/infinitary` (or `~/.config`) on Linux, as
 * `resources/axi-bin/infinitary-axi` writes it.
 */
export function launcherDefaultDir(platform: string, home: string, xdgConfigHome?: string): string {
  const appData =
    platform === "darwin"
      ? join(home, "Library", "Application Support")
      : xdgConfigHome?.trim() || join(home, ".config");
  return join(appData, "infinitary", "integrations", INBOX_ID);
}

/** A path as a POSIX shell reads it inside single quotes. */
function quoted(path: string): string {
  return `'${path.split("'").join(`'\\''`)}'`;
}

export class Inbox {
  private readonly now: () => number;
  private channel: InboxChannel | undefined;
  /** Late-bound: the Scheduler is built after the integrations. */
  private wake: InboxWake = {
    dropped: () => {},
    listening: () => 0,
    added: () => {},
  };

  constructor(private readonly options: InboxOptions) {
    this.now = options.now ?? Date.now;
  }

  get on(): boolean {
    return this.key() !== undefined;
  }

  /** The Scheduler's look at once after a drop, how many rules listen, and the rule turning on adds. */
  wakeThrough(wake: InboxWake): void {
    this.wake = wake;
  }

  /**
   * The captain turned the inbox on from Settings: its rule is added and
   * turned on with it, unless a rule on the inbox is already there.
   */
  added(say?: (text: string) => void): void {
    if (this.on) this.wake.added(say);
  }

  /** The channel is open: admit the key, and tell the launcher where the app is. */
  serve(channel: InboxChannel): void {
    this.channel = channel;
    this.open();
  }

  /** Turn the inbox on: a new key once, kept until it is turned off. */
  turnOn(): string {
    if (!this.on) {
      this.folder();
      const key = randomBytes(32).toString("hex");
      writeFileSync(this.path("key"), `${AXI_KEY_HEADER}: ${key}\n`, { mode: 0o600 });
      chmodSync(this.path("key"), 0o600);
    }
    this.open();
    return INBOX_ID;
  }

  /** Turn it off: the door shuts, and the key, the address and the log go. */
  turnOff(): void {
    this.channel?.shut();
    rmSync(this.options.dir, { recursive: true, force: true });
  }

  /** The app quits: nothing more is admitted, and no address points at a closed app. */
  close(): void {
    this.channel?.shut();
    this.channel = undefined;
    rmSync(this.path("address"), { force: true });
  }

  /** A first mate turn handled the delivery that carried these events. */
  handled(ids: readonly string[], at: number): void {
    if (!this.on) return;
    const lines = this.lines();
    const recorded = new Set(lines.flatMap((line) => (line.type === "event" ? [line.id] : [])));
    const done = new Set(lines.flatMap((line) => (line.type === "handled" ? [line.id] : [])));
    let seq = lines.at(-1)?.seq ?? 0;
    for (const id of ids) {
      if (!recorded.has(id) || done.has(id)) continue;
      done.add(id);
      seq += 1;
      this.append({ seq, type: "handled", id, at });
    }
  }

  /** What a program asks through its door. */
  readonly door: InboxDoor = {
    note: (input) => this.note(input),
    receipts: (after) => this.receipts(after),
    status: () => {
      const lines = this.on ? this.lines() : [];
      return {
        on: this.on,
        events: lines.filter((line) => line.type === "event").length,
        handled: lines.filter((line) => line.type === "handled").length,
        listening: this.wake.listening(),
      };
    },
  };

  /** What Settings shows: the line to copy, and the link a click can make. */
  doorView(): IntegrationDoorView {
    const { command, defaultDir, linkDir, installedDir } = this.options;
    const named =
      this.options.dir === defaultDir ? "" : `INFINITARY_INBOX=${quoted(this.options.dir)} `;
    const line = `${named}${quoted(command)} note "Deploy finished"`;
    const installed = installedDir ? join(installedDir, INBOX_COMMAND) : undefined;
    if (installed && this.leadsHere(installed))
      return { command, line, link: { state: "linked", path: installed } };
    const path = join(linkDir, INBOX_COMMAND);
    if (this.leadsHere(path)) return { command, line, link: { state: "linked", path } };
    if (this.exists(path)) return { command, line, link: { state: "taken", path } };
    return {
      command,
      line,
      link: { state: this.writable(linkDir) ? "offered" : "unwritable", path },
    };
  }

  /** The one-click link into the link folder, only where it is free and writable. */
  link(): void {
    const view = this.doorView();
    if (view.link.state === "linked") return;
    if (view.link.state === "taken")
      throw new Error(
        `${view.link.path} is already something else, so Infinitary left it as it is.`,
      );
    if (view.link.state === "unwritable")
      throw new Error(
        `${this.options.linkDir} cannot be written to without an administrator, so use the full path.`,
      );
    symlinkSync(this.options.command, view.link.path);
  }

  /** The binding Settings, the first mate and Automation reach the inbox through. */
  binding(): IntegrationBinding {
    return {
      kind: "inbox",
      fence: INBOX_FENCE,
      connections: () =>
        this.on
          ? [
              {
                id: INBOX_ID,
                account: null,
                health: "ok",
                actions: [],
                events: [INBOX_EVENT],
                door: this.doorView(),
              },
            ]
          : [],
      // Turning it on has nothing to wait for: no browser, no place to ask.
      signIn: async () => this.turnOn(),
      check: async () => {},
      remove: () => this.turnOff(),
      call: async () => ({
        text: "The inbox has no actions: an event arrives through infinitary-inbox-axi, and a rule listens to it.",
        refused: "invalid",
      }),
      look: async (_id, _event, cursor) => this.look(cursor),
      close: async () => this.close(),
    };
  }

  private look(cursor: string | null): {
    cursor: string;
    items: IntegrationEventItem[];
    resynced?: boolean;
  } {
    const lines = this.on ? this.lines() : [];
    const last = String(lines.at(-1)?.seq ?? 0);
    if (cursor === null) return { cursor: last, items: [] };
    const from = Number(cursor);
    if (!Number.isInteger(from) || from > Number(last))
      return { cursor: last, items: [], resynced: true };
    return {
      cursor: last,
      items: lines.flatMap((line) =>
        line.type === "event" && line.seq > from ? [{ id: line.id, summary: summaryOf(line) }] : [],
      ),
    };
  }

  private note(input: { text: string; requestId?: string; source?: string }): InboxReceipt {
    if (!this.on) throw new Error("The inbox is off: turn it on in Settings → Integrations.");
    const text = input.text.trim();
    if (!text) throw new Error("An event needs words.");
    for (const [name, value] of [
      ["request id", input.requestId],
      ["source", input.source],
    ] as const)
      if (value !== undefined && !WORD.test(value))
        throw new Error(
          `The ${name} is one word of letters, digits and . _ : @ / + -, at most 128.`,
        );
    const lines = this.lines();
    const listening = this.wake.listening();
    const earlier =
      input.requestId === undefined
        ? undefined
        : lines.find((line) => line.type === "event" && line.request_id === input.requestId);
    if (earlier) return { event: earlier.id, recorded: false, duplicate: true, listening };
    const event: EventLine = {
      seq: (lines.at(-1)?.seq ?? 0) + 1,
      type: "event",
      id: `ev-${randomBytes(6).toString("hex")}`,
      at: this.now(),
      text,
      ...(input.requestId !== undefined ? { request_id: input.requestId } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
    };
    this.append(event);
    // A bridge expects its answer in seconds: the rules look now, not at the next minute.
    this.wake.dropped();
    return { event: event.id, recorded: true, listening };
  }

  private receipts(after: number): { receipts: InboxReceiptLine[]; cursor: number; more: boolean } {
    if (!this.on) throw new Error("The inbox is off: turn it on in Settings → Integrations.");
    const lines = this.lines();
    const events = new Map(
      lines.flatMap((line) => (line.type === "event" ? [[line.id, line] as const] : [])),
    );
    const due = lines.filter((line) => line.seq > after);
    const page = due.slice(0, RECEIPTS_PAGE);
    return {
      receipts: page.map((line) => {
        const event = events.get(line.id);
        return {
          seq: line.seq,
          event: line.id,
          state: line.type === "event" ? "recorded" : "handled",
          at: new Date(line.at).toISOString(),
          ...(event?.request_id !== undefined ? { request_id: event.request_id } : {}),
          ...(event?.source !== undefined ? { source: event.source } : {}),
        };
      }),
      cursor: page.at(-1)?.seq ?? after,
      more: due.length > page.length,
    };
  }

  /** Admit the key and write the address, while the channel is open and the inbox on. */
  private open(): void {
    const key = this.key();
    if (!this.channel || key === undefined) return;
    this.channel.admit(key, this.door);
    writeFileSync(this.path("address"), `${this.channel.address}\n`, { mode: 0o600 });
    chmodSync(this.path("address"), 0o600);
  }

  private key(): string | undefined {
    try {
      const line = readFileSync(this.path("key"), "utf8");
      const [header, key] = line.trim().split(": ");
      return header === AXI_KEY_HEADER && key && /^[0-9a-f]{64}$/.test(key) ? key : undefined;
    } catch {
      return undefined;
    }
  }

  private lines(): Line[] {
    let text: string;
    try {
      text = readFileSync(this.path("events.jsonl"), "utf8");
    } catch {
      return [];
    }
    return text.split("\n").flatMap((raw) => {
      if (!raw.trim()) return [];
      try {
        return [JSON.parse(raw) as Line];
      } catch {
        // A line cut by a crash mid-write is not an event.
        return [];
      }
    });
  }

  private append(line: Line): void {
    this.folder();
    appendFileSync(this.path("events.jsonl"), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  }

  private folder(): void {
    mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.options.dir, 0o700);
  }

  private path(name: string): string {
    return join(this.options.dir, name);
  }

  private leadsHere(path: string): boolean {
    try {
      return lstatSync(path).isSymbolicLink() && readlinkSync(path) === this.options.command;
    } catch {
      return false;
    }
  }

  private exists(path: string): boolean {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  }

  private writable(dir: string): boolean {
    if (!existsSync(dir)) return false;
    try {
      accessSync(dir, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
}

/** An event in one line: where it came from, when a program named it, and its words. */
function summaryOf(line: EventLine): string {
  const words = line.text.replace(/\s+/g, " ").trim();
  return line.source ? `from ${line.source}: ${words}` : words;
}

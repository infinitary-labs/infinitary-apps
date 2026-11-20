import { createHash, randomBytes } from "node:crypto";
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
import { escapeHtml } from "@shared/cardBodyMarkup";
import { type Card, FIRSTMATE_CARD_META } from "@shared/cards";
import { formatDateTime } from "@shared/i18n/format";
import { INBOX_WORDS, type IntegrationDoorView } from "@shared/integrations";
import { AXI_KEY_HEADER } from "../../axi/protocol";
import type { IntegrationBinding, IntegrationEventItem, IntegrationEventSpec } from "../binding";
import { INFINITARY_COMMAND } from "../commandWords";

/**
 * The inbox (docs/integrations.md, "The inbox"; INF-1214, direction A): a
 * door a person's own program on this computer drops a freeform event
 * through, and an integration kind whose one event an Automation rule
 * listens to, so the first mate wakes on it as evidence from outside, never
 * an instruction.
 *
 * Since `infinitary-axi` (INF-1894) the inbox is that command's switch and
 * its notes: a program drops an event with `infinitary-axi note`, which
 * enters through the connection's local door like every other verb
 * (docs/axi-commands.md, "Infinitary from your terminal"), and the inbox
 * answers it through `door`.
 *
 * Its folder, `userData/integrations/inbox/` (0700), holds the mark that it
 * was turned on (`key`, 0600, the inbox's own door key before the command,
 * which admits nothing now) and a log of what happened (`events.jsonl`,
 * 0600): each event as it was recorded, and each handled mark once a first
 * mate turn handled the rule's delivery that carried it. A line's `seq` is
 * its place in the log: a look reads events after a cursor of it, and a
 * receipts read lists lines after one. Once something ran the command's
 * old name, `infinitary-inbox-axi`, it also holds when that last happened
 * and from which folder (`old-name.json`, 0600), which Settings shows,
 * and each folder whose run raised the warning note (`old-name-warned.json`).
 *
 * The switch in Settings is the connection's pause (INF-1567, the
 * captain's direction C): off, the command refuses and the rule is told
 * nothing, while the mark and the log stay. Deleting, in Settings'
 * Data section, removes the folder.
 */

/** The one event the inbox tells. */
export const INBOX_EVENT: IntegrationEventSpec = {
  name: "event_arrived",
  label: "An event arrives",
  description:
    "Each event a program on this computer drops into the inbox with infinitary-axi note; the summary is where it came from, when the program named it, and its words.",
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

/** What a program may ask of the inbox through its door: drop, and read receipts. */
export type InboxDoor = {
  note: (input: { text: string; requestId?: string; source?: string }) => InboxReceipt;
  receipts: (after: number) => { receipts: InboxReceiptLine[]; cursor: number; more: boolean };
  /** The door ran the command's old name from this working folder: kept as its last use. */
  oldNameRan: (cwd: string) => void;
};

/** What the inbox asks of Automation: a look now, how many rules listen, and its rule added. */
export type InboxWake = {
  dropped: () => void;
  listening: () => number;
  added: (say?: (text: string) => void) => void;
};

/**
 * The old name's warning, as the host raises it: a card the host authors
 * with one button, so it wears the attention badge (the captain's reply on
 * INF-3904), one per folder under an id the folder names.
 */
export type OldNameWarning = Pick<Card, "id" | "title" | "meta" | "body" | "actions">;

/** The card for a recorded run of the old name: when, where, and what to change. */
export function oldNameWarning(run: { at: number; cwd: string }): OldNameWarning {
  const words = INBOX_WORDS.oldNameWarning;
  const when = formatDateTime(run.at, { dateStyle: "medium", timeStyle: "short" });
  const mono = (text: string) => `<span class="inf-mono">${escapeHtml(text)}</span>`;
  const folder = createHash("sha256").update(run.cwd).digest("hex").slice(0, 16);
  return {
    id: `card-old-command-name-${folder}`,
    title: words.title,
    meta: FIRSTMATE_CARD_META,
    body: [
      `<p>${words.ran(mono("infinitary-inbox-axi"), escapeHtml(when), mono(run.cwd))}</p>`,
      `<p>${words.change(mono(INFINITARY_COMMAND))}</p>`,
    ].join("\n"),
    actions: [{ id: "got-it", label: words.gotIt, variant: "primary", default: true }],
  };
}

export type InboxOptions = {
  /** `userData/integrations/inbox`. */
  dir: string;
  /** The app's data folder, whose local door the command enters through. */
  dataDir: string;
  /** The launcher's `infinitary-axi` name in the app's `axi-bin` folder. */
  command: string;
  /**
   * The data folder the launcher reads when nothing names one: the
   * release's (`launcherDataDir`). A run whose folder is elsewhere names
   * it in the line to copy.
   */
  defaultDataDir: string;
  /** The folder the one-click link goes into (`/usr/local/bin`). */
  linkDir: string;
  /** A folder whose link the Linux packages install, read only (`/usr/bin`). */
  installedDir?: string;
  /** What Settings shows changed, such as the old name's last use: push the integrations' view. */
  changed?: () => void;
  now?: () => number;
};

/**
 * The data folder the launcher reads when `INFINITARY_DATA` names none: the
 * release's own, `~/Library/Application Support/infinitary` on a Mac and
 * `$XDG_CONFIG_HOME/infinitary` (or `~/.config`) on Linux, as
 * `resources/axi-bin/infinitary-axi` writes it.
 */
export function launcherDataDir(platform: string, home: string, xdgConfigHome?: string): string {
  const appData =
    platform === "darwin"
      ? join(home, "Library", "Application Support")
      : xdgConfigHome?.trim() || join(home, ".config");
  return join(appData, "infinitary");
}

/** A path as a POSIX shell reads it inside single quotes. */
function quoted(path: string): string {
  return `'${path.split("'").join(`'\\''`)}'`;
}

export class Inbox {
  private readonly now: () => number;
  /** Late-bound: the Scheduler is built after the integrations. */
  private wake: InboxWake = {
    dropped: () => {},
    listening: () => 0,
    added: () => {},
  };
  /** Late-bound: whether the connection is paused, which the integrations' settings hold. */
  private paused: () => boolean = () => false;
  /** Late-bound: raise the old name's warning card; its folder is kept once that returns. */
  private warn?: (card: OldNameWarning) => void;

  constructor(private readonly options: InboxOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Turned on once and not deleted since: the key and the log are kept. */
  get kept(): boolean {
    return this.key() !== undefined;
  }

  /** Kept and not switched off: the door takes notes. */
  get on(): boolean {
    return this.kept && !this.paused();
  }

  /** Whether the person switched the inbox off, as the integrations' settings say. */
  pausedThrough(paused: () => boolean): void {
    this.paused = paused;
  }

  /**
   * The old name's warning (docs/integrations.md, "The inbox"): a run of
   * `infinitary-inbox-axi` the inbox recorded raises a card that the next
   * version removes that name, once per folder it ran from. Bound once the
   * cards exist; a run recorded by an earlier version is looked at now. A
   * raise that throws keeps the folder unwarned, so the next run or start
   * raises it again, and the run itself still answers.
   */
  warnOldNameThrough(warn: (card: OldNameWarning) => void): void {
    this.warn = warn;
    this.lookOldName();
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
    if (this.kept) this.wake.added(say);
  }

  /** Turn the inbox on: its mark once, kept until it is deleted. */
  turnOn(): string {
    if (!this.kept) {
      this.folder();
      const key = randomBytes(32).toString("hex");
      writeFileSync(this.path("key"), `${AXI_KEY_HEADER}: ${key}\n`, { mode: 0o600 });
      chmodSync(this.path("key"), 0o600);
    }
    return INBOX_ID;
  }

  /** Delete it: the mark and the log go, so the command is off. */
  delete(): void {
    rmSync(this.options.dir, { recursive: true, force: true });
  }

  /**
   * The app quits. The inbox's own door kept its address here before the
   * command entered through the local door; a run that quits removes it.
   */
  close(): void {
    rmSync(this.path("address"), { force: true });
  }

  /** A first mate turn handled the delivery that carried these events. */
  handled(ids: readonly string[], at: number): void {
    if (!this.kept) return;
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
    oldNameRan: (cwd) => this.oldNameRan(cwd),
  };

  /** What Settings shows: the line to copy, and the link a click can make. */
  doorView(): IntegrationDoorView {
    const { command, dataDir, defaultDataDir, linkDir, installedDir } = this.options;
    const named = dataDir === defaultDataDir ? "" : `INFINITARY_DATA=${quoted(dataDir)} `;
    const line = `${named}${quoted(command)}`;
    const oldName = this.oldName();
    const seen = { command, line, ...(oldName ? { oldName } : {}) };
    const installed = installedDir ? join(installedDir, INFINITARY_COMMAND) : undefined;
    if (installed && this.leadsHere(installed))
      return { ...seen, link: { state: "linked", path: installed } };
    const path = join(linkDir, INFINITARY_COMMAND);
    if (this.leadsHere(path)) return { ...seen, link: { state: "linked", path } };
    if (this.exists(path)) return { ...seen, link: { state: "taken", path } };
    return {
      ...seen,
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
      // Switched off, the connection stays, paused, so the switch can turn it back on.
      connections: () =>
        this.kept
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
      remove: () => this.delete(),
      call: async () => ({
        text: `The inbox has no actions: an event arrives through ${INFINITARY_COMMAND} note, and a rule listens to it.`,
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
    const lines = this.kept ? this.lines() : [];
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
    if (!this.on)
      throw new Error(`${INFINITARY_COMMAND} is off: turn it on in Settings → Integrations.`);
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
    if (!this.on)
      throw new Error(`${INFINITARY_COMMAND} is off: turn it on in Settings → Integrations.`);
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

  /**
   * The old name's last use, kept while the inbox is: only its newest run,
   * so the file never grows, and Delete in Data removes it with the rest.
   */
  private oldNameRan(cwd: string): void {
    if (!this.kept) return;
    this.folder();
    const record = { at: this.now(), cwd: cwd.slice(0, 4096) };
    writeFileSync(this.path("old-name.json"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    this.options.changed?.();
    this.lookOldName();
  }

  /** The newest recorded run, warned about unless its folder already was. */
  private lookOldName(): void {
    const run = this.oldName();
    if (!this.warn || !run || this.warnedFolders().includes(run.cwd)) return;
    try {
      this.warn(oldNameWarning(run));
    } catch {
      // The card did not go up: the folder stays unwarned, and the run still answers.
      return;
    }
    const folders = [...this.warnedFolders(), run.cwd];
    writeFileSync(this.path("old-name-warned.json"), `${JSON.stringify(folders)}\n`, {
      mode: 0o600,
    });
  }

  /** The folders a warning was raised for, kept with the inbox; Delete in Data removes them. */
  private warnedFolders(): string[] {
    try {
      const folders = JSON.parse(
        readFileSync(this.path("old-name-warned.json"), "utf8"),
      ) as unknown;
      return Array.isArray(folders)
        ? folders.filter((folder): folder is string => typeof folder === "string")
        : [];
    } catch {
      return [];
    }
  }

  private oldName(): { at: number; cwd: string } | undefined {
    try {
      const record = JSON.parse(readFileSync(this.path("old-name.json"), "utf8")) as unknown;
      if (
        record &&
        typeof record === "object" &&
        "at" in record &&
        "cwd" in record &&
        typeof record.at === "number" &&
        typeof record.cwd === "string"
      )
        return { at: record.at, cwd: record.cwd };
    } catch {
      // Never run, or a record cut by a crash mid-write: nothing to show.
    }
    return undefined;
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

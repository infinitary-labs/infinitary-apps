import {
  PANEL_FAILING_ANSWER_MAX,
  type PanelFailingRead,
  type PanelRead,
} from "@shared/personal/manifest";
import { cutText } from "@shared/textCut";
import { LOOKS_FAILING_LOOKS, LOOKS_FAILING_TICKS } from "../orchestrator/scheduler";

/**
 * The reads of the captain's panels that keep failing (docs/personal-panels.md,
 * "Reads that keep failing"): one row per read - a background job of its own,
 * an integration action it calls, an integration event it listens for - kept
 * in memory from the failures the app sees itself. A failure adds a try; the
 * first time that read works its row goes. Whether a panel's numbers look old
 * is never judged here.
 *
 * A row is failing on the automation's own rule (docs/automation.md, "When
 * every look fails"): at least `LOOKS_FAILING_LOOKS` failures whose span,
 * each counting for its whole cadence, reaches `LOOKS_FAILING_TICKS` of the
 * app's tick period, an hour on the minute tick. Its listeners hear once, at
 * the failure that turns it failing.
 */

/** A read by what the app knows of it: an integration by its id, which a rename does not move. */
export type PanelReadNoted =
  | { kind: "background"; task: string }
  | { kind: "call"; integration: string; place: string; action: string }
  | { kind: "event"; integration: string; place: string; event: string };

type Row = {
  read: PanelRead;
  since: number;
  last: number;
  /** The read's cadence: a failure stands for its whole span. 0 for a call, which has none. */
  every: number;
  tries: number;
  answer: string;
  /** Its listeners heard it turn failing. */
  told: boolean;
  /** The captain pressed Ask the first mate while it was failing. */
  asked: boolean;
};

/** A row that just turned failing, as its listeners hear it. */
export type PanelReadTurnedFailing = { panel: string; key: string; failing: PanelFailingRead };

export type PanelReadFailuresOptions = {
  now: () => number;
  /** The app's tick period: a development or end-to-end run's shorter one shortens the hour. */
  periodMs: number;
};

function keyOf(read: PanelReadNoted): string {
  if (read.kind === "background") return `background\u0000${read.task}`;
  if (read.kind === "call") return `call\u0000${read.integration}\u0000${read.action}`;
  return `event\u0000${read.integration}\u0000${read.event}`;
}

function shownOf(read: PanelReadNoted): PanelRead {
  if (read.kind === "background") return { kind: "background", task: read.task };
  if (read.kind === "call") return { kind: "call", place: read.place, action: read.action };
  return { kind: "event", place: read.place, event: read.event };
}

export class PanelReadFailures {
  /** Rows by panel key (`source:id`), then by read. */
  private readonly rows = new Map<string, Map<string, Row>>();
  private readonly changeListeners = new Set<() => void>();
  private readonly failingListeners = new Set<(turned: PanelReadTurnedFailing) => void>();

  constructor(private readonly options: PanelReadFailuresOptions) {}

  private get windowMs(): number {
    return LOOKS_FAILING_TICKS * this.options.periodMs;
  }

  /** One failed read: the panel's own words or the place's answer, cut short. */
  failed(panel: string, read: PanelReadNoted, answer: string, everyMs = 0): void {
    const now = this.options.now();
    const key = keyOf(read);
    const rows = this.rows.get(panel) ?? new Map<string, Row>();
    const row = rows.get(key) ?? {
      read: shownOf(read),
      since: now,
      last: now,
      every: everyMs,
      tries: 0,
      answer: "",
      told: false,
      asked: false,
    };
    row.read = shownOf(read);
    row.tries += 1;
    row.last = now;
    row.every = everyMs;
    row.answer = cutText(answer, PANEL_FAILING_ANSWER_MAX);
    rows.set(key, row);
    this.rows.set(panel, rows);
    const turned = !row.told && this.isFailing(row);
    if (turned) row.told = true;
    // A row still counting changes nothing anyone sees; one that is failing
    // shows its newest try and answer.
    if (row.told) this.changed();
    if (turned) {
      const failing = this.failingOf(row);
      for (const listener of this.failingListeners) listener({ panel, key, failing });
    }
  }

  /** The read worked: its row goes, and the mark with it once no other row is failing. */
  worked(panel: string, read: PanelReadNoted): void {
    const rows = this.rows.get(panel);
    const row = rows?.get(keyOf(read));
    if (!rows || !row) return;
    rows.delete(keyOf(read));
    if (rows.size === 0) this.rows.delete(panel);
    if (row.told) this.changed();
  }

  /** Each of the panel's failing reads, oldest first. */
  failing(panel: string): PanelFailingRead[] {
    return [...(this.rows.get(panel)?.values() ?? [])]
      .filter((row) => row.told)
      .sort((a, b) => a.since - b.since)
      .map((row) => this.failingOf(row));
  }

  /**
   * The captain's Ask the first mate: every failing row of the panel not yet
   * asked about is marked asked, and those rows are answered for the first
   * mate to hear once. Empty, telling no one, when every one was asked.
   */
  ask(panel: string): PanelFailingRead[] {
    const asked = [...(this.rows.get(panel)?.values() ?? [])].filter(
      (row) => row.told && !row.asked,
    );
    for (const row of asked) row.asked = true;
    if (asked.length > 0) this.changed();
    return asked.sort((a, b) => a.since - b.since).map((row) => this.failingOf(row));
  }

  /** The panel's code changed or it left: its rows start again from nothing. */
  forget(panel: string): void {
    const rows = this.rows.get(panel);
    if (!rows) return;
    this.rows.delete(panel);
    if ([...rows.values()].some((row) => row.told)) this.changed();
  }

  /** Any panel's failing reads changed: the snapshot is pushed again. */
  subscribe(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /** A row turned failing, heard once per row. */
  onFailing(listener: (turned: PanelReadTurnedFailing) => void): () => void {
    this.failingListeners.add(listener);
    return () => {
      this.failingListeners.delete(listener);
    };
  }

  /** Each failure stands for its whole cadence, read at the newest failure. */
  private isFailing(row: Row): boolean {
    return row.tries >= LOOKS_FAILING_LOOKS && row.last - row.since + row.every >= this.windowMs;
  }

  private failingOf(row: Row): PanelFailingRead {
    return {
      read: row.read,
      since: new Date(row.since).toISOString(),
      tries: row.tries,
      answer: row.answer,
      asked: row.asked,
    };
  }

  private changed(): void {
    for (const listener of this.changeListeners) listener();
  }
}

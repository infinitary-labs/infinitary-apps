import type {
  PanelFailingRead,
  PersonalExtensionView,
  PluginSource,
} from "@shared/personal/manifest";
import type { PanelCaller } from "../integrations";
import type {
  PanelReadFailures,
  PanelReadNoted,
  PanelReadTurnedFailing,
} from "./panelReadFailures";

/** A read of the captain's panel that just turned failing, as the first mate hears it once. */
export type PanelFailingTold = {
  id: string;
  title: string;
  /** Its code's version: the once key names it, so new code is heard afresh. */
  version: string;
  /** The read's own key within the panel. */
  read: string;
  failing: PanelFailingRead;
};

/** The captain's Ask the first mate on a panel's failing reads. */
export type PanelFailingAsk = { id: string; title: string; failing: PanelFailingRead[] };

/**
 * The reads of the captain's own panels that keep failing
 * (docs/personal-panels.md, "Reads that keep failing"): the count, and
 * where the first mate hears a read turn failing and the captain's Ask the
 * first mate.
 */
export type PanelFailingReadsOptions = {
  failures: PanelReadFailures;
  tell: (told: PanelFailingTold) => void;
  ask: (ask: PanelFailingAsk) => void;
};

/** What the count reads of a panel the panels service holds. */
export type CountedPanel = {
  id: string;
  source: PluginSource;
  runbook: string | null;
  slice: string;
  serverHash: string | null;
  panel: { hash: string } | null;
  manifest: { title?: string | undefined };
};

/**
 * The panels service's side of the count: whose reads count, which code they
 * were counted against, and what its snapshot and first mate hear. The
 * count itself is `PanelReadFailures`'.
 */
export class PanelReadCounting {
  /**
   * The drawing each counted panel's failing reads were counted against, by
   * panel key: a new drawing, new background code (`restart`) or a panel
   * gone (`drop`) starts them over.
   */
  private readonly drawings = new Map<string, string>();

  constructor(
    private readonly options: PanelFailingReadsOptions | undefined,
    private readonly panels: {
      /** The panels on the rails now. */
      loaded: () => Iterable<CountedPanel>;
      get: (id: string) => CountedPanel | undefined;
      keyOf: (panel: Pick<CountedPanel, "source" | "id" | "runbook" | "slice">) => string;
      isLive: (slice: string) => boolean;
    },
  ) {}

  /** Any panel's failing reads changed, or a read turned failing and the first mate hears it. */
  watch(changed: () => void): (() => void)[] {
    const failures = this.options?.failures;
    if (!failures) return [];
    return [failures.subscribe(changed), failures.onFailing((turned) => this.turned(turned))];
  }

  /**
   * Whose reads are counted: the captain's own panels on the rail. A draft
   * shares its panel's key but is still being built; a panel added from
   * elsewhere, or a runbook's, is its maker's to fix.
   */
  counted(panel: CountedPanel): boolean {
    return (
      this.options !== undefined &&
      panel.source === "yours" &&
      panel.runbook === null &&
      this.panels.isLive(panel.slice)
    );
  }

  /** What a counted panel's integration calls and event looks report to (`PanelCaller.reads`). */
  callerReads(panel: CountedPanel): Pick<PanelCaller, "reads"> {
    if (!this.counted(panel)) return {};
    return {
      reads: (read, failure, everyMs) => {
        // A read that ends after its panel left counts for nothing.
        const current = this.panels.get(panel.id);
        if (!current || !this.counted(current)) return;
        this.sweep();
        this.note(this.panels.keyOf(panel), read, failure, everyMs ?? 0);
      },
    };
  }

  /**
   * What the captain's panel's background process reports of each run,
   * heard from that process alone: a stopped or replaced one says nothing
   * more, and its first run can end before its panel is on the rail.
   */
  ran(id: string, slice: string): (task: string, everyMs: number, failure: string | null) => void {
    return (task, everyMs, failure) => {
      if (!this.options || !this.panels.isLive(slice)) return;
      const key = this.panels.keyOf({ source: "yours", id, runbook: null, slice });
      this.note(key, { kind: "background", task }, failure, everyMs);
    };
  }

  /**
   * New background code starts for the captain's panel: its reads start
   * over, before its first run reports, and at the drawing it starts beside
   * so the next sweep keeps what that run counts.
   */
  restart(id: string, slice: string, drawing: string | null): void {
    if (!this.options || !this.panels.isLive(slice)) return;
    const key = this.panels.keyOf({ source: "yours", id, runbook: null, slice });
    this.options.failures.forget(key);
    this.drawings.set(key, drawing ?? "");
  }

  /** The captain's panel left the rail: its failing reads go with it. */
  drop(id: string): void {
    const key = this.panels.keyOf({ source: "yours", id, runbook: null, slice: id });
    this.drawings.delete(key);
    this.options?.failures.forget(key);
  }

  /**
   * Forget the failing reads of a panel whose drawing changed. A panel not
   * on the rail is left alone here: one still loading keeps what its first
   * run counted, and one that left was forgotten as it left (`drop`).
   */
  sweep(): void {
    if (!this.options) return;
    const changed: string[] = [];
    for (const panel of this.panels.loaded()) {
      if (!this.counted(panel)) continue;
      const key = this.panels.keyOf(panel);
      const drawing = panel.panel?.hash ?? "";
      const was = this.drawings.get(key);
      if (was !== undefined && was !== drawing) changed.push(key);
      this.drawings.set(key, drawing);
    }
    for (const key of changed) this.options.failures.forget(key);
  }

  /**
   * The captain's Ask the first mate: the first mate is told of each failing
   * read not asked about yet, once. False, telling no one, when nothing is
   * failing or every read was asked already.
   */
  ask(panel: CountedPanel | undefined): boolean {
    if (!panel || !this.options || !this.counted(panel)) return false;
    const failing = this.options.failures.ask(this.panels.keyOf(panel));
    if (failing.length === 0) return false;
    this.options.ask({ id: panel.id, title: panel.manifest.title ?? panel.id, failing });
    return true;
  }

  /** A panel's failing reads, for its snapshot. */
  lines(panel: CountedPanel): Pick<PersonalExtensionView, "failing"> {
    if (!this.options || !this.counted(panel)) return {};
    const failing = this.options.failures.failing(this.panels.keyOf(panel));
    return failing.length > 0 ? { failing } : {};
  }

  private note(key: string, read: PanelReadNoted, failure: string | null, everyMs: number): void {
    if (!this.options) return;
    if (failure === null) this.options.failures.worked(key, read);
    else this.options.failures.failed(key, read, failure, everyMs);
  }

  private turned(turned: PanelReadTurnedFailing): void {
    const panel = [...this.panels.loaded()].find(
      (candidate) => this.counted(candidate) && this.panels.keyOf(candidate) === turned.panel,
    );
    if (!panel || !this.options) return;
    this.options.tell({
      id: panel.id,
      title: panel.manifest.title ?? panel.id,
      version: `${panel.serverHash ?? ""}:${panel.panel?.hash ?? ""}`,
      read: turned.key,
      failing: turned.failing,
    });
  }
}

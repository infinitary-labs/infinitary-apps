import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { PersonalStore } from "./personalStore";

/**
 * Words from outside in a panel's store (docs/integrations.md, "Panels";
 * docs/task-retention.md, "Words from outside"). A kind that keeps its
 * words for a while (`IntegrationBinding.kept`, Google's 30 days) holds a
 * panel to the same days: once a panel has read words of that kind, every
 * key of its store not rewritten within those days goes, and the captain's
 * delete of words from outside empties its store. The app cannot tell which
 * of a panel's keys hold those words, so it judges by when each was written.
 *
 * One file, `userData/integrations/panel-reads.json`, 0600, written whole:
 * each panel key (`source:id`) and, per kind's label, when it last read.
 */

const FILE = "panel-reads.json";

const fileSchema = z.record(z.string(), z.record(z.string(), z.number()));

export class PanelOutsideData {
  private reads: Record<string, Record<string, number>>;

  constructor(
    private readonly root: string,
    private readonly store: Pick<PersonalStore, "list" | "delete" | "clearExtension">,
  ) {
    this.reads = this.read();
  }

  /** A panel received fenced words of this kind's label. */
  noted(panel: string, label: string, at: number): void {
    const labels = this.reads[panel] ?? {};
    if ((labels[label] ?? 0) >= at) return;
    this.reads[panel] = { ...labels, [label]: at };
    this.write();
  }

  /**
   * Each panel that read a kind: the keys of its store last written before
   * that kind's cutoff go. A panel that read several kinds keeps the
   * shortest of their days.
   */
  sweep(cutoffs: ReadonlyMap<string, number>): number {
    let removed = 0;
    for (const [panel, labels] of Object.entries(this.reads)) {
      const cutoff = Math.max(
        Number.NEGATIVE_INFINITY,
        ...Object.keys(labels).flatMap((label) => {
          const at = cutoffs.get(label);
          return at === undefined ? [] : [at];
        }),
      );
      if (cutoff === Number.NEGATIVE_INFINITY) continue;
      const slice = sliceOf(panel);
      for (const entry of this.store.list(slice)) {
        if (entry.updatedAt >= cutoff) continue;
        this.store.delete(slice, entry.key);
        removed += 1;
      }
    }
    return removed;
  }

  /** The captain's delete: every panel that read a kept kind has its store emptied. */
  deleteAll(): number {
    const panels = Object.keys(this.reads);
    for (const panel of panels) this.store.clearExtension(sliceOf(panel));
    this.reads = {};
    this.write();
    return panels.length;
  }

  /** The panels that read a kept kind, for a test or a reader that digs. */
  panels(): string[] {
    return Object.keys(this.reads);
  }

  private read(): Record<string, Record<string, number>> {
    try {
      return fileSchema.parse(JSON.parse(readFileSync(join(this.root, FILE), "utf8")));
    } catch {
      return {};
    }
  }

  private write(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const file = join(this.root, FILE);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(this.reads)}\n`, { mode: 0o600 });
    renameSync(temp, file);
  }
}

function sliceOf(panel: string): string {
  return panel.slice(panel.indexOf(":") + 1);
}

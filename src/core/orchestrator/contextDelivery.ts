import { createHash } from "node:crypto";

/**
 * What one model context has read of the first mate's saved facts
 * (INF-1712, docs/orchestrator-contract.md "What a context carries"): a
 * context's first input carries every section whole, and each later input
 * carries only the sections and rows that changed since the model read
 * them, with the ones gone named as removed.
 *
 * The model's view advances only on the backend's read witness
 * (`input_read`), never when an input is built or queued, so an unread
 * steer or a failed turn sends its changes again. Each read applies its
 * own changes in read order, which is how the model read them; a fold,
 * a new session or anything else that leaves the view uncertain resets it,
 * and the next input is complete again.
 */

/** One section of a context: rows by a stable id, or one value. */
export type ContextSection =
  | {
      kind: "rows";
      rows: ReadonlyArray<{ id: string; value: unknown; same?: unknown }>;
    }
  /** `value` undefined: the section is empty now. */
  | { kind: "whole"; value: unknown; same?: unknown };

/**
 * `same` is what decides "unchanged" when the value carries words that
 * move with the clock; it defaults to the value itself.
 */
type View = Map<string, string | Map<string, string>>;

type Change =
  | { kind: "rows"; set: Map<string, string>; removed: string[] }
  | { kind: "whole"; set?: string; removed?: true };

type Offer = { complete: boolean; view: View; changes: Map<string, Change>; onRead?: () => void };

/** The newest offers kept for a read witness; older inputs were never read. */
const OFFERS_KEPT = 32;

export const DELIVERY_COMPLETE =
  "complete: every saved section as it stands now; a section not listed is empty. Later contexts carry only what changed.";
export const DELIVERY_CHANGES =
  "changes since the last context you read: a section or row not listed here is unchanged; changed rows replace the earlier row with the same id; removed names ids no longer current; removed_sections names sections now empty.";

export class ContextDelivery {
  /** The model's view, undefined when the next input must be complete. */
  private view: View | undefined;
  private offers = new Map<string, Offer>();
  private expected = new Map<string, Offer[]>();

  /** Whether the next built context is a complete one. */
  get completeNext(): boolean {
    return this.view === undefined;
  }

  /**
   * Forget the model's view: the next context is complete. Inputs already
   * sent keep their expected reads, since one still queued may be read after
   * that complete one and replace what it said.
   */
  reset(): void {
    this.view = undefined;
  }

  /**
   * The sections to serve: every one when the view is unknown, else the
   * changes. Pure until `offer` names the body it went out in.
   */
  render(sections: Record<string, ContextSection>): {
    payload: Record<string, unknown>;
    complete: boolean;
    offer: Omit<Offer, "onRead">;
  } {
    const complete = this.view === undefined;
    const before = this.view ?? new Map();
    const payload: Record<string, unknown> = {};
    const removedSections: string[] = [];
    const view: View = new Map();
    const changes = new Map<string, Change>();
    for (const [name, section] of Object.entries(sections)) {
      if (section.kind === "whole") {
        const was = before.get(name);
        if (section.value === undefined) {
          if (!complete && typeof was === "string") {
            removedSections.push(name);
            changes.set(name, { kind: "whole", removed: true });
          }
          continue;
        }
        const key = stable(section.same ?? section.value);
        view.set(name, key);
        if (complete || was !== key) {
          payload[name] = section.value;
          changes.set(name, { kind: "whole", set: key });
        }
        continue;
      }
      const was = before.get(name);
      const prior = was instanceof Map ? was : new Map<string, string>();
      const rows = new Map<string, string>();
      const changed: unknown[] = [];
      for (const row of section.rows) {
        const key = stable(row.same ?? row.value);
        rows.set(row.id, key);
        if (complete || prior.get(row.id) !== key) changed.push(row.value);
      }
      const removed = complete ? [] : [...prior.keys()].filter((id) => !rows.has(id));
      view.set(name, rows);
      if (complete) {
        if (changed.length > 0) payload[name] = changed;
      } else if (changed.length > 0 || removed.length > 0) {
        payload[name] = {
          ...(changed.length > 0 ? { changed } : {}),
          ...(removed.length > 0 ? { removed } : {}),
        };
      }
      changes.set(name, {
        kind: "rows",
        set: new Map([...rows].filter(([id, key]) => complete || prior.get(id) !== key)),
        removed,
      });
    }
    // A section the model holds that this render does not name at all is gone.
    if (!complete) {
      for (const [name, was] of before) {
        if (name in sections) continue;
        if (was instanceof Map) {
          if (was.size === 0) continue;
          payload[name] = { removed: [...was.keys()] };
          changes.set(name, { kind: "rows", set: new Map(), removed: [...was.keys()] });
        } else {
          removedSections.push(name);
          changes.set(name, { kind: "whole", removed: true });
        }
      }
    }
    if (removedSections.length > 0) payload.removed_sections = removedSections;
    return { payload, complete, offer: { complete, view, changes } };
  }

  /** The built context's body went out (or may): remember it for its read. */
  offer(body: string, offer: Omit<Offer, "onRead">, onRead?: () => void): void {
    this.offers.delete(body);
    this.offers.set(body, { ...offer, ...(onRead ? { onRead } : {}) });
    while (this.offers.size > OFFERS_KEPT) {
      const oldest = this.offers.keys().next().value;
      if (oldest === undefined) break;
      this.offers.delete(oldest);
    }
  }

  /** An exact input was sent: the contexts it carries count once its read is witnessed. */
  expect(framedText: string): void {
    const carried = [...this.offers].filter(([body]) => framedText.includes(body));
    if (carried.length === 0) return;
    const sha = sha256(framedText);
    this.expected.set(sha, [...(this.expected.get(sha) ?? []), ...carried.map(([, o]) => o)]);
    while (this.expected.size > OFFERS_KEPT) {
      const oldest = this.expected.keys().next().value;
      if (oldest === undefined) break;
      this.expected.delete(oldest);
    }
  }

  /** The backend read the input with this digest: the model now holds what it carried. */
  read(textSha256: string): void {
    const offers = this.expected.get(textSha256);
    if (!offers) return;
    this.expected.delete(textSha256);
    for (const offer of offers) {
      if (offer.complete) this.view = cloneView(offer.view);
      else if (this.view) applyChanges(this.view, offer.changes);
      // A change read after a reset is not a view: the next input stays complete.
      offer.onRead?.();
    }
  }
}

function applyChanges(view: View, changes: Map<string, Change>): void {
  for (const [name, change] of changes) {
    if (change.kind === "whole") {
      if (change.removed) view.delete(name);
      else if (change.set !== undefined) view.set(name, change.set);
      continue;
    }
    const was = view.get(name);
    const rows = was instanceof Map ? was : new Map<string, string>();
    for (const id of change.removed) rows.delete(id);
    for (const [id, key] of change.set) rows.set(id, key);
    view.set(name, rows);
  }
}

function cloneView(view: View): View {
  return new Map(
    [...view].map(([name, value]) => [name, value instanceof Map ? new Map(value) : value]),
  );
}

/** Key order never makes a row look changed. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, inner) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
      : inner,
  );
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

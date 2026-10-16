import type { StoreValue } from "@infinitary/contracts";
import { type Camera, HOME_CAMERA, PITCH_LIMIT, ZOOM_MAX, ZOOM_MIN } from "./graph";

/**
 * The knowledge browser's place (the design skill's
 * `components/knowledge/KnowledgeBrowser`, "Where the browser opens"):
 * everything it keeps on its card while it pages - the Project filter, Find,
 * the tab, the selection and the inspector's section, the camera, the
 * neighborhood, the findings filter and each list's page - and what a key
 * that put it up asked for. Hide lets all of it go; the next browser
 * starts fresh. Kept as JSON on the card (`card.keep`, at most 4,096 bytes).
 */

export type Tab = "graph" | "concepts" | "findings" | "directions";
export const TABS: readonly Tab[] = ["directions", "graph", "concepts", "findings"];

export type Section = "overview" | "evidence" | "history" | "used";
export const SECTIONS: readonly Section[] = ["overview", "evidence", "history", "used"];

export type Filter = "all" | "recheck" | "differing";
export const FILTERS: readonly Filter[] = ["all", "recheck", "differing"];

/**
 * What the inspector shows: a concept or a finding by id - at an earlier
 * revision when `revision` names one - a connection by its id
 * (`claim:<finding>` or `context:<from>:<to>`), or a standing direction by id.
 */
export type Selection = {
  kind: "concept" | "finding" | "connection" | "direction";
  id: string;
  revision?: number;
};

export type Place = {
  /** The Directions Project filter; null starts at All projects. */
  scope: string | null;
  query: string;
  tab: Tab;
  selection: Selection | null;
  /** The concept the graph's arrows stand on and its Connections list is for. */
  node: string | null;
  section: Section;
  /** The page of direction edit history kept with its selection. */
  directionPage: number;
  camera: Camera;
  /** The graph shows the node's neighborhood, so many hops out, instead of the collection. */
  nearby: boolean;
  hops: 1 | 2;
  filter: Filter;
  pages: { concepts: number; findings: number; directions: number };
  /** In a narrow card, the inspector replaces the pane until Back. */
  detail: boolean;
  /** The card's revision whose ask this browser answered. */
  answered: number;
};

export const FRESH: Place = {
  scope: null,
  query: "",
  tab: "graph",
  selection: null,
  node: null,
  section: "overview",
  directionPage: 0,
  camera: HOME_CAMERA,
  nearby: false,
  hops: 1,
  filter: "all",
  pages: { concepts: 0, findings: 0, directions: 0 },
  detail: false,
  answered: 0,
};

const ID = /^(?:[cf]-[a-z0-9]{6}|claim:f-[a-z0-9]{6}|context:c-[a-z0-9]{6}:c-[a-z0-9]{6})$/;
/** A direction's durable identifier. */
const DIRECTION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function number(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

function oneOf<T extends string>(value: unknown, list: readonly T[], fallback: T): T {
  return list.includes(value as T) ? (value as T) : fallback;
}

/** The place a card kept, read back as its page was born; anything unreadable starts fresh. */
export function placeOf(kept: StoreValue): Place {
  if (!kept || typeof kept !== "object" || Array.isArray(kept)) return FRESH;
  const k = kept as Record<string, unknown>;
  const camera = (k.camera ?? {}) as Record<string, unknown>;
  const pages = (k.pages ?? {}) as Record<string, unknown>;
  const selection = k.selection as Record<string, unknown> | null | undefined;
  const kind = selection?.kind;
  const id = selection?.id;
  const revision = selection?.revision;
  return {
    scope: typeof k.scope === "string" && k.scope ? k.scope : null,
    query: typeof k.query === "string" ? k.query.slice(0, 200) : "",
    tab: oneOf(k.tab, TABS, "graph"),
    selection:
      typeof id === "string" &&
      (((kind === "concept" || kind === "finding" || kind === "connection") && ID.test(id)) ||
        (kind === "direction" && DIRECTION_ID.test(id)))
        ? {
            kind,
            id,
            ...((kind === "concept" || kind === "finding") && isRevision(revision)
              ? { revision }
              : {}),
          }
        : null,
    node: typeof k.node === "string" && /^c-[a-z0-9]{6}$/.test(k.node) ? k.node : null,
    section: oneOf(k.section, SECTIONS, "overview"),
    directionPage: Math.floor(number(k.directionPage, 0, 0, 10_000)),
    camera: {
      yaw: number(camera.yaw, HOME_CAMERA.yaw, -1e6, 1e6),
      pitch: number(camera.pitch, HOME_CAMERA.pitch, -PITCH_LIMIT, PITCH_LIMIT),
      zoom: number(camera.zoom, HOME_CAMERA.zoom, ZOOM_MIN, ZOOM_MAX),
    },
    nearby: k.nearby === true,
    hops: k.hops === 2 ? 2 : 1,
    filter: oneOf(k.filter, FILTERS, "all"),
    pages: {
      concepts: Math.floor(number(pages.concepts, 0, 0, 10_000)),
      findings: Math.floor(number(pages.findings, 0, 0, 10_000)),
      directions: Math.floor(number(pages.directions, 0, 0, 10_000)),
    },
    detail: k.detail === true,
    answered: Math.floor(number(k.answered, 0, 0, Number.MAX_SAFE_INTEGER)),
  };
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * What a key, a row or a reference that put the browser up asked for:
 * focus on the shown tab's own stop (`pane`), in Find, or on the inspector;
 * a collection to show; and an entry to open in the inspector - at an
 * earlier revision when `revision` names one - as a card's reference or a
 * task record's Knowledge used row asks (docs/knowledge.md).
 */
export type Ask = {
  focus: "pane" | "find" | "inspector" | null;
  scope: string | null;
  tab?: Tab;
  entry: Selection | null;
};

export function askOf(data: StoreValue): Ask {
  const d = (data && typeof data === "object" && !Array.isArray(data) ? data : {}) as Record<
    string,
    unknown
  >;
  const id = typeof d.entry === "string" && /^[cf]-[a-z0-9]{6}$/.test(d.entry) ? d.entry : null;
  const direction =
    typeof d.direction === "string" && DIRECTION_ID.test(d.direction) ? d.direction : null;
  const entry: Selection | null = direction
    ? { kind: "direction", id: direction }
    : id
      ? {
          kind: id.startsWith("c-") ? "concept" : "finding",
          id,
          ...(isRevision(d.revision) ? { revision: d.revision } : {}),
        }
      : null;
  return {
    focus:
      d.focus === "pane" || d.focus === "find" || (d.focus === "inspector" && entry)
        ? (d.focus as Ask["focus"])
        : null,
    scope: typeof d.scope === "string" && d.scope ? d.scope : null,
    ...(TABS.includes(d.tab as Tab) ? { tab: d.tab as Tab } : {}),
    entry,
  };
}

/** The concept a connection's id names at its start: where the graph's arrows stand after it. */
export function startOf(selection: Selection | null): string | null {
  if (!selection) return null;
  if (selection.kind === "concept") return selection.id;
  if (selection.kind === "connection" && selection.id.startsWith("context:")) {
    return selection.id.split(":")[1] ?? null;
  }
  return null;
}

/** The entry the inspector reads for a selection: a claim's finding, a link's declaring concept. */
export function entryIdOf(selection: Selection | null): string | null {
  if (!selection || selection.kind === "direction") return null;
  if (selection.kind !== "connection") return selection.id;
  const [kind, first] = selection.id.split(":");
  return kind === "claim" || kind === "context" ? (first ?? null) : null;
}

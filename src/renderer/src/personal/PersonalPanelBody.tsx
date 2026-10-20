import type {
  PanelAsks,
  PanelCards,
  PanelProps,
  PanelReadName,
  PanelReads,
  PanelStore,
  SqlAnswer,
  StoreValue,
} from "@shared/personal/contracts";
import {
  PANEL_READ_NAMES,
  personalDraftPanelId,
  undeclaredReadMessage,
  undeclaredViewsMessage,
} from "@shared/personal/manifest";
import type { ReadGrant } from "@shared/reads";
import { type ComponentType, useEffect, useMemo, useState } from "react";
import { useShellStore } from "../app/store";
import { windowGesture } from "../plugins/frames/frameActivation";
import { onPanelAsk, onPanelFocus, windowPanelCards } from "../plugins/panelCards";
import { panelPoint, usePanelView } from "../plugins/panelPoint";
import { railProp } from "../plugins/panelRail";
import { panelTasks } from "../plugins/panelTasks";
import { usePanelCollapsed } from "../plugins/railStore";
import { appReadExecutor } from "../plugins/reads/appExecutor";
import { panelBodies, stoppedWhy } from "./panelBodies";
import { PanelBoundary, PanelStoppedLine } from "./panelBoundary";

/**
 * The Tier-1 body of a personal panel (talk-to-personalize Step 2): imports
 * the compiled module from its `app-plugin://` URL, hands the component its
 * props (the extension's id, its store slice, `invoke`, the app's own reads
 * the manifest declared - Step 4 - and the theme), and
 * keeps a thrown render inside one boundary. A throw - or a module that
 * will not import - shows the quiet line the design system gives a body
 * that stopped answering, and the panel's chrome stays; the boundary
 * resets when the version changes (the crewmate saved a fix), never on a
 * timer. Until a new version has loaded the previous one keeps drawing,
 * so a hot reload never blanks the rail. The panel on the rail says how
 * its body fared (./panelBodies.ts): drawn, or stopped and why.
 */
export type PersonalPanelContent = {
  id: string;
  /** Its title: what the task's record names a move it made by. */
  title: string;
  url: string;
  version: string;
  /** The reads the manifest declared; the panel is served these and no other. */
  reads: string[];
  /** The views of the record the manifest declared (`sql`); its queries reach these and no other. */
  sql: string[];
  /** Its manifest asks to move the captain's tasks (`moves`). */
  moves: boolean;
  /** Its own code decides whether it shows (`presence` `{ "code": true }`). */
  decides: boolean;
  /**
   * The version a crewmate is building, drawn out of sight for its capture
   * (docs/personal-panels.md, "Built apart"): it reaches its own store and
   * server, and nothing of the captain's.
   */
  draft?: true;
};

/** Injected for tests; the app imports for real. */
export type ModuleImporter = (url: string) => Promise<unknown>;

const importForReal: ModuleImporter = (url) => import(/* @vite-ignore */ url);

export type LoadState =
  | { version: string; Component: ComponentType<PanelProps> }
  | { version: string; failed: true; why: string };

export function PersonalPanelBody({
  content,
  importModule = importForReal,
}: {
  content: PersonalPanelContent;
  importModule?: ModuleImporter;
}) {
  const props = usePanelProps(content);
  const loaded = useLoadedModule(content.url, content.version, importModule);
  // A draft is out of sight: only the panel on the rail answers for it.
  const onRail = content.draft !== true;
  if (loaded === null) return null;
  if ("failed" in loaded) {
    return (
      <>
        <PanelStoppedLine />
        {onRail && <BodySaid id={content.id} version={loaded.version} why={loaded.why} />}
      </>
    );
  }
  const { Component } = loaded;
  const stopped = (error: unknown) =>
    panelBodies.note(content.id, {
      version: loaded.version,
      state: "stopped",
      why: stoppedWhy(error),
    });
  return (
    <PanelBoundary key={loaded.version} {...(onRail ? { onStop: stopped } : {})}>
      <Component {...props} />
      {onRail && <BodySaid id={content.id} version={loaded.version} why={null} />}
    </PanelBoundary>
  );
}

/**
 * Says how the body fared once it committed: drawn when it sits after the
 * panel's component inside the boundary (a throw replaces both before
 * either commits), or stopped with the import's own words.
 */
function BodySaid({ id, version, why }: { id: string; version: string; why: string | null }) {
  useEffect(() => {
    panelBodies.note(
      id,
      why === null ? { version, state: "drawn" } : { version, state: "stopped", why },
    );
  }, [id, version, why]);
  return null;
}

/** The captain's own click or key holds the window now (`windowGesture`). */
const windowGate = async () => windowGesture();
/** A draft is out of the captain's sight: no click or key of his is ever on it. */
const neverGate = async () => false;
/** A page in the window has no frame: its boxes are the window's already. */
const inWindow = () => null;

/** A draft's cards: what it would put up reaches no stack. */
const draftCards: PanelCards = {
  emit: async (card) => card.id ?? card.view,
  close: async () => undefined,
  open: async () => [],
};

/** A draft's asks: no header button of the captain's presses into it. */
const draftAsks: PanelAsks = { subscribe: () => () => {}, onFocus: () => () => {} };

/**
 * Everything a panel of the captain's own is handed, its card views too
 * (docs/ui-plugins.md, "A panel's cards"): its id, its store slice,
 * `invoke`, its declared reads, the theme, its cards on the stack, the
 * asks its header buttons press into it, its pointing and the view, its
 * moves when its manifest asks for them, and - the panel itself, never a
 * card view - its rail. A card view names its card, the one its
 * `point.aim` aims.
 *
 * A draft (`content.draft`) is handed the same shape bound apart: its own
 * store and server, the rail of its own out-of-sight copy, never
 * collapsed, cards and asks that reach nothing, and pointing and moves
 * that never count, since no click or key of the captain's is ever on it.
 */
export function usePanelProps(
  content: Omit<PersonalPanelContent, "url" | "version">,
  card?: string,
): PanelProps {
  const theme = useShellStore((s) => s.theme);
  const { id } = content;
  const draft = content.draft === true;
  /** Where its rail, pointing and moves are kept: its own panel's, or its draft's copy. */
  const drawn = draft ? personalDraftPanelId(id) : id;
  const store = useMemo(() => bindStore(id, draft), [id, draft]);
  const invoke = useMemo(() => bindInvoke(id, draft), [id, draft]);
  const cards = useMemo(() => (draft ? draftCards : windowPanelCards(id)), [id, draft]);
  const asks = useMemo<PanelAsks>(
    () =>
      draft
        ? draftAsks
        : {
            subscribe: (listener) => onPanelAsk(id, listener),
            onFocus: (listener) => onPanelFocus(id, listener),
          },
    [id, draft],
  );
  const declared = content.reads.join(",");
  const views = content.sql.join(",");
  const reads = useMemo(
    () =>
      bindReads(
        declared.split(",").filter(Boolean),
        appReadExecutor(),
        views.split(",").filter(Boolean),
      ),
    [declared, views],
  );
  const point = useMemo(
    () =>
      panelPoint(drawn, {
        reads: declared.split(",").filter(Boolean),
        ...(card === undefined ? {} : { card }),
        gate: draft ? neverGate : windowGate,
        frame: inWindow,
      }),
    [drawn, declared, card, draft],
  );
  const view = usePanelView(content.reads.includes("tasks.board"));
  const { title, moves, decides } = content;
  const tasks = useMemo(
    () => (moves ? panelTasks({ id, title }, draft ? neverGate : windowGate) : undefined),
    [id, title, moves, draft],
  );
  const collapsed = usePanelCollapsed(id) && !draft;
  const rail = useMemo(
    () => (card === undefined ? railProp(drawn, collapsed, decides) : undefined),
    [drawn, card, collapsed, decides],
  );
  return {
    id,
    store,
    invoke,
    reads,
    theme,
    cards,
    asks,
    point,
    view,
    ...(tasks ? { tasks } : {}),
    ...(rail ? { rail } : {}),
  };
}

/**
 * Imports a compiled module of the captain's own (a panel or one of its card
 * views) and keeps its default export. Until a new version has loaded the
 * previous one keeps drawing, so a hot reload never blanks it.
 */
export function useLoadedModule(
  url: string,
  version: string,
  importModule: ModuleImporter = importForReal,
): LoadState | null {
  const [loaded, setLoaded] = useState<LoadState | null>(null);
  useEffect(() => {
    let cancelled = false;
    importModule(url)
      .then((module) => {
        if (cancelled) return;
        const candidate = (module as { default?: unknown } | null)?.default;
        if (typeof candidate !== "function") {
          setLoaded({ version, failed: true, why: "its module has no default export to draw" });
          return;
        }
        setLoaded({ version, Component: candidate as ComponentType<PanelProps> });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoaded({
            version,
            failed: true,
            why: `its module would not import: ${stoppedWhy(error)}`,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [url, version, importModule]);
  return loaded;
}

/** The extension's store slice - or its draft's - over the one `inf:plugins:db` channel. */
export function bindStore(id: string, draft = false): PanelStore {
  const { db } = window.infinitary.plugins;
  const own = { extensionId: id, ...(draft ? { draft: true as const } : {}) };
  return {
    get: (key) => db.request({ op: "get", ...own, key }).then((r) => r.value),
    set: (key, value: StoreValue) =>
      db.request({ op: "set", ...own, key, value }).then(() => undefined),
    delete: (key) => db.request({ op: "delete", ...own, key }).then(() => undefined),
    list: (prefix) =>
      db
        .request({ op: "list", ...own, ...(prefix ? { prefix } : {}) })
        .then((r) => r.entries ?? []),
    subscribe: (listener) =>
      db.onChange((change) => {
        if (change.extensionId === id && (change.draft === true) === draft) listener(change.key);
      }),
  };
}

/** What `bindReads` needs from the read executor: one subscription at a time. */
export type ReadSubscriber = {
  subscribe: (
    name: string,
    args: unknown,
    listener: { onValue: (value: unknown) => void; onError: (error: unknown) => void },
    grant?: ReadGrant,
  ) => () => void;
};

/**
 * The app's own reads, as the manifest declared them (Step 4, decision Q3):
 * a name the manifest did not list - or one the catalog does not serve to
 * panels at all - throws, so the declaration is the grant; a served read
 * rides the same executor the built-in panels use (coalesced, pushed on
 * change). A read that fails is logged and the panel keeps what it has.
 *
 * `subscribe("sql", query, listener)` (plugin data surface, Phase B) runs
 * the panel's own query over the views its manifest's `sql` names: the
 * host hands the executor that list as the grant, so the query can reach
 * nothing else, and a panel that declared no view is served no query.
 */
export function bindReads(
  declared: readonly string[],
  executor: ReadSubscriber,
  views: readonly string[] = [],
): PanelReads {
  const served = new Set(
    declared.filter((name) => (PANEL_READ_NAMES as readonly string[]).includes(name)),
  );
  const grant: ReadGrant = { sql: [...views] };
  const subscribe = (name: string, second: unknown, third?: unknown): (() => void) => {
    if (name === "sql") {
      if (views.length === 0) {
        throw new Error(undeclaredViewsMessage());
      }
      const listener = third as (answer: SqlAnswer) => void;
      return executor.subscribe(
        "sql",
        second,
        {
          onValue: (value) => listener(value as SqlAnswer),
          onError: (error) => console.warn("personal panel query failed:", error),
        },
        grant,
      );
    }
    if (!served.has(name)) {
      throw new Error(undeclaredReadMessage(name));
    }
    // A read that takes arguments - one task by its id, closed work by its
    // words, a knowledge collection by its scope - has its listener third;
    // every other read takes nothing.
    const withArgs = typeof third === "function";
    const listener = (withArgs ? third : second) as (value: unknown) => void;
    return executor.subscribe(name as PanelReadName, withArgs ? second : {}, {
      onValue: (value) => listener(value),
      onError: (error) => console.warn(`personal panel read "${name}" failed:`, error),
    });
  };
  return { subscribe: subscribe as PanelReads["subscribe"] };
}

export function bindInvoke(id: string, draft = false): PanelProps["invoke"] {
  return async <T,>(action: string, input?: unknown): Promise<T> => {
    const { plugins } = window.infinitary;
    const result = draft
      ? await plugins.invoke(id, action, input, { draft: true })
      : await plugins.invoke(id, action, input);
    if (!result.ok) throw new Error(result.error);
    return result.result as T;
  };
}

import { formatNumber } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";
import { elsewhereWords, type ProjectPill } from "@shared/projectFocus";
import type React from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconButton } from "../design";
import { useRestLabel } from "../design/core/restLabel";
import { motionToken } from "../design/motion";
import { type CommandKeys, useCommandKeys } from "./keyHints";
import "./projectFocus.css";
import { projectFocus, useProjectFocus } from "./projectFocus";

/**
 * The top bar's project pill (docs/project-focus.md; the design skill's
 * components/core/ProjectFocus.prompt.md). At rest one pill sits centred in
 * the bar: All projects, or the focused project's name, with the Tasks
 * panel's waiting and working marks and a right-pointing arrow, because the
 * projects open to the right of All projects. Pressing it opens the row,
 * centred on the bar: All projects, then one pill per project, each gliding
 * out from where the pill was so the row fans out both ways, and at its end
 * the same arrow turned back, which folds the row again. Esc, a
 * press outside the row and a pick fold it too.
 *
 * Focused, the pill wears the accent border and a × beside it (Show all
 * projects), and a quiet tail says how many tasks wait on the captain in
 * other projects, which opens the row. A row too wide for the bar's room
 * ends in a +N pill that lists the rest.
 */

/** The bar's room the row may take, in the bar's own coordinates. */
export type BarRoom = { left: number; right: number };

/** Space between pills, px: the row's `gap`. */
const GAP_PX = 6;
/** The gap left clear at the room's edges, px. */
const EDGE_PX = 12;
/** Each further pill starts its glide this much later, ms, up to the last. */
const STAGGER_MS = 24;
const STAGGER_LAST_MS = 120;

type Phase = "closed" | "measuring" | "open" | "closing";

/** Where the open row sits, and where each pill glides from. */
type Placement = {
  left: number;
  /** The projects drawn in the row; the rest are behind the +N pill. */
  shown: readonly string[];
  /** Each drawn item's start, px from its place: "all", project ids, "more", "fold". */
  from: Readonly<Record<string, number>>;
};

const waitingMark = (
  <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden="true" data-pf-mark="waiting">
    <circle cx="8" cy="8" r="6" fill="none" stroke="var(--accent)" strokeWidth="1.6" />
    <circle cx="8" cy="8" r="3" fill="var(--accent)" />
  </svg>
);
const workingMark = (
  <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden="true" data-pf-mark="working">
    <circle cx="8" cy="8" r="6" fill="var(--warn)" />
  </svg>
);

function arrow(back: boolean) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={back ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6"} />
    </svg>
  );
}

function Counts({ waiting, working }: { waiting: number; working: number }) {
  return (
    <>
      {waiting > 0 && (
        <span className="fm-pf-n" data-pf-count="waiting">
          {waitingMark}
          {waiting}
        </span>
      )}
      {working > 0 && (
        <span className="fm-pf-n" data-pf-count="working">
          {workingMark}
          {working}
        </span>
      )}
    </>
  );
}

/** The words a pill's rest shows: its name and both counts. */
function wordsOf(name: string, waiting: number, working: number): string {
  return m.shellProjectPillWords({
    name,
    waiting: formatNumber(waiting),
    working: formatNumber(working),
  });
}

type Item = { id: string; name: string; waiting: number; working: number; key?: string };

function OptionPill({
  item,
  checked,
  stop,
  keep,
  slide,
  onPick,
  setRef,
}: {
  item: Item;
  checked: boolean;
  stop: boolean;
  /** The pill a pick or a fold keeps in sight while the others fold into it. */
  keep: boolean;
  slide: React.CSSProperties;
  onPick: (id: string) => void;
  setRef: (id: string, node: HTMLButtonElement | null) => void;
}) {
  const rest = useRestLabel(wordsOf(item.name, item.waiting, item.working));
  const restRef = rest.ref;
  const ref = useCallback(
    (node: HTMLButtonElement | null) => {
      restRef(node);
      setRef(item.id, node);
    },
    [restRef, setRef, item.id],
  );
  return (
    // biome-ignore lint/a11y/useSemanticElements: a native radio cannot hold the pill's counts it is drawn with
    <button
      {...rest}
      ref={ref}
      type="button"
      role="radio"
      className="fm-pf-pill fm-pf-slide"
      aria-checked={checked ? "true" : "false"}
      aria-label={wordsOf(item.name, item.waiting, item.working)}
      tabIndex={stop ? 0 : -1}
      data-project-focus-option={item.key ?? "all"}
      data-pf-id={item.id}
      data-pf-quiet={item.id !== "all" && item.waiting + item.working === 0 ? "" : undefined}
      data-pf-keep={keep ? "" : undefined}
      style={slide}
      onPointerEnter={rest.onPointerEnter}
      // The stage lights the pill once the pointer moves onto it, never on
      // enter: the row opens under the pointer that pressed the folded pill,
      // and the browser reports that pill entered with no movement, which
      // dimmed every crewmate on a still click (INF-1292).
      onPointerMove={() => projectFocus.setRest(item.id)}
      onPointerLeave={(event) => {
        rest.onPointerLeave(event);
        projectFocus.setRest(null);
      }}
      onFocus={(event) => {
        rest.onFocus(event);
        projectFocus.setRest(item.id);
      }}
      onBlur={(event) => {
        rest.onBlur(event);
        projectFocus.setRest(null);
      }}
      onClick={() => onPick(item.id)}
    >
      {item.name}
      <Counts waiting={item.waiting} working={item.working} />
    </button>
  );
}

export function ProjectFocusControl({ room }: { room: () => BarRoom | null }) {
  const state = useProjectFocus();
  const { pills, focus, shown: pillShown, elsewhere } = state;
  const openKeys = useCommandKeys("project-focus.open");
  const clearKeys = useCommandKeys("project-focus.clear");
  const [phase, setPhase] = useState<Phase>("closed");
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [stop, setStop] = useState<string>("all");
  const [menu, setMenu] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const anchor = useRef(0);
  const pillRefs = useRef(new Map<string, HTMLButtonElement>());
  const moreRef = useRef<HTMLButtonElement>(null);
  /** Focus was in the row as it folded: the pill takes it back. */
  const returnFocus = useRef(false);
  /** The row was opened by a key: focus goes onto its pills. */
  const byKey = useRef(false);
  const setRef = useCallback((id: string, node: HTMLButtonElement | null) => {
    if (node) pillRefs.current.set(id, node);
    else pillRefs.current.delete(id);
  }, []);

  const projects: readonly ProjectPill[] = pills?.projects ?? [];
  const focused = projects.find((project) => project.id === focus) ?? null;
  const items: Item[] = [
    {
      id: "all",
      name: m.shellProjectAll(),
      waiting: pills?.waiting ?? 0,
      working: pills?.working ?? 0,
    },
    ...projects.map((project) => ({ ...project })),
  ];

  // The store says open or closed (a pick, Esc, a press outside, a
  // command); the row plays its way there.
  useEffect(() => {
    if (state.open && (phase === "closed" || phase === "closing")) {
      const pill = pillRef.current;
      const bar = rootRef.current?.offsetParent;
      if (pill && bar)
        anchor.current = pill.getBoundingClientRect().left - bar.getBoundingClientRect().left;
      setMenu(false);
      setPhase("measuring");
    } else if (!state.open && (phase === "open" || phase === "measuring")) {
      returnFocus.current = rootRef.current?.contains(document.activeElement) ?? false;
      setMenu(false);
      setPhase("closing");
    }
  }, [state.open, phase]);

  // A command opens the row with focus on its pills.
  const asked = useRef(state.openAsk);
  useEffect(() => {
    if (state.openAsk !== asked.current) {
      asked.current = state.openAsk;
      byKey.current = true;
    }
  }, [state.openAsk]);

  // Measured once every pill is in the row: how many fit, where the row
  // sits (centred on the bar), and where each pill glides from - the pill
  // it opened out of.
  useLayoutEffect(() => {
    if (phase !== "measuring") return;
    const bar = rootRef.current?.offsetParent;
    const limits = room();
    if (!bar || !limits) {
      setPhase("open");
      return;
    }
    const width = (id: string) => pillRefs.current.get(id)?.offsetWidth ?? 0;
    const fold = 26;
    const more = 40;
    const roomWidth = limits.right - limits.left - 2 * EDGE_PX;
    const total = (ids: readonly string[], withMore: boolean) =>
      width("all") +
      ids.reduce((sum, id) => sum + width(id) + GAP_PX, 0) +
      (withMore ? more + GAP_PX : 0) +
      fold +
      GAP_PX;
    let shown = projects.map((project) => project.id);
    if (total(shown, false) > roomWidth) {
      while (shown.length > 1 && total(shown, true) > roomWidth) shown = shown.slice(0, -1);
      // The focused project always keeps its pill.
      if (focus !== null && !shown.includes(focus)) {
        const keep = new Set([...shown.slice(0, -1), focus]);
        shown = projects.map((project) => project.id).filter((id) => keep.has(id));
      }
    }
    const withMore = shown.length < projects.length;
    const rowWidth = total(shown, withMore);
    // Centred on the bar, the same line as the folded pill, held inside the room.
    const centred = (bar as HTMLElement).clientWidth / 2 - rowWidth / 2;
    const left = Math.max(
      limits.left + EDGE_PX,
      Math.min(centred, limits.right - EDGE_PX - rowWidth),
    );
    const from: Record<string, number> = {};
    let x = left;
    for (const id of ["all", ...shown]) {
      from[id] = anchor.current - x;
      x += width(id) + GAP_PX;
    }
    if (withMore) {
      from.more = anchor.current - x;
      x += more + GAP_PX;
    }
    from.fold = anchor.current - x;
    setPlacement({ left, shown, from });
    setStop(focus ?? "all");
    setPhase("open");
  });

  useEffect(() => {
    if (phase !== "open" || !byKey.current) return;
    byKey.current = false;
    pillRefs.current.get(focus ?? "all")?.focus({ preventScroll: true });
  }, [phase, focus]);

  // Closing plays back, then the pill is drawn again and takes focus back.
  useEffect(() => {
    if (phase !== "closing") return;
    const duration = rootRef.current ? motionToken(rootRef.current, "--dur-quick") : 0;
    const timer = window.setTimeout(() => {
      setPhase("closed");
      setPlacement(null);
    }, duration);
    return () => window.clearTimeout(timer);
  }, [phase]);
  useEffect(() => {
    if (phase === "closed" && returnFocus.current) {
      returnFocus.current = false;
      pillRef.current?.focus({ preventScroll: true });
    }
  }, [phase]);

  useEffect(() => {
    if (phase !== "open") return;
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) projectFocus.setOpen(false);
    };
    const resized = () => projectFocus.setOpen(false);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", resized);
    window.addEventListener("blur", resized);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", resized);
      window.removeEventListener("blur", resized);
    };
  }, [phase]);

  // The pill leaves with its row when the projects drop below two.
  useEffect(() => {
    if (!pillShown && state.open) projectFocus.setOpen(false);
  }, [pillShown, state.open]);

  const pick = (id: string) => projectFocus.pick(id === "all" ? null : id);
  // A press from the keyboard (Enter or Space: a click with no pointer
  // detail) puts focus on the row's pills, as the command does.
  const openRow = (event: React.MouseEvent) => {
    if (event.detail === 0) byKey.current = true;
    projectFocus.setOpen(true);
  };

  const onRowKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (menu) {
        setMenu(false);
        moreRef.current?.focus();
      } else projectFocus.setOpen(false);
      return;
    }
    const target = event.target as HTMLElement;
    const order = ["all", ...(placement?.shown ?? [])];
    const at = order.indexOf(target.dataset.pfId ?? "");
    if (at < 0 || event.altKey || event.ctrlKey || event.metaKey) return;
    const to =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? (at + 1) % order.length
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? (at - 1 + order.length) % order.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? order.length - 1
              : -1;
    if (to < 0) return;
    event.preventDefault();
    const id = order[to] ?? "all";
    setStop(id);
    pillRefs.current.get(id)?.focus();
  };

  if (!pillShown && phase === "closed") return null;

  if (phase === "closed") {
    const name = focused ? focused.name : m.shellProjectAll();
    const waiting = focused ? focused.waiting : (pills?.waiting ?? 0);
    const working = focused ? focused.working : (pills?.working ?? 0);
    return (
      <div ref={rootRef} data-project-focus="closed">
        <SummaryPill
          ref={pillRef}
          name={name}
          waiting={waiting}
          working={working}
          focused={focused !== null}
          keys={openKeys}
          onOpen={openRow}
        />
        {focused && (
          <IconButton
            label={m.shellProjectShowAll()}
            size={22}
            {...clearKeys}
            data-project-focus-clear=""
            onClick={() => projectFocus.pick(null)}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </IconButton>
        )}
        {focused && elsewhere > 0 && (
          <button
            type="button"
            className="fm-pf-tail"
            data-project-focus-elsewhere=""
            onClick={openRow}
          >
            {elsewhereWords(elsewhere)}
          </button>
        )}
      </div>
    );
  }

  const measuring = phase === "measuring" || placement === null;
  const shownIds = measuring ? projects.map((project) => project.id) : placement.shown;
  const hidden = projects.filter((project) => !shownIds.includes(project.id));
  const slide = (id: string, index: number): React.CSSProperties =>
    ({
      "--pf-from": `${placement?.from[id] ?? 0}px`,
      "--pf-delay": `${Math.min(index * STAGGER_MS, STAGGER_LAST_MS)}ms`,
    }) as React.CSSProperties;
  const keep = phase === "closing" ? (focus ?? "all") : null;
  const hiddenWaiting = hidden.reduce((sum, project) => sum + project.waiting, 0);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Esc and the arrows move inside the row
    <div
      ref={rootRef}
      data-project-focus={measuring ? "measuring" : phase}
      style={{ left: placement?.left ?? 0 }}
      onKeyDown={onRowKey}
    >
      <div data-project-focus-row="" role="radiogroup" aria-label={m.shellProjectFocusRow()}>
        {items
          .filter((item) => item.id === "all" || shownIds.includes(item.id))
          .map((item, index) => (
            <OptionPill
              key={item.id}
              item={item}
              checked={(focus ?? "all") === item.id}
              stop={stop === item.id}
              keep={keep === item.id}
              slide={slide(item.id, index)}
              onPick={pick}
              setRef={setRef}
            />
          ))}
      </div>
      {hidden.length > 0 && !measuring && (
        <button
          ref={moreRef}
          type="button"
          className="fm-pf-pill fm-pf-slide"
          data-project-focus-more=""
          aria-haspopup="menu"
          aria-expanded={menu ? "true" : "false"}
          aria-label={m.shellProjectMoreCount({ count: hidden.length })}
          style={slide("more", shownIds.length + 1)}
          onClick={() => setMenu((was) => !was)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown") return;
            event.preventDefault();
            setMenu(true);
          }}
        >
          <span className="fm-pf-n" style={{ color: "inherit" }}>{`+${hidden.length}`}</span>
          <Counts waiting={hiddenWaiting} working={0} />
        </button>
      )}
      <span className="fm-pf-slide" style={slide("fold", shownIds.length + 2)}>
        <IconButton
          label={m.shellProjectCloseRow()}
          keys="Esc"
          aria-keyshortcuts="Escape"
          size={26}
          data-project-focus-fold=""
          onClick={() => projectFocus.setOpen(false)}
        >
          {arrow(true)}
        </IconButton>
      </span>
      {menu && hidden.length > 0 && (
        <MoreMenu
          projects={hidden}
          focus={focus}
          at={moreRef.current?.offsetLeft ?? 0}
          onPick={pick}
        />
      )}
    </div>
  );
}

function SummaryPill({
  ref,
  name,
  waiting,
  working,
  focused,
  keys,
  onOpen,
}: {
  ref: React.Ref<HTMLButtonElement>;
  name: string;
  waiting: number;
  working: number;
  focused: boolean;
  keys: CommandKeys;
  onOpen: (event: React.MouseEvent) => void;
}) {
  const words = wordsOf(name, waiting, working);
  const rest = useRestLabel(words, { keys: keys.keys });
  const restRef = rest.ref;
  const setRef = useCallback(
    (node: HTMLButtonElement | null) => {
      restRef(node);
      if (typeof ref === "function") ref(node);
      else if (ref) (ref as React.RefObject<HTMLButtonElement | null>).current = node;
    },
    [ref, restRef],
  );
  return (
    <button
      {...rest}
      ref={setRef}
      type="button"
      className="fm-pf-pill"
      data-project-focus-pill=""
      data-pf-focused={focused ? "" : undefined}
      aria-haspopup="true"
      aria-expanded="false"
      aria-label={m.shellProjectFocusPill({ words })}
      aria-keyshortcuts={keys["aria-keyshortcuts"]}
      data-key-command={keys["data-key-command"]}
      onClick={onOpen}
    >
      {name}
      <Counts waiting={waiting} working={working} />
      <span className="fm-pf-arrow">{arrow(false)}</span>
    </button>
  );
}

function MoreMenu({
  projects,
  focus,
  at,
  onPick,
}: {
  projects: readonly ProjectPill[];
  focus: string | null;
  at: number;
  onPick: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[role=menuitemradio]")?.focus();
  }, []);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the arrows move between its items
    <div
      ref={ref}
      className="fm-pf-menu"
      role="menu"
      aria-label={m.shellProjectMoreMenu()}
      data-project-focus-menu=""
      style={{ left: at }}
      onKeyDown={(event) => {
        const items = [
          ...(ref.current?.querySelectorAll<HTMLElement>("[role=menuitemradio]") ?? []),
        ];
        const at = items.indexOf(document.activeElement as HTMLElement);
        if (at < 0) return;
        const to =
          event.key === "ArrowDown"
            ? (at + 1) % items.length
            : event.key === "ArrowUp"
              ? (at - 1 + items.length) % items.length
              : -1;
        if (to < 0) return;
        event.preventDefault();
        items[to]?.focus();
      }}
    >
      {projects.map((project) => (
        <button
          key={project.id}
          type="button"
          role="menuitemradio"
          className="fm-pf-item"
          aria-checked={focus === project.id ? "true" : "false"}
          data-project-focus-option={project.key}
          onClick={() => onPick(project.id)}
        >
          {project.name}
          <span style={{ display: "inline-flex", gap: 6 }}>
            <Counts waiting={project.waiting} working={project.working} />
          </span>
        </button>
      ))}
    </div>
  );
}

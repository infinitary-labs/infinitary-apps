import { formatDateTime, formatTime } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";
import type { PanelFailingRead, PersonalExtensionView } from "@shared/personal/manifest";
import type React from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button, StatusDot, type StatusDotTone, useRestLabel } from "../design";
import { focusWithRing } from "../design/focus";
import { usePopoverPresence } from "../design/motion";
import { integrationAskLine } from "./panelBoundaryWords";

type Ask = NonNullable<PersonalExtensionView["integrationAsks"]>[number];

/** What the host knows about a panel that its own code cannot say: the mark's sections. */
export type PanelStatus = {
  /** The app stopped its background work. */
  stopped?: "unresponsive" | "exited";
  /** Its reads that keep failing. */
  failing?: readonly PanelFailingRead[];
  /** Its background work refused for an earlier panel API; `asked` once Update panel was pressed. */
  paused?: { asked: boolean };
  /** Its integration calls waiting on the captain or turned down. */
  integrationAsks?: readonly Ask[];
};

type Section =
  | { kind: "stopped"; reason: "unresponsive" | "exited" }
  | { kind: "failing"; failing: readonly PanelFailingRead[] }
  | { kind: "asking"; asks: readonly Ask[] }
  | { kind: "paused"; asked: boolean }
  | { kind: "declined"; asks: readonly Ask[] };

const TONE: Record<Section["kind"], StatusDotTone> = {
  stopped: "warn",
  failing: "warn",
  asking: "captain",
  paused: "idle",
  declined: "idle",
};

/** The press area around the 6px dot, so a pointer finds it and its ring has room. */
const PRESS = 20;
const GAP = 6;
const EDGE = 8;
const WIDTH = 340;

/**
 * Each thing to say, most urgent first: work the app stopped, reads that
 * keep failing, a call waiting on the captain, work paused for an earlier
 * panel API, a call the captain turned down.
 */
export function panelStatusSections(status: PanelStatus): Section[] {
  const sections: Section[] = [];
  if (status.stopped) sections.push({ kind: "stopped", reason: status.stopped });
  if (status.failing?.length) sections.push({ kind: "failing", failing: status.failing });
  const asks = status.integrationAsks ?? [];
  const asking = asks.filter((ask) => ask.state === "asking");
  if (asking.length > 0) sections.push({ kind: "asking", asks: asking });
  if (status.paused) sections.push({ kind: "paused", asked: status.paused.asked });
  const declined = asks.filter((ask) => ask.state === "declined");
  if (declined.length > 0) sections.push({ kind: "declined", asks: declined });
  return sections;
}

/** A time today alone, or with its date when it is not today. */
function sinceWords(since: string): string {
  const at = new Date(since);
  const today = new Date();
  return at.toDateString() === today.toDateString()
    ? formatTime(at, { hour: "numeric", minute: "2-digit" })
    : formatDateTime(at, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** The one line the mark says on rest: its most urgent section's. */
function restWords(section: Section): string {
  switch (section.kind) {
    case "stopped":
      return m.panelMarkStopped();
    case "failing":
      return m.panelMarkFailing({ time: sinceWords(section.failing[0]?.since ?? "") });
    case "asking":
      return m.panelMarkAsking({ place: section.asks[0]?.place ?? "" });
    case "paused":
      return m.panelMarkPaused();
    case "declined":
      return m.panelMarkDeclined({ place: section.asks[0]?.place ?? "" });
  }
}

/**
 * One small dot by a panel's name for what the host knows about it and its
 * code cannot say (design skill Panel.prompt.md, "The status mark"): its
 * background work stopped or paused, reads that keep failing, or an
 * integration call waiting on the captain or turned down. On rest it says
 * its most urgent line (docs/keyboard.md, "Facts shown on rest"); a press,
 * Enter or Space opens the details, each section with today's sentence and
 * its button, and Esc or a press outside closes them, focus back on the
 * mark. Drawn by the window, never by the panel's code, open or folded.
 */
export function PanelStatusMark({
  id,
  title,
  status,
  draft = false,
}: {
  id: string;
  title: string;
  status: PanelStatus;
  draft?: boolean;
}) {
  const sections = panelStatusSections(status);
  const first = sections[0];
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const popover = useRef<HTMLDivElement | null>(null);
  const drawn = usePopoverPresence(open && first !== undefined, popover, trigger);
  const words = first ? restWords(first) : undefined;
  const rest = useRestLabel(open ? undefined : words, { fact: true });

  const place = useCallback(() => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const height = popover.current?.offsetHeight ?? 0;
    const width = popover.current?.offsetWidth ?? WIDTH;
    const below = rect.bottom + GAP;
    const top =
      below + height <= window.innerHeight - EDGE ? below : Math.max(EDGE, rect.top - GAP - height);
    const left = Math.max(EDGE, Math.min(rect.left - EDGE, window.innerWidth - width - EDGE));
    setAnchor((prev) => (prev?.top === top && prev.left === left ? prev : { top, left }));
  }, []);

  const close = useCallback((giveBack: boolean) => {
    setOpen(false);
    if (giveBack) trigger.current?.focus();
  }, []);

  // Placed again once it has a size, before paint.
  const mountPopover = useCallback(
    (node: HTMLDivElement | null) => {
      popover.current = node;
      if (node) place();
    },
    [place],
  );

  // Focus lands on the first button once the details are placed: until then
  // they are drawn hidden, and a hidden button takes no focus.
  const focusedOpen = useRef(false);
  useLayoutEffect(() => {
    if (!open) {
      focusedOpen.current = false;
      return;
    }
    const node = popover.current;
    if (!anchor || !node || focusedOpen.current) return;
    focusedOpen.current = true;
    const button = node.querySelector<HTMLButtonElement>("button:not([disabled])");
    if (button) focusWithRing(button);
    else node.focus();
  }, [open, anchor]);

  useEffect(() => {
    if (!open) return;
    place();
    const inside = (target: Node) =>
      trigger.current?.contains(target) || popover.current?.contains(target);
    const onDown = (event: PointerEvent) => {
      if (!inside(event.target as Node)) close(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // The details own this Escape: the shell's own listener must not also see it.
      event.stopPropagation();
      close(true);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place, close]);

  // Nothing left to say closes the details.
  useEffect(() => {
    if (!first && open) setOpen(false);
  }, [first, open]);

  if (!first || !words) return null;
  const tone = TONE[first.kind];
  return (
    <>
      <button
        type="button"
        data-panel-status-mark={id}
        data-tone={tone}
        aria-label={words}
        aria-haspopup="dialog"
        aria-expanded={open}
        {...rest}
        ref={(node) => {
          trigger.current = node;
          rest.ref(node);
        }}
        // The header is the panel's handle: a press on the mark opens it and never picks the panel up.
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => setOpen((value) => !value)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: PRESS,
          height: PRESS,
          // The press area is wider than the dot: the header's gap alone sits between the name and the dot.
          marginInline: -(PRESS - 6) / 2,
          padding: 0,
          border: "none",
          borderRadius: "50%",
          background: "transparent",
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        <StatusDot tone={tone} label={words} nativeTitle={false} />
      </button>
      {drawn &&
        createPortal(
          <PanelStatusDetails
            ref={mountPopover}
            id={id}
            title={title}
            draft={draft}
            sections={sections}
            style={anchor ? { top: anchor.top, left: anchor.left } : { visibility: "hidden" }}
          />,
          document.body,
        )}
    </>
  );
}

/** The open details: each section's sentence and its button, most urgent first. */
function PanelStatusDetails({
  id,
  title,
  draft,
  sections,
  style,
  ref,
}: {
  id: string;
  title: string;
  draft: boolean;
  sections: readonly Section[];
  style: React.CSSProperties;
  ref: React.Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={m.panelMarkDetails({ title })}
      tabIndex={-1}
      data-panel-status-details={id}
      style={{
        position: "fixed",
        width: WIDTH,
        maxWidth: `calc(100vw - ${EDGE * 2}px)`,
        background: "var(--bg-2)",
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-m)",
        boxShadow: "var(--shadow-2)",
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 14,
        zIndex: 40,
        outline: "none",
        ...style,
      }}
    >
      {sections.map((section) => (
        <DetailsSection key={section.kind} id={id} draft={draft} section={section} />
      ))}
    </div>
  );
}

const lineStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
};

function DetailsSection({ id, draft, section }: { id: string; draft: boolean; section: Section }) {
  switch (section.kind) {
    case "stopped":
      return (
        <SectionRow kind="stopped">
          <p style={lineStyle}>
            {section.reason === "exited" ? m.panelBackgroundExited() : m.panelBackgroundStopped()}
          </p>
          <PressButton
            label={m.panelRetry()}
            press={() =>
              window.infinitary.plugins.personal.retry(id, draft ? { draft: true } : undefined)
            }
          />
        </SectionRow>
      );
    case "failing":
      return <FailingSection id={id} draft={draft} failing={section.failing} />;
    case "paused":
      return (
        <SectionRow kind="paused">
          <p style={lineStyle}>{m.panelBackgroundPaused()}</p>
          {!draft && (
            <PressButton
              label={m.panelBackgroundUpdate()}
              disabled={section.asked}
              press={() => window.infinitary.plugins.personal.update(id)}
            />
          )}
        </SectionRow>
      );
    case "asking":
    case "declined":
      return (
        <SectionRow kind={section.kind}>
          {section.asks.map((ask) => (
            <div
              key={`${ask.integration}/${ask.action}`}
              data-panel-integration-ask={`${ask.integration}/${ask.action}`}
              data-state={ask.state}
              style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}
            >
              <p style={lineStyle}>{integrationAskLine(ask.label, ask.place, ask.state)}</p>
              <PressButton
                label={m.panelIntegrationAskAgain()}
                press={() =>
                  window.infinitary.plugins.personal.askAgain(id, ask.integration, ask.action)
                }
              />
            </div>
          ))}
        </SectionRow>
      );
  }
}

function SectionRow({ kind, children }: { kind: Section["kind"]; children: React.ReactNode }) {
  return (
    <section
      data-panel-status-section={kind}
      style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}
    >
      {children}
    </section>
  );
}

/** One failing read's sentence: a place it reads from, or its own background job. */
function failingLine(row: PanelFailingRead): string {
  const time = sinceWords(row.since);
  return row.read.kind === "background"
    ? m.panelFailingJob({ job: row.read.task, time, count: row.tries })
    : m.panelFailingPlace({ place: row.read.place, time, count: row.tries });
}

function FailingSection({
  id,
  draft,
  failing,
}: {
  id: string;
  draft: boolean;
  failing: readonly PanelFailingRead[];
}) {
  const asked = failing.every((row) => row.asked);
  return (
    <SectionRow kind="failing">
      <p style={{ ...lineStyle, color: "var(--fg-1)", fontWeight: 500 }}>
        {m.panelFailingHeading()}
      </p>
      {failing.map((row) => (
        <div
          key={JSON.stringify(row.read)}
          data-panel-failing-read={row.read.kind}
          style={{ display: "flex", flexDirection: "column", gap: 6 }}
        >
          <p style={lineStyle}>
            {failingLine(row)} {m.panelFailingStillShows()}
          </p>
          {row.answer && (
            <blockquote
              data-panel-failing-answer=""
              style={{
                margin: 0,
                paddingInlineStart: 10,
                borderInlineStart: "2px solid var(--line-2)",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
                color: "var(--fg-2)",
                overflowWrap: "anywhere",
              }}
            >
              {row.answer}
            </blockquote>
          )}
        </div>
      ))}
      <p style={{ ...lineStyle, color: "var(--fg-3)" }}>{m.panelFailingClears()}</p>
      {!draft && (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <PressButton
            label={asked ? m.panelFailingAsked() : m.panelFailingAsk()}
            disabled={asked}
            press={() => window.infinitary.plugins.personal.askFirstmate(id)}
          />
          {asked && (
            <span data-panel-failing-asked="" style={{ ...lineStyle, color: "var(--fg-3)" }}>
              {m.panelFailingLooking()}
            </span>
          )}
        </div>
      )}
    </SectionRow>
  );
}

/** A section's button, off while its press is on its way. */
function PressButton({
  label,
  press,
  disabled = false,
}: {
  label: string;
  press: () => Promise<unknown>;
  disabled?: boolean;
}) {
  const [pressing, setPressing] = useState(false);
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={disabled || pressing}
      onClick={() => {
        setPressing(true);
        void press().finally(() => setPressing(false));
      }}
    >
      {label}
    </Button>
  );
}

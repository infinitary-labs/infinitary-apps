import {
  RISK_WORDS,
  type RiskAssessment,
  type RiskDimension,
  riskStep,
  riskTone,
} from "@shared/risk";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { RISK_CHART_GAP, type RiskRadarGeometry, radarPoint, riskRadarGeometry } from "./riskRadar";

/**
 * A merge card's risk chart (FI3-1127's plan, round 8; design skill
 * ResponseCard "The risk chart"): the radar the card's chrome draws at its
 * top right, level with the headline. Three faint rings and the axes in the
 * line tokens, the shape of the seven levels in the accent, and one dot per
 * dimension in its own level's color - the checks' calm cyan, ember and
 * lava. No word sums it up. Each dot is a target of its own: resting on it,
 * or the keyboard's focus, lights its label on the outer ring and opens its
 * note beside the chart - the dimension and its level in words, the
 * crewmate's line - and leaving, Esc or a scroll
 * of the body lets it go. The chart scrolls away with the body it sits
 * over, clipped at the headline's top; a dot the keyboard reaches brings it
 * back.
 */

/** How wide a note is, and how far it stands left of the chart. */
const NOTE_WIDTH = 236;
const NOTE_GAP = 10;
/** A dot's radius at rest and while it is the one read, and its target's. */
const DOT = 4;
const DOT_LIT = 6;
const TARGET = 10;
/** How far above the chart a note may rise: never into the head row. */
const NOTE_RISE = 8;

/** The chart's box, for the chrome that places it and the body that keeps clear of it. */
export function riskChartBox(): Pick<RiskRadarGeometry, "width" | "height"> {
  const { width, height } = riskRadarGeometry();
  return { width, height };
}

/**
 * From the headline's top to the body frame's top on a card whose headline
 * is one line: the line (20 px at the tight leading), the body's padding
 * above the frame and the frame's own inset.
 */
const ONE_LINE_HEADLINE_TO_BODY = 23 + 12 + 4;

/**
 * The box the body keeps clear before the chart is drawn - a body the stage
 * prepares, which has no chrome yet - as a one-line headline puts it. Once
 * the chart is drawn its measured box takes over (`HtmlCardBody`'s inset).
 */
export function riskBodyInset(): { width: number; height: number } {
  const { width, height } = riskChartBox();
  return { width: width + RISK_CHART_GAP, height: height - ONE_LINE_HEADLINE_TO_BODY };
}

/** The card's own body scroller the chart sits over. */
function bodyScrollerOf(element: HTMLElement | null): HTMLElement | null {
  return (
    element?.closest("[data-response-card]")?.querySelector<HTMLElement>("[data-card-body]") ?? null
  );
}

export function RiskChart({ risk }: { risk: RiskAssessment }) {
  const geometry = useMemo(() => riskRadarGeometry(), []);
  const [active, setActive] = useState<RiskDimension | null>(null);
  const [noteTop, setNoteTop] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const movingRef = useRef<HTMLDivElement>(null);
  /** The body is scrolling back for a dot the keyboard reached: its note stays. */
  const returningRef = useRef(false);
  const noteRef = useRef<HTMLDivElement>(null);
  const noteId = useId();
  const { cx, cy, radius, axes, width, height } = geometry;
  const points = axes.map((axis) => ({
    ...axis,
    level: risk.declared[axis.dimension].level,
    at: radarPoint(
      { cx, cy },
      (radius * riskStep(risk.declared[axis.dimension].level)) / 3,
      axis.angle,
    ),
  }));

  // The chart moves with the body under it, and a scroll lets a note go.
  useEffect(() => {
    const scroller = bodyScrollerOf(rootRef.current);
    const moving = movingRef.current;
    if (!scroller || !moving) return;
    const follow = () => {
      moving.style.transform = scroller.scrollTop ? `translateY(${-scroller.scrollTop}px)` : "";
      if (returningRef.current) returningRef.current = false;
      else setActive(null);
    };
    follow();
    scroller.addEventListener("scroll", follow, { passive: true });
    return () => scroller.removeEventListener("scroll", follow);
  }, []);

  // A note stands level with its dot, never rising into the head row.
  const lit = points.find((point) => point.dimension === active);
  const litY = lit?.at[1];
  useLayoutEffect(() => {
    if (litY === undefined || !noteRef.current) return;
    setNoteTop(Math.max(-NOTE_RISE, Math.round(litY - noteRef.current.offsetHeight / 2)));
  }, [litY]);

  const shape = points.map((point) => point.at.join(",")).join(" ");
  const ring = (step: number) =>
    axes.map((axis) => radarPoint({ cx, cy }, (radius * step) / 3, axis.angle).join(",")).join(" ");

  return (
    <div
      ref={rootRef}
      data-risk-chart=""
      style={{ position: "relative", width, height, pointerEvents: "none" }}
    >
      <div style={{ position: "absolute", inset: 0, overflow: "clip" }}>
        <div ref={movingRef} style={{ position: "absolute", inset: 0 }}>
          <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            aria-hidden="true"
            style={{ display: "block", overflow: "visible" }}
          >
            {[1, 2, 3].map((step) => (
              <polygon
                key={step}
                points={ring(step)}
                fill="none"
                style={{ stroke: "var(--line-1)" }}
              />
            ))}
            {axes.map((axis) => {
              const [x, y] = radarPoint({ cx, cy }, radius, axis.angle);
              return (
                <line
                  key={axis.dimension}
                  x1={cx}
                  y1={cy}
                  x2={x}
                  y2={y}
                  style={{ stroke: "var(--line-1)" }}
                />
              );
            })}
            <polygon
              points={shape}
              strokeWidth={1.25}
              strokeLinejoin="round"
              style={{ fill: "var(--accent-dim)", stroke: "var(--accent)" }}
            />
            {axes.map((axis) => (
              <text
                key={axis.dimension}
                data-risk-axis={axis.dimension}
                data-lit={active === axis.dimension ? "" : undefined}
                x={axis.label.x}
                y={axis.label.y}
                textAnchor={axis.label.anchor}
                style={{
                  fill: "var(--fg-1)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-xs)",
                  opacity: active === axis.dimension ? 1 : 0,
                }}
              >
                {RISK_WORDS[axis.dimension].label}
              </text>
            ))}
            {points.map((point) => (
              <circle
                key={point.dimension}
                cx={point.at[0]}
                cy={point.at[1]}
                r={active === point.dimension ? DOT_LIT : DOT}
                strokeWidth={1.5}
                style={{ fill: `var(--${riskTone(point.level)})`, stroke: "var(--bg-2)" }}
              />
            ))}
          </svg>
          {points.map((point) => {
            const words = RISK_WORDS[point.dimension];
            return (
              <button
                key={point.dimension}
                type="button"
                data-risk-dot={point.dimension}
                data-risk-level={point.level}
                aria-label={`${words.label}: ${words.levels[point.level]}`}
                aria-describedby={active === point.dimension ? noteId : undefined}
                onPointerEnter={() => setActive(point.dimension)}
                onPointerLeave={() =>
                  setActive((shown) => (shown === point.dimension ? null : shown))
                }
                onFocus={() => {
                  // The keyboard reaching a dot brings the chart back in view.
                  const scroller = bodyScrollerOf(rootRef.current);
                  if (scroller?.scrollTop) {
                    returningRef.current = true;
                    scroller.scrollTop = 0;
                  }
                  setActive(point.dimension);
                }}
                onBlur={() => setActive((shown) => (shown === point.dimension ? null : shown))}
                onKeyDown={(event) => {
                  // Esc lets the note go, and nothing under it.
                  if (event.key !== "Escape" || active !== point.dimension) return;
                  event.preventDefault();
                  event.stopPropagation();
                  setActive(null);
                }}
                style={{
                  position: "absolute",
                  left: point.at[0] - TARGET,
                  top: point.at[1] - TARGET,
                  width: TARGET * 2,
                  height: TARGET * 2,
                  padding: 0,
                  border: 0,
                  borderRadius: "50%",
                  background: "transparent",
                  cursor: "default",
                  pointerEvents: "auto",
                }}
              />
            );
          })}
        </div>
      </div>
      {lit && (
        <div
          ref={noteRef}
          id={noteId}
          role="tooltip"
          data-risk-note={lit.dimension}
          style={{
            position: "absolute",
            top: noteTop,
            left: -(NOTE_WIDTH + NOTE_GAP),
            width: NOTE_WIDTH,
            boxSizing: "border-box",
            padding: "var(--space-2) var(--space-3)",
            background: "var(--bg-2)",
            border: "1px solid var(--line-1)",
            borderRadius: "var(--radius-m)",
            boxShadow: "var(--shadow-2)",
            fontSize: "var(--text-sm)",
            lineHeight: 1.35,
            color: "var(--fg-2)",
            textAlign: "start",
            whiteSpace: "normal",
            letterSpacing: "normal",
            fontWeight: 400,
          }}
        >
          <div style={{ color: "var(--fg-1)" }}>
            <span style={{ fontWeight: 500 }}>{RISK_WORDS[lit.dimension].label}</span> ·{" "}
            {RISK_WORDS[lit.dimension].levels[lit.level]}
          </div>
          <div data-risk-why="" style={{ marginTop: "var(--space-2)" }}>
            {risk.declared[lit.dimension].why}
          </div>
        </div>
      )}
    </div>
  );
}

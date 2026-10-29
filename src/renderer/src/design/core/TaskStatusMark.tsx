import { type TaskStatusReading, taskStatusLabel } from "@shared/taskPresentation";

/**
 * One lifecycle shape at every density, independent of the stage's crew geometry.
 * The SVG title is the standalone symbol's tooltip. A caller that already shows
 * the same status passes `nativeTitle={false}` and keeps the accessible name.
 */
export function TaskStatusMark({
  reading,
  nativeTitle = true,
}: {
  reading: TaskStatusReading;
  nativeTitle?: boolean;
}) {
  const { mark } = reading;
  // Working on a background wait, as the stage draws it (INF-676, INF-1777):
  // a dot in a dashed accent ring, so it never reads as Waiting on you's full
  // ring; the dot is the accent for checks, ember for local work. Out of
  // reach keeps the warn shape.
  const wait = reading.outOfReach ? undefined : reading.wait;
  // Its computer is out of reach: the same shape, in warn (docs/helper.md).
  const color = reading.outOfReach
    ? "var(--warn)"
    : wait === "checks"
      ? "var(--accent)"
      : mark === "working"
        ? "var(--warn)"
        : mark === "starting"
          ? "var(--accent)"
          : mark === "idle"
            ? "var(--ok)"
            : mark === "interrupted"
              ? "var(--danger)"
              : mark === "waiting"
                ? "var(--accent)"
                : mark === "dropped"
                  ? "var(--fg-3)"
                  : "var(--fg-2)";
  return (
    <svg
      data-task-mark={mark}
      data-task-out-of-reach={reading.outOfReach ? "" : undefined}
      data-task-wait={wait}
      width="12"
      height="12"
      viewBox="0 0 16 16"
      role="img"
      aria-label={taskStatusLabel(reading)}
      style={{ color, flexShrink: 0, verticalAlign: "middle" }}
    >
      {nativeTitle ? <title>{taskStatusLabel(reading)}</title> : null}
      {mark === "done" ? (
        <path
          d="M2 8 6 12 14 3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : mark === "dropped" ? (
        <path
          d="M3 3 13 13 M13 3 3 13"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      ) : (
        <>
          {mark === "starting" ? (
            <>
              <circle cx="8" cy="8" r="5" fill="none" stroke="var(--line-2)" strokeWidth="1.5" />
              <path d="M8 3a5 5 0 1 1-5 5" fill="none" stroke="var(--accent)" strokeWidth="1.5" />
            </>
          ) : wait ? (
            <>
              <circle
                cx="8"
                cy="8"
                r="6"
                fill="none"
                stroke="var(--accent)"
                strokeWidth="1.2"
                strokeDasharray="2.6 2.1"
              />
              <circle cx="8" cy="8" r="3" fill="currentColor" />
            </>
          ) : (
            <circle
              cx="8"
              cy="8"
              r="6"
              fill={["working", "idle", "interrupted"].includes(mark) ? "currentColor" : "none"}
              stroke="currentColor"
              strokeWidth="1.2"
            />
          )}
          {(mark === "queued" || mark === "waiting") && (
            <circle cx="8" cy="8" r={mark === "waiting" ? "3" : "2"} fill="currentColor" />
          )}
        </>
      )}
    </svg>
  );
}

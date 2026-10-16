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
  // Its computer is out of reach: the same shape, in warn (docs/helper.md).
  const color = reading.outOfReach
    ? "var(--warn)"
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

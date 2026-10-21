import { type TaskStatusInput, taskStatusLabel, taskStatusOf } from "@shared/taskPresentation";
import type { TaskView } from "@shared/tasks";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RecordPaneChrome } from "../../cards/RecordPaneChrome";
import { CrewSummary } from "../../character/crew/CrewSummary";
import { TaskStatusMark } from "./TaskStatusMark";

const base: TaskStatusInput = {
  status: "open",
  activity: null,
  closedReason: null,
  startPolicy: "on-request",
  flags: { blocked: false, held: false, needsYou: false, ready: true },
  waitingCardId: null,
  children: { total: 0, closed: 0 },
};
/** The rest of a board row, which the summary reads beside its status. */
const view = {
  id: "example",
  key: "DEMO-1",
  title: "Example task",
  kind: "work",
  model: null,
  tier: null,
  delivery: null,
};
const examples: Partial<TaskStatusInput>[] = [
  {},
  { startPolicy: "when-ready" },
  { startPolicy: "when-ready", flags: { ...base.flags, held: true } },
  { children: { total: 2, closed: 0 } },
  { status: "active", activity: "running" },
  { status: "active", activity: "idle", workPosture: { state: "active", reason: "checks" } },
  { status: "active", activity: "idle" },
  { status: "active", activity: "interrupted" },
  { captainWait: true },
  { status: "done" },
  { status: "dropped", closedReason: "failed" },
];

describe("the shared task mark", () => {
  it.each(examples)(
    "carries the same shape and accessible reading through row, summary and record for %j",
    (example) => {
      const reading = taskStatusOf({ ...base, ...example });
      const row = renderToStaticMarkup(<TaskStatusMark reading={reading} />);
      const record = renderToStaticMarkup(
        <RecordPaneChrome
          reading={reading}
          pillTone="neutral"
          taskKey="DEMO-1"
          title="Example task"
          onClose={() => {}}
        />,
      );
      const summary = renderToStaticMarkup(
        <CrewSummary
          taskId="example"
          facts={{
            task: { ...view, ...base, ...example } as TaskView,
            modelName: (model) => model,
          }}
        />,
      );
      expect(row).toContain(`<title>${taskStatusLabel(reading)}</title>`);
      for (const surface of [record, summary]) {
        expect(surface).toContain(`data-task-mark="${reading.mark}"`);
        expect(surface).toContain(`aria-label="${taskStatusLabel(reading)}"`);
        expect(surface).not.toContain(`<title>${taskStatusLabel(reading)}</title>`);
        expect(surface).toContain(reading.word);
        if (reading.reason) expect(surface).toContain(reading.reason);
      }
    },
  );
  // INF-676, the captain's direction A: the checks watch is Working drawn as
  // an ember dot inside the accent ring, the fact strip's running-checks mark.
  it("draws the checks watch as an ember dot in the accent ring, and a turn as the filled dot", () => {
    const checks = renderToStaticMarkup(
      <TaskStatusMark
        reading={taskStatusOf({
          ...base,
          status: "active",
          activity: "idle",
          workPosture: { state: "active", reason: "checks" },
        })}
      />,
    );
    const turn = renderToStaticMarkup(
      <TaskStatusMark
        reading={taskStatusOf({
          ...base,
          status: "active",
          activity: "running",
          workPosture: { state: "active", reason: "turn" },
        })}
      />,
    );
    expect(checks).toContain('data-task-mark="working"');
    expect(checks).toContain('data-task-wait="checks"');
    expect(checks).toContain('aria-label="Working · Waiting for checks"');
    expect(checks).toContain('r="6" fill="none" stroke="var(--accent)"');
    expect(checks).toContain('r="3" fill="currentColor"');
    expect(turn).not.toContain("data-task-wait");
    expect(turn).toContain('r="6" fill="currentColor"');
  });
  it("makes closed lifecycle visibly different from the backlog, even without color", () => {
    const backlog = renderToStaticMarkup(<TaskStatusMark reading={taskStatusOf(base)} />);
    const done = renderToStaticMarkup(
      <TaskStatusMark reading={taskStatusOf({ ...base, status: "done" })} />,
    );
    const dropped = renderToStaticMarkup(
      <TaskStatusMark reading={taskStatusOf({ ...base, status: "dropped" })} />,
    );
    expect(backlog).toContain("<circle");
    expect(done).toContain('d="M2 8 6 12 14 3"');
    expect(dropped).toContain('d="M3 3 13 13 M13 3 3 13"');
  });
});

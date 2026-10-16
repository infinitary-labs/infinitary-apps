import { taskStatusLabel } from "@shared/taskPresentation";
import { TaskFactRows } from "../../design/core/TaskFacts";
import { TaskStatusMark } from "../../design/core/TaskStatusMark";
import { TaskKey } from "../../design/panel/TaskKey";
import { openTaskFromKey } from "../../plugins/point/openTask";
import { type CrewFacts, useBoardTasks, useCrewRecord, useProjectName } from "./useCrewBoard";
import "./summary.css";

/**
 * What a crewmate is and what it is doing (FI3-398, laid out again in
 * FI3-427 and FI3-439): its key and state now, then the shared task facts
 * (FI3-565 piece 2) - its task, and the newest row of its record's Activity
 * with that row's age, each beside its label; under a hairline, a readout of
 * its model, the intelligence level it is served on and the reasoning its
 * session opened at, with the footnote saying why; then its change and
 * checks. Key, title, state, model, level and change come from the board
 * and paint at once; once the record answers, the whole projection is the
 * record's, the same one its task record shows, and it stays live while
 * the summary is open. Read-only: the record a click opens has the full
 * text of a note cut short here. The status, the task title and the project
 * wrap in full. How it comes and goes is its holder's (./summaryMotion.ts).
 */
export function CrewSummary({ taskId, facts }: { taskId: string; facts: CrewFacts }) {
  const shown = useCrewRecord(taskId, facts);
  // Where another computer runs it, after the project, as its Tasks row says it.
  const project = [useProjectName(facts.task.projectId), facts.task.place?.where]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="fm-crew-summary" data-crew-summary={taskId} role="status">
      <div className="head">
        <span className="key" data-crew-summary-key="">
          {shown.key}
        </span>
        <TaskStatusMark reading={shown.status} nativeTitle={false} />
        <span className="state" data-task-fact="status">
          {taskStatusLabel(shown.status)}
        </span>
      </div>
      {(facts.task.blockedBy?.length ?? 0) > 0 && <BlockedBy keys={facts.task.blockedBy} />}
      <TaskFactRows
        facts={shown}
        withTask
        project={project}
        // A closed task's plan is the record's to keep; the summary draws none.
        planView={
          shown.status.mark === "done" || shown.status.mark === "dropped" ? undefined : "dots"
        }
      />
    </div>
  );
}

/** Named record links for a wait an edge cannot draw, and the complete list. */
function BlockedBy({ keys }: { keys: readonly string[] }) {
  const tasks = useBoardTasks();
  return (
    <div className="blocked" data-crew-blocked="">
      <span className="label">Blocked by</span>
      {keys.map((key) => {
        const task = tasks.find((row) => row.key === key);
        return task ? (
          <TaskKey
            key={key}
            look="quiet"
            onRest={() => {}}
            onOpen={() => void openTaskFromKey(task)}
          >
            {key}
          </TaskKey>
        ) : (
          <span key={key} className="key" data-crew-blocked-key="">
            {key}
          </span>
        );
      })}
    </div>
  );
}

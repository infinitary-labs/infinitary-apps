import { taskStatusLabel } from "@shared/taskPresentation";
import { TaskFactRows } from "../../design/core/TaskFacts";
import { TaskStatusMark } from "../../design/core/TaskStatusMark";
import { TaskKey } from "../../design/panel/TaskKey";
import { openTaskFromKey } from "../../plugins/point/openTask";
import { programProgress } from "./constellation";
import { partsCountWords } from "./programWords";
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
      {facts.task.reviewOf && <Reviewing builderId={facts.task.reviewOf} />}
      {facts.task.parentId && <PartOf parentId={facts.task.parentId} />}
      {(facts.task.blockedBy?.length ?? 0) > 0 && <BlockedBy keys={facts.task.blockedBy} />}
      {facts.task.program && <ProgramParts programId={taskId} />}
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

/** The task a reviewer is reading, named whether or not the stage can draw its circle. */
function Reviewing({ builderId }: { builderId: string }) {
  const builder = useBoardTasks().find((row) => row.id === builderId);
  return (
    <div className="blocked" data-crew-reviewing="">
      <span className="label">Reviewing</span>
      {builder ? (
        <TaskKey look="quiet" onRest={() => {}} onOpen={() => void openTaskFromKey(builder)}>
          {builder.key}
        </TaskKey>
      ) : (
        <span className="key" data-crew-reviewing-key="">
          another task
        </span>
      )}
    </div>
  );
}

/**
 * The program a part belongs to, so a part seated in a constellation is
 * named as the part it is (INF-999). Only a program the host runs draws one.
 */
function PartOf({ parentId }: { parentId: string }) {
  const program = useBoardTasks().find((row) => row.id === parentId && row.program);
  if (!program) return null;
  return (
    <div className="blocked" data-crew-part-of="">
      <span className="label">Part of</span>
      <TaskKey look="quiet" onRest={() => {}} onOpen={() => void openTaskFromKey(program)}>
        {program.key}
      </TaskKey>
    </div>
  );
}

/**
 * How far a program has got, on its ring's summary (INF-1037): the stage
 * draws only its running parts, so the ring counts every part by state,
 * shows the share of each on one bar, and names each running part by its
 * key with the computer it runs on, as a Tasks row says it.
 */
function ProgramParts({ programId }: { programId: string }) {
  const { finished, running, waiting } = programProgress(useBoardTasks(), programId);
  const total = finished + running.length + waiting;
  if (total === 0) return null;
  const counts = partsCountWords(finished, running.length, waiting);
  return (
    <div className="fm-task-facts parts" data-crew-program-parts="">
      <div className="row">
        <div className="label" data-task-fact-label="">
          Parts
        </div>
        <div data-crew-parts-count="">{counts}</div>
      </div>
      <div className="parts-bar" aria-hidden="true">
        {finished > 0 && <i data-part="finished" style={{ flexGrow: finished }} />}
        {running.length > 0 && <i data-part="running" style={{ flexGrow: running.length }} />}
        {waiting > 0 && <i data-part="waiting" style={{ flexGrow: waiting }} />}
      </div>
      {running.length > 0 && (
        <div className="row">
          <div className="label" data-task-fact-label="">
            Running
          </div>
          <div className="running" data-crew-program-running="">
            {running.map((part) => (
              <span key={part.id} className="part">
                <TaskKey look="quiet" onRest={() => {}} onOpen={() => void openTaskFromKey(part)}>
                  {part.key}
                </TaskKey>
                {part.place?.where && <span className="where"> {part.place.where}</span>}
              </span>
            ))}
          </div>
        </div>
      )}
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

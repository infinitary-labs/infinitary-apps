import type { PanelFeedLine } from "@shared/personal/contracts";
import { waitRecordedTime } from "@shared/taskPresentation";
import type { TaskView } from "@shared/tasks";
import { useProjectName } from "../../character/crew/useCrewBoard";
import "../../character/crew/summary.css";
import "../../design/core/taskFacts.css";
import "./lineSummary.css";

/** The approved Activity line summary (INF-1761): recorded words, not a second task summary. */
export function LineSummary({ line, task }: { line: PanelFeedLine; task: TaskView | undefined }) {
  const project = useProjectName(task?.projectId);
  return (
    <div className="fm-crew-summary fm-line-summary" role="status">
      <div className="head">
        {line.taskKey && <span className="key">{line.taskKey}</span>}
        <i className="line-dot" data-line-kind={line.kind} aria-hidden="true" />
        <time dateTime={new Date(line.at).toISOString()}>
          {waitRecordedTime(line.at, Date.now())}
        </time>
      </div>
      <div className="line-words" data-line-summary-text="">
        {line.text}
      </div>
      {task && (
        <div className="fm-task-facts line-facts">
          <div className="row">
            <span className="label">Task</span>
            <span className="title" data-task-fact="task">
              {task.title}
            </span>
          </div>
          {project && (
            <div className="row">
              <span className="label">Project</span>
              <span data-task-fact="project">{project}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

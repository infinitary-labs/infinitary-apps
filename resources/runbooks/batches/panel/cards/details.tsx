import type { PanelBatchRepo, PanelBatchTask, PanelProps, PanelTaskRow } from "@infinitary/contracts";
import { Button, focusWithRing, StatusDot, useMinute } from "@infinitary/ui";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
import * as m from "../messages.generated";
import styles from "../panel.css";
import {
  batchTitle,
  clock,
  holdOf,
  holdSentence,
  showsAny,
  stateFull,
  taskName,
  toneOf,
  took,
  waitFull,
} from "../words";

/**
 * The Batches panel's details card (docs/forge.md, "The Batches panel"): the
 * panel's groups in full words - the open batch with its state, checks and
 * every member, each change waiting and why, each change left out and why -
 * and a table of the batches that ended in the last day. Like the panel it
 * only points: a task opens its task, Open in Settings opens the held
 * batch in Settings → Projects, which it offers for every hold, even while a
 * repair has it. The tasks are one Tab stop with the arrows
 * inside, and Enter opens one.
 */
export default function BatchesDetails({ reads, point, view }: PanelProps) {
  const [repos, setRepos] = useState<PanelBatchRepo[] | null>(null);
  const [stop, setStop] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useMinute();

  const [rows, setRows] = useState<PanelTaskRow[] | null>(null);

  useEffect(() => reads.subscribe("batches.list", (value) => setRepos(value.repos)), [reads]);
  useEffect(
    () => reads.subscribe("tasks.board", { closed: false }, (value) => setRows(value.tasks)),
    [reads],
  );

  const focused = view.focusedProjectId;
  const shown = (repos ?? []).filter(
    (repo) => showsAny(repo) && (focused === null || repo.projectId === focused),
  );

  const stops: string[] = [];
  for (const repo of shown) {
    for (const member of repo.open?.members ?? []) stops.push(`member:${member.taskId}`);
    for (const change of repo.line) stops.push(`line:${change.taskId}`);
    for (const entry of repo.leftOut) stops.push(`left:${entry.taskId}`);
  }
  const current = stops.includes(stop ?? "") ? stop : (stops[0] ?? null);
  function onKey(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const at = stops.indexOf(current ?? "");
    const next =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? Math.min(stops.length - 1, at + 1)
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? Math.max(0, at - 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? stops.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    const id = stops[next];
    if (!id) return;
    setStop(id);
    const target = rootRef.current?.querySelector<HTMLElement>(
      `[data-batches-stop="${CSS.escape(id)}"]`,
    );
    if (target) focusWithRing(target);
  }
  const taskButton = (id: string, task: PanelBatchTask) => (
    <button
      type="button"
      className="fm-batches-panel-chip"
      data-batches-stop={id}
      title={task.title}
      tabIndex={id === current ? 0 : -1}
      onFocus={() => setStop(id)}
      onKeyDown={onKey}
      onClick={() => void point.openTask(task.taskId).catch(() => false)}
    >
      {taskName(task)}
    </button>
  );

  if (repos !== null && shown.length === 0)
    return (
      <div className="fm-batches-details">
        <style>{styles}</style>
        <p className="fm-batches-details-said">{m.batchesPanelEmpty()}</p>
      </div>
    );

  return (
    <div ref={rootRef} className="fm-batches-details" data-batches-details="">
      <style>{styles}</style>
      {shown.map((repo) => (
        <section key={repo.repoId} className="fm-batches-details-repo" aria-label={repo.name}>
          {shown.length > 1 && <h2 className="fm-batches-details-repo-name">{repo.name}</h2>}
          {repo.open && (
            <div className="fm-batches-details-group" data-batches-details-open="">
              <h3>
                <StatusDot tone={toneOf(repo.open, holdOf(repo.open, rows))} label={stateFull(repo.open)} />{" "}
                {batchTitle(repo.open.number, repo.open.members.length)}
              </h3>
              <p>{stateFull(repo.open)}</p>
              {(() => {
                const hold = holdOf(repo.open, rows);
                return hold ? <p data-batches-details-who={hold}>{holdSentence(repo.open, hold)}</p> : null;
              })()}
              {repo.open.checks && (
                <p className="fm-batches-details-mono">
                  {m.batchesPanelChecksFull({
                    passed: String(repo.open.checks.passed),
                    failed: String(repo.open.checks.failed),
                    running: String(repo.open.checks.running),
                    time: clock(repo.open.checks.at),
                  })}
                </p>
              )}
              {repo.open.hold && repo.open.hold.checks.length > 0 && (
                <p>{m.batchesPanelFailedNames({ names: repo.open.hold.checks.join(", ") })}</p>
              )}
              {repo.open.fixKeys.length > 0 && (
                <p>{m.batchesPanelFix({ keys: repo.open.fixKeys.join(", ") })}</p>
              )}
              {repo.open.hold && (
                <Button
                  size="sm"
                  onClick={() =>
                    void point.openSettings("projects", `batch:${repo.repoId}`).catch(() => false)
                  }
                >
                  {m.batchesPanelOpenSettings()}
                </Button>
              )}
              <ul className="fm-batches-details-tasks" aria-label={m.batchesPanelMembersLabel()}>
                {repo.open.members.map((member) => (
                  <li key={member.taskId}>
                    {taskButton(`member:${member.taskId}`, member)}
                    <span>{member.title}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {repo.line.length > 0 && (
            <div className="fm-batches-details-group" data-batches-details-line="">
              <h3>{m.batchesPanelWaiting({ count: repo.line.length })}</h3>
              <ul className="fm-batches-details-tasks">
                {repo.line.map((change) => (
                  <li key={change.taskId}>
                    {taskButton(`line:${change.taskId}`, change)}
                    <span>{change.title}</span>
                    <span className="fm-batches-details-why">{waitFull(repo, change)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {repo.leftOut.length > 0 && (
            <div className="fm-batches-details-group" data-batches-details-left-out="">
              <h3>{m.batchesPanelLeftOutCount({ count: repo.leftOut.length })}</h3>
              <ul className="fm-batches-details-tasks">
                {repo.leftOut.map((entry) => (
                  <li key={entry.taskId}>
                    {taskButton(`left:${entry.taskId}`, entry)}
                    <span>{entry.title}</span>
                    <span className="fm-batches-details-why">
                      {entry.aheadKey
                        ? m.batchesPanelLeftOutAhead({ reason: entry.reason, key: entry.aheadKey })
                        : entry.reason}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {repo.finished.length > 0 && (
            <div className="fm-batches-details-group" data-batches-details-last-day="">
              <h3>{m.batchesPanelLastDay()}</h3>
              <table className="fm-batches-details-table">
                <thead>
                  <tr>
                    <th scope="col">{m.batchesPanelColumnBatch()}</th>
                    <th scope="col">{m.batchesPanelColumnChanges()}</th>
                    <th scope="col">{m.batchesPanelColumnFormed()}</th>
                    <th scope="col">{m.batchesPanelColumnEnded()}</th>
                    <th scope="col">{m.batchesPanelColumnTook()}</th>
                    <th scope="col">{m.batchesPanelColumnHeld()}</th>
                  </tr>
                </thead>
                <tbody>
                  {repo.finished.map((batch) => (
                    <tr key={batch.number} data-batches-finished-row={batch.number}>
                      <td>
                        {batch.outcome === "merged"
                          ? m.batchesPanelMergedNumber({ number: String(batch.number) })
                          : m.batchesPanelClosedNumber({ number: String(batch.number) })}
                      </td>
                      <td>{batch.members.map(taskName).join(", ")}</td>
                      <td>{clock(batch.formed)}</td>
                      <td>{clock(batch.ended)}</td>
                      <td>{took(batch.ended - batch.formed)}</td>
                      <td>{batch.holds}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
